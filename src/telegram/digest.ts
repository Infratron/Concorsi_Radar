import type { Store } from "../db/store.ts";
import type { ItemKind, ItemRow, Prefs, RunRow } from "../types.ts";
import { COLLECTION_SILENCE_MS, collectionCheck } from "../schedule.ts";
import type { TelegramClient } from "./api.ts";
import { daysLeft, formatDigest, formatItemCard, localDateString, localHour, type DigestSection } from "./format.ts";
import { digestKeyboard, instantKeyboard } from "./keyboard.ts";
import { staleItemReason } from "../enrich/freshness.ts";
import { isSamePage, regulationUrlFromText } from "../enrich/regulation.ts";
import { filtersFor } from "../filters.ts";

/**
 * Digest programmati e avvisi istantanei.
 * Regola d'oro: mai un messaggio vuoto, mai lo stesso concorso due volte,
 * mai più di un avviso istantaneo ogni 20 minuti.
 *
 * Qui passano SOLO i concorsi: un articolo che parla di un concorso non merita
 * una notifica, perché non c'è niente da fare con quel link. Le notizie si
 * leggono nella sezione 📰 News, quando si vuole.
 */

/** Le notifiche riguardano solo le pagine su cui si partecipa. */
const SOLO_CONCORSI: ItemKind[] = ["contest"];

export interface NotifyDeps {
  store: Store;
  tg: TelegramClient;
  now: Date;
}

/** Tetto di item per digest: oltre diventa rumore. */
export const DIGEST_MAX_ITEMS = 8;
/** Distanza minima tra due avvisi istantanei sulla stessa chat. */
export const INSTANT_MIN_GAP_MS = 20 * 60 * 1000;
/** Massimo avvisi istantanei per esecuzione (globale). */
export const INSTANT_MAX_PER_RUN = 2;
/** Non avvisare in modo istantaneo per item scoperti da più di 3 ore. */
export const INSTANT_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/** Soglia "alto valore" usata per la sezione dedicata del digest. */
export const HIGH_VALUE_SCORE = 70;

/**
 * Quando ricordare un concorso della watchlist: a tre giorni e a un giorno dalla
 * chiusura. È la differenza fra "l'ho salvato" e "l'ho fatto": senza promemoria,
 * un concorso importante si perde proprio perché era importante.
 */
export const WATCHLIST_REMINDER_DAYS = [3, 1];
/** Tetto di promemoria per chat in un giro: oltre diventa un listone. */
export const WATCHLIST_MAX_PER_RUN = 2;

function parseQuietHours(value: string): [number, number] | null {
  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > 23 || end > 23) return null;
  return [start, end];
}

