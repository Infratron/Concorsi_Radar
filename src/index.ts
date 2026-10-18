import type { Env } from "./types.ts";
import { chatAccess, missingBindings, type ChatAccess } from "./config/env.ts";
import { createD1Store } from "./db/d1.ts";
import { expireOldItems, resolveSource, runIngest, type IngestSummary } from "./pipeline.ts";
import type { TelegramUpdate } from "./telegram/api.ts";
import { TelegramClient } from "./telegram/api.ts";
import { handleUpdate } from "./telegram/bot.ts";
import { sendCollectionReminder, sendDigests, sendGiroReminders, sendInstantAlerts, sendWatchlistReminders } from "./telegram/digest.ts";
import { ingestLog } from "./telegram/report.ts";
import { COLLECTION_REMINDER_MARK, COLLECTION_REMINDER_SKIP, jobFor, shouldFallbackIngest } from "./schedule.ts";
import { USER_AGENT } from "./config/sources.ts";
import { benchDedupeLookup, benchSource, downloadBodies, summarise } from "./debug/bench.ts";
import { htmlResponse, jsonResponse } from "./lib/http.ts";
import { isShareableUrl, renderSharePage } from "./share.ts";
import { dispatchIfSilent } from "./collect/dispatch.ts";
import { urlKey } from "./lib/text.ts";
import { sharePhrase } from "./telegram/keyboard.ts";

/**
 * Quante fonti prova la raccolta di riserva in un tick. Il tetto vero resta il
 * budget di CPU (6 ms sul piano Free): questo è solo il numero che entra nella
 * coda, e le fonti che non ci stanno vengono riprese dal tick successivo.
 */
const FALLBACK_MAX_SOURCES = 12;
/**
 * Quanto si tengono le esecuzioni: le schermate ne leggono al massimo 50 (circa
 * dodici ore), quindi trenta giorni bastano per qualunque indagine a mano.
 */
const RUNS_KEEP_MS = 30 * 86_400_000;
/** Gli update_id servono solo contro i retry di Telegram, che durano ore. */
const UPDATES_KEEP_MS = 3 * 86_400_000;

/**
 * Entry point del Worker.
 *  - POST /telegram  → webhook (protetto dall'header segreto di Telegram)
 *  - GET  /setup     → registra webhook e menu comandi (protetto dal secret)
 *  - GET  /health    → stato di esecuzioni e fonti (protetto dal secret)
 *  - scheduled()     → digest (solo se acceso) oppure avvisi e pulizia, in base al cron
 *
 * La raccolta dei feed non gira più qui: la rete di Cloudflare viene bloccata da
 * diverse fonti italiane (403/503), quindi la fa GitHub Actions con la stessa
 * pipeline (scripts/ingest.ts). Il Worker legge lo stesso database D1 e, se la
 * raccolta su Actions tace da troppo tempo, la sostituisce con quel poco che la
 * sua rete raggiunge (vedi shouldFallbackIngest in src/schedule.ts).
 */

/** Confronto a tempo costante per i secret. */
function safeEqual(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Le rotte di servizio (/setup, /health, /bench) vogliono il secret nell'header
 * `Authorization: Bearer …`, non più in `?secret=`. Un secret nell'URL finisce
 * nei log delle richieste (observability è accesa), nella cronologia del browser
 * e nella shell: ed è lo stesso secret che firma il webhook, quindi chi lo legge
 * può spedire al bot update finti a nome di una chat autorizzata.
 */
function isAuthorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] ?? null;
  return safeEqual(token, env.WEBHOOK_SECRET);
}

async function runCron(env: Env, cron: string, now: Date): Promise<void> {
  const store = createD1Store(env.DB);
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, (input, init) => fetch(input, init));
  const access: ChatAccess = chatAccess(env);
  const adminChatId = access.adminChatId;
  const started = Date.now();
  const deps = { store, fetcher: (input: string, init?: RequestInit) => fetch(input, init), ai: env.AI };

  // Le ore di digest valgono per tutti gli autorizzati: basta che una combaci.
  // Una chat senza preferenze non ne ha nessuna accesa: il digest è spento di
  // default, non un orologio che parte da solo.
  const digestHours = new Set<number>();
  for (const chatId of access.allowed) {
    const prefs = await store.getPrefs(chatId);
    for (const hour of prefs?.digestHours ?? []) digestHours.add(hour);
  }

  if (jobFor(cron, now, [...digestHours]) === "digest") {
    const result = await sendDigests({ store, tg, now });
    await store.recordRun({
      startedAt: now.toISOString(), trigger: cron, sourcesOk: 0, sourcesFail: 0,
      itemsNew: result.messages, ms: Date.now() - started,
      note: `digest: ${result.chats} chat, ${result.messages} messaggi`,
      // Un digest non è una raccolta: niente log, e fuori da 🧾 Log delle raccolte.
      log: null,
    });
    return;
  }

  // Tick dei 15 minuti: di norma non scarica nulla (lo fa la raccolta su Actions,
  // con tutte le fonti). Serve a consegnare subito ciò che la raccolta ha appena
  // trovato e a mettere via i concorsi scaduti.
  const note: string[] = [];
  let sourcesOk = 0;
  let sourcesFail = 0;
  let itemsNew = 0;
  let skipInstant = false;
  // Le ultime esecuzioni servono a due cose: capire se la raccolta su Actions
  // tace (raccolta di riserva) e se vale la pena ricordarlo all'admin. Una sola
  // lettura per entrambe — 50 righe coprono circa dodici ore di tick da 15 minuti.
  const runs = await store.recentRuns(50);
  let fallback: { ok: number; due: number } | null = null;
  // Il log di questo tick: lo scrive solo la raccolta di riserva, che è l'unica
  // cosa che qui raccoglie davvero. Un tick che si limita a consegnare e a
  // mettere via i scaduti non ha nulla da raccontare fonte per fonte, e senza log
  // non compare in 🧾 Log delle raccolte (vedi recentLogs nello store).
  let log: string | null = null;

  // Prima la sveglia, poi la raccolta di riserva: se GitHub si è solo addormentato,
  // basta chiedergli di partire, e la raccolta torna dalla rete che le fonti
  // lasciano passare. La riserva resta per quando anche la sveglia non risponde
  // (token scaduto, workflow disattivato): sono due guasti diversi.
  const sveglia = await dispatchIfSilent({
    env,
    runs,
    now,
    fetcher: (input: string, init?: RequestInit) => fetch(input, init),
  });
  if (sveglia !== null) note.push(sveglia);

  if (shouldFallbackIngest(runs, now)) {
    // Raccolta di riserva FORTE: prima prendeva le quattro fonti dello slot di
    // questo quarto d'ora, e con un silenzio di ore la stessa fonte tornava ogni
    // due ore e mezza mentre le altre restavano invisibili. Ora prende le più
    // trascurate fra TUTTE quelle abilitate (`allSources`), fino a dodici per
    // giro: le fonti che sbordano dal budget di CPU restano al giro dopo, quindi
    // in circa tre tick tutte le fonti raggiungibili sono state provate e poi
    // si ricomincia dalla più vecchia.
    const summary: IngestSummary = await runIngest(deps, now, {
      allSources: true,
      maxSources: FALLBACK_MAX_SOURCES,
      // Le fonti coupon davanti, a rango intercalato: durante un guasto lungo il
      // budget di CPU lascia leggere poche fonti per tick, e senza questa riga
      // 💶 Coupon si svuotava proprio quando serviva la riserva. Vedi
      // priorityPool in src/pipeline.ts: coupon e concorsi si alternano.
      priorityCategories: ["coupon"],
    });
    sourcesOk = summary.sourcesOk;
    sourcesFail = summary.sourcesFail;
    itemsNew = summary.itemsNew;
    note.push(`raccolta di riserva: ${summary.itemsNew} nuovi, ${summary.sourcesOk}/${summary.sourcesDue} fonti ok`);
    fallback = { ok: summary.sourcesOk, due: summary.sourcesDue };
    note.push(...summary.notes.slice(0, 2));
    log = ingestLog(
      {
        attempts: summary.attempts,
        itemsSeen: summary.itemsSeen,
        itemsNew: summary.itemsNew,
        deferred: summary.deferred,
        // Il titolo lo dice: la rete di Cloudflare raggiunge poche fonti, e un
        // giro di riserva non va scambiato per una raccolta piena che è andata
        // male.
        titolo: "Raccolta di riserva (Worker)",
      },
      summary.notes,
    );
    // Come al primo giro in assoluto: niente avvisi immediati su un archivio che
    // si sta riempiendo di concorsi vecchi.
    skipInstant = summary.archiveWasEmpty;
    // Nessun avviso "fonte in errore" da qui: da questa rete un 403/503 dice
    // com'è la rete di Cloudflare, non come sta la fonte — e la stessa fonte
    // risponde 200 a GitHub. L'avviso vero lo manda la raccolta su GitHub
    // (scripts/ingest.ts), che è quella che vede il sito davvero.
  }

  const instant = skipInstant ? 0 : (await sendInstantAlerts({ store, tg, now })).sent;
  // Promemoria della watchlist: a tre giorni e a un giorno dalla chiusura, ma a
  // trenta e a sette per le raccolte punti e i premi da richiedere, che "chiudono"
  // quando ormai è tardi per cominciare a mettere via gli scontrini.
  const reminders = skipInstant ? 0 : (await sendWatchlistReminders({ store, tg, now })).sent;
  // Il promemoria del giro di oggi: solo per chi ha scelto un'ora.
  const giro = (await sendGiroReminders({ store, tg, now })).sent;
  // Il promemoria non dipende dagli avvisi: se la raccolta è ferma lo dice anche
  // in un giro in cui non c'era niente da notificare (anzi, soprattutto in quello).
  const raccolta = await sendCollectionReminder({ store, tg, now, runs, adminChatId, fallback });
  const expired = await expireOldItems(store, now);
  await store.pruneLogs(
    new Date(now.getTime() - RUNS_KEEP_MS).toISOString(),
    new Date(now.getTime() - UPDATES_KEEP_MS).toISOString(),
  );
  note.push(
    `avvisi: ${instant} istantanei`,
    `promemoria: ${reminders}`,
    `giro: ${giro}`,
    // Il segno nella nota è il modo in cui il tick successivo sa di aver già
    // avvisato: per questo si scrive solo quando il messaggio è partito davvero.
    raccolta.sent > 0 ? COLLECTION_REMINDER_MARK : COLLECTION_REMINDER_SKIP,
    `${expired} scaduti archiviati`,
  );

  await store.recordRun({
    startedAt: now.toISOString(), trigger: cron,
    sourcesOk, sourcesFail, itemsNew, ms: Date.now() - started,
    note: note.join(" | "),
    log,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/status") {
      return jsonResponse({ ok: true, bot: "Concorsi Radar", missing: missingBindings(env) });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (!safeEqual(request.headers.get("x-telegram-bot-api-secret-token"), env.WEBHOOK_SECRET)) {
        return jsonResponse({ ok: false, error: "forbidden" }, 403);
      }
      let update: TelegramUpdate;
      try {
        update = (await request.json()) as TelegramUpdate;
      } catch {
        return jsonResponse({ ok: false, error: "invalid json" }, 400);
      }

      const access = chatAccess(env);
      const store = createD1Store(env.DB);
      const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, (input, init) => fetch(input, init));
      const result = await handleUpdate(update, {
        store, tg, now: new Date(),
        adminChatId: access.adminChatId ?? access.allowed[0] ?? 0,
        allowedChatIds: access.allowed,
        // L'origine vera della richiesta: la pagina di condivisione funziona
        // anche su un dominio custom, senza una costante da aggiornare a mano.
        shareBase: url.origin,
      });
      // Sempre 200: Telegram ritenta gli update non-2xx e noi li deduplichiamo.
      return jsonResponse({ ok: true, handled: result.handled });
    }

    // La pagina di condivisione: un bottone `url` del bot apre questa, e da qui
    // `navigator.share()` chiama il pannello di sistema (WhatsApp, messaggi,
    // mail) invece delle sole chat di Telegram. Pubblica di proposito: non legge
    // niente e non ha segreti, riceve solo il link e la frase.
    //
    // Si condivide solo quello che è in archivio: link e frase vengono dalla riga,
    // non dall'URL. Prima la pagina stampava qualunque `u` e `t`, e il dominio del
    // bot diventava una vetrina per chiunque ("Hai vinto! Ritira qui" + un link a
    // piacere). `t` resta nei link vecchi ma non si legge più.
    if (url.pathname === "/share") {
      const target = url.searchParams.get("u") ?? "";
      if (!isShareableUrl(target)) return htmlResponse("<h1>Link non valido</h1>", 400);
      const item = await createD1Store(env.DB).getItemByUrlKey(urlKey(target));
      if (!item) return htmlResponse("<h1>Link non valido</h1>", 404);
      return htmlResponse(renderSharePage(item.url, sharePhrase(item.kind)));
    }

    if (url.pathname === "/setup") {
      if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "forbidden" }, 403);
      const access = chatAccess(env);
      const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, (input, init) => fetch(input, init));
      const me = await tg.getMe();
      const webhook = await tg.setWebhook(`${url.origin}/telegram`, env.WEBHOOK_SECRET);
      const commands = await tg.setMyCommands();
      return jsonResponse({
        ok: me.ok && webhook.ok,
        username: me.username,
        allowedChatIds: access.allowed,
        webhook,
        commands,
      });
    }

    if (url.pathname === "/bench") {
      if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "forbidden" }, 403);
      const store = createD1Store(env.DB);
      // Come la pipeline: i tetti per fonte vengono dalla config, non dalle righe
      // in D1 (che possono essere di un seed vecchio). Altrimenti si misura uno
      // scenario che in produzione non esiste.
      const enabled = (await store.getSources())
        .filter((source) => source.enabled)
        .map(resolveSource);
      const richieste = Number(url.searchParams.get("fonti") ?? 3);
      const quante = Number.isFinite(richieste) && richieste > 0 ? Math.min(richieste, 8) : 3;
      const bodies = await downloadBodies(
        enabled.slice(0, quante),
        (input: string, init?: RequestInit) => fetch(input, init),
        USER_AGENT,
      );
      const results = [];
      for (const { source, body } of bodies) results.push(await benchSource(source, body, 5));
      const dedupe = await benchDedupeLookup(300, 10, 3);
      return jsonResponse(summarise(results, dedupe, 300));
    }

    if (url.pathname === "/health") {
      if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "forbidden" }, 403);
      const access = chatAccess(env);
      const store = createD1Store(env.DB);
      const [runs, sources] = await Promise.all([store.recentRuns(5), store.getSources()]);
      return jsonResponse({
        ok: true,
        allowedChatIds: access.allowed,
        // Il log di una raccolta è lungo (una riga per fonte) e in /health non
        // serve: qui basta sapere che quel giro ha un racconto da leggere in
        // chat, e quale. `hasLog` dice esattamente questo.
        runs: runs.map((run) => ({
          startedAt: run.startedAt,
          trigger: run.trigger,
          sourcesOk: run.sourcesOk,
          sourcesFail: run.sourcesFail,
          itemsNew: run.itemsNew,
          ms: run.ms,
          note: run.note,
          hasLog: run.log !== null,
        })),
        // Fonte per fonte: oltre alla storia (lastOkAt, failStreak) c'è l'esito
        // dell'ULTIMO tentativo — ora, codice HTTP, item letti — che è la stessa
        // cosa che si legge in 📡 Fonti, senza aprire i log di GitHub.
        sources: sources.map((source) => ({
          id: source.id,
          enabled: source.enabled,
          lastOkAt: source.lastOkAt,
          lastRunAt: source.lastRunAt,
          lastStatus: source.lastStatus,
          lastError: source.lastError,
          lastItems: source.lastItems,
          failStreak: source.failStreak,
        })),
      });
    }

    return jsonResponse({ ok: false, error: "not found" }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, event.cron, new Date(event.scheduledTime)));
  },
};