/** true se l'ora locale italiana cade nella fascia di silenzio (es. "23-7"). */
export function isQuietHour(prefs: Prefs, now: Date): boolean {
  const range = parseQuietHours(prefs.quietHours);
  if (!range) return false;
  const hour = localHour(now);
  const [start, end] = range;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** URL del regolamento dentro il testo dell'item, se ne troviamo uno diverso dalla pagina. */
export function regolamentoUrl(item: ItemRow): string | null {
  // Prima quello che la pipeline ha trovato SULLA PAGINA del concorso e salvato
  // sull'item: è il caso in cui il riassunto del feed il bando non lo nominava
  // affatto, ed è il motivo per cui questa colonna esiste.
  const salvato = item.rulesUrl ?? null;
  if (salvato !== null && !isSamePage(salvato, item.url)) return salvato;

  // Poi il testo dell'item: copre le righe raccolte prima di quella ricerca e i
  // feed che il link ce l'hanno nel riassunto. Stessa funzione dell'ingestione,
  // quindi la definizione di "regolamento" è una sola (src/enrich/regulation.ts).
  return regulationUrlFromText(`${item.summary} ${item.participation ?? ""}`, item.url);
}

function sectionsFor(items: ItemRow[], now: Date): DigestSection[] {
  const sections: DigestSection[] = [
    { title: "⏳ In scadenza", items: [] },
    { title: "🔥 Alto valore", items: [] },
    { title: "📋 Altri", items: [] },
  ];
  for (const item of items) {
    const left = daysLeft(item.deadline, now);
    if (left !== null && left >= 0 && left <= 7) sections[0].items.push(item);
    else if (item.score >= HIGH_VALUE_SCORE) sections[1].items.push(item);
    else sections[2].items.push(item);
  }
  return sections;
}

/**
 * Item candidati non ancora consegnati a QUESTA chat e non scartati da lei.
 * Le decisioni dell'utente (ignorato) vivono nella tabella deliveries per chat:
 * se uno dei due utenti ignora un concorso, l'altro lo riceve comunque.
 */
async function undelivered(store: Store, chatId: number, candidates: ItemRow[], now: Date): Promise<ItemRow[]> {
  const result: ItemRow[] = [];
  for (const item of candidates) {
    if (item.status === "expired") continue;
    // Ultimo controllo prima di scrivere in chat: quello che è già in archivio
    // passa comunque dal cancello. Un item senza scadenza che non regge il test
    // di "concorso ancora attivo" non si annuncia, nemmeno se è stato inserito
    // quando il cancello non c'era (o se la sua pagina è invecchiata dopo).
    if (staleItemReason(item, now) !== null) continue;
    if (await store.isDelivered(chatId, item.id, "digest")) continue;
    if (await store.isDelivered(chatId, item.id, "instant")) continue;
    if (await store.isDelivered(chatId, item.id, "ignored")) continue;
    result.push(item);
  }
  return result;
}

export async function sendDigests(deps: NotifyDeps): Promise<{ chats: number; messages: number }> {
  const { store, tg, now } = deps;
  let chats = 0;
  let messages = 0;

  for (const chatId of await store.listChats()) {
    const prefs = await store.getPrefs(chatId);
    if (!prefs || !prefs.active) continue;
    // Digest spenti dalle impostazioni: gli avvisi immediati continuano ad arrivare.
    if (prefs.digestHours.length === 0) continue;
    // In fascia di silenzio gli item restano 'new': li prende il digest successivo.
    if (isQuietHour(prefs, now)) continue;

    const since =
      (await store.lastDeliveryAt(chatId, "digest")) ??
      new Date(now.getTime() - 86_400_000).toISOString();

    // Nessun filtro sullo stato: lo stato è di sistema (new/sent/expired),
    // mentre "cosa ho già ricevuto" e "cosa ho scartato" sono per chat.
    // I filtri personali invece valgono eccome: un concorso di una fonte che
    // questa chat ha spento non merita una notifica.
    const candidates = await store.queryItems(
      filtersFor(prefs.filters, { since, kinds: SOLO_CONCORSI, limit: 60, orderBy: "score" }),
    );
    const fresh = await undelivered(store, chatId, candidates, now);
    if (fresh.length === 0) continue;

    const included = fresh.slice(0, DIGEST_MAX_ITEMS);
    const discarded = fresh.length - included.length;
    const extraLines = discarded > 0 ? [`…e altri ${discarded} su /oggi`] : [];
    const texts = formatDigest(sectionsFor(included, now), now, extraLines);

    let sent = 0;
    for (const [index, text] of texts.entries()) {
      // I bottoni stanno solo sull'ultimo messaggio (è lì che finisce l'elenco),
      // così un digest lungo non ripete otto volte le stesse scelte.
      const keyboard = index === texts.length - 1 ? digestKeyboard(included, now) : undefined;
      const result = await tg.sendMessage(chatId, text, { keyboard, disablePreview: true });
      if (!result.ok) break;
      sent++;
    }
    if (sent === 0) continue;

    chats++;
    messages += sent;
    for (const item of included) {
      await store.recordDelivery(chatId, item.id, "digest", now.toISOString());
      await store.setStatus(item.id, "sent");
    }
  }

  return { chats, messages };
}

/**
 * Promemoria di chiusura per i concorsi che hai messo in watchlist.
 *
 * Regole: solo item salvati, solo con una scadenza, solo a 3 giorni e a 1 giorno
 * dalla chiusura, una volta sola per soglia (la consegna "reminder:3" resta
 * registrata). Rispetta la fascia di silenzio e non tocca il ritmo degli avvisi
 * immediati: è un messaggio che hai chiesto tu salvando il concorso.
 */
export async function sendWatchlistReminders(deps: NotifyDeps): Promise<{ sent: number }> {
  const { store, tg, now } = deps;
  let sent = 0;

  for (const chatId of await store.listChats()) {
    const prefs = await store.getPrefs(chatId);
    if (!prefs || !prefs.active) continue;
    if (isQuietHour(prefs, now)) continue;

    const salvati = await store.listDeliveredItems(chatId, "saved", 200);
    let inviati = 0;
    for (const item of salvati) {
      if (inviati >= WATCHLIST_MAX_PER_RUN) break;
      if (item.status === "expired") continue;
      const left = daysLeft(item.deadline, now);
      // Senza scadenza non c'è niente da ricordare in tempo: resta nella watchlist.
      if (left === null || left > WATCHLIST_REMINDER_DAYS[0]) continue;
      // Un item che scade già chiuso (left < 0) non si annuncia più.
      if (left < 0) continue;
      const soglia = left <= 1 ? 1 : 3;
      const kind = `reminder:${soglia}`;
      if (await store.isDelivered(chatId, item.id, kind)) continue;

      const quando = left === 0 ? "chiude oggi" : left === 1 ? "chiude domani" : `chiude tra ${left} giorni`;
      const testo = `⭐ <b>Watchlist</b> · ${quando}\n\n${formatItemCard(item, now)}`;
      const result = await tg.sendMessage(chatId, testo, {
        keyboard: instantKeyboard(item, regolamentoUrl(item)),
        disablePreview: true,
      });
      if (!result.ok) continue;

      // La soglia annunciata resta registrata: il giro successivo non ripete lo
      // stesso promemoria (e quello a un giorno resta un messaggio a sé).
      await store.recordDelivery(chatId, item.id, kind, now.toISOString());
      inviati++;
      sent++;
    }
  }

  return { sent };
}

/** Ore in parole: in chat "4 ore" dice tutto, "4,2 ore" non dice niente. */
function oreInParole(ore: number): string {
  const quante = Math.max(1, Math.round(ore));
  return quante === 1 ? "un'ora" : `${quante} ore`;
}

export interface CollectionReminderDeps extends NotifyDeps {
  /** Le ultime esecuzioni: il tick le ha già lette per la raccolta di riserva. */
  runs: RunRow[];
  /** Chi deve controllare GitHub; null = nessun admin, e allora non si avvisa. */
  adminChatId: number | null;
  /** Esito della raccolta di riserva di QUESTO tick, se è partita. */
  fallback: { ok: number; due: number } | null;
}

/**
 * "La raccolta su GitHub non gira" — il guasto che nessuno vedeva.
 *
 * Perché serve: quando Actions smette di raccogliere, il radar continua a
 * consegnare quello che ha già in archivio, quindi dall'esterno sembra tutto
 * normale; l'unico segnale era la raccolta di riserva che partiva in silenzio, e
 * in /fonti bisognava saperlo leggere. Qui lo dice l'admin chat, una volta ogni
 * sei ore al massimo, con i due dati che servono a capire: da quanto tace GitHub
 * e se il Worker sta coprendo.
 *
 * Rispetta la fascia di silenzio: un promemoria ricorrente non deve suonare
 * alle tre di notte. Se la fascia è attiva, il messaggio parte al primo tick
 * dopo la fascia — la raccolta ferma resta ferma nel frattempo.
 */
export async function sendCollectionReminder(deps: CollectionReminderDeps): Promise<{ sent: number }> {
  const { store, tg, now, runs, adminChatId, fallback } = deps;
  if (adminChatId === null) return { sent: 0 };

  const check = collectionCheck(runs, now);
  if (!check.avvisare) return { sent: 0 };

  const prefs = await store.getPrefs(adminChatId);
  // Senza preferenze salvate non c'è nessuna fascia da rispettare: l'admin non ha
  // mai aperto il bot, e un allarme tecnico vale più del silenzio.
  if (prefs && isQuietHour(prefs, now)) return { sent: 0 };

  // La soglia vale anche nel messaggio: se l'ultima raccolta non è nella finestra
  // si può affermare "più di" le ore che la finestra copre, non di più.
  const sogliaOre = COLLECTION_SILENCE_MS / 3_600_000;
  const titolo =
    check.oreDaRaccolta !== null
      ? `⚠️ <b>Raccolta ferma da ${oreInParole(check.oreDaRaccolta)}</b>`
      : `⚠️ <b>Raccolta ferma da più di ${oreInParole(Math.max(sogliaOre, check.finestraOre ?? sogliaOre))}</b>`;
  const quando =
    check.oreDaRaccolta === null
      ? "Su GitHub non risulta nessuna raccolta in questo periodo."
      : `L'ultima raccolta su GitHub è girata ${oreInParole(check.oreDaRaccolta)} fa.`;
  const copertura = fallback
    ? `Il radar non è fermo: questo tick ha raccolto di riserva (${fallback.ok} fonti su ${fallback.due}). Da qui però passano poche fonti, sono quelle che la rete di Cloudflare raggiunge.`
    : "Il radar non è fermo: gli item già in archivio continuano a essere consegnati, ma niente di nuovo entra.";

  const righe = [titolo, "", quando, copertura];
  // Un tick vecchio vuol dire che anche il Worker è fermo: è un guasto diverso, e
  // dirlo evita di andare a cercare i secret di GitHub per niente.
  if (check.oreDalTick !== null && check.oreDalTick > 1) {
    righe.push(
      `Attenzione: anche i tick del Worker sono fermi da ${oreInParole(check.oreDalTick)} — il problema non è solo GitHub.`,
    );
  }
  righe.push(
    "",
    "Da controllare: i tre secret del repository (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID), e che il workflow non sia stato disattivato per inattività.",
  );

  const risultato = await tg.sendMessage(adminChatId, righe.join("\n"), { disablePreview: true });
  return { sent: risultato.ok ? 1 : 0 };
}

export async function sendInstantAlerts(deps: NotifyDeps): Promise<{ sent: number }> {
  const { store, tg, now } = deps;
  let sent = 0;

  for (const chatId of await store.listChats()) {
    if (sent >= INSTANT_MAX_PER_RUN) break;

    const prefs = await store.getPrefs(chatId);
    if (!prefs || !prefs.active) continue;
    if (isQuietHour(prefs, now)) continue;

    const last = await store.lastDeliveryAt(chatId, "instant");
    if (last && now.getTime() - Date.parse(last) < INSTANT_MIN_GAP_MS) continue;

    const candidates = await store.queryItems(
      filtersFor(prefs.filters, {
        minScore: prefs.minScoreInstant,
        kinds: SOLO_CONCORSI,
        orderBy: "score",
        limit: 5,
      }),
    );

    for (const item of candidates) {
      if (sent >= INSTANT_MAX_PER_RUN) break;
      if (item.status === "expired") continue;
      if (staleItemReason(item, now) !== null) continue;
      const seenAt = Date.parse(item.firstSeenAt);
      if (Number.isFinite(seenAt) && now.getTime() - seenAt > INSTANT_MAX_AGE_MS) continue;
      if (await store.isDelivered(chatId, item.id, "instant")) continue;
      if (await store.isDelivered(chatId, item.id, "digest")) continue;
      if (await store.isDelivered(chatId, item.id, "ignored")) continue;

      const result = await tg.sendMessage(chatId, formatItemCard(item, now), {
        keyboard: instantKeyboard(item, regolamentoUrl(item)),
        disablePreview: true,
      });
      if (!result.ok) continue;

      await store.recordDelivery(chatId, item.id, "instant", now.toISOString());
      await store.setStatus(item.id, "sent");
      sent++;
    }
  }

  return { sent };
}
