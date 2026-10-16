import type { Env } from "./types.ts";
import { chatAccess, missingBindings, type ChatAccess } from "./config/env.ts";
import { createD1Store } from "./db/d1.ts";
import { resolveSource, runIngest, type IngestSummary } from "./pipeline.ts";
import type { TelegramUpdate } from "./telegram/api.ts";
import { TelegramClient } from "./telegram/api.ts";
import { handleUpdate } from "./telegram/bot.ts";
import { sendDigests, sendInstantAlerts } from "./telegram/digest.ts";
import { jobFor } from "./schedule.ts";
import { USER_AGENT } from "./config/sources.ts";
import { benchDedupeLookup, benchSource, downloadBodies, summarise } from "./debug/bench.ts";
import { jsonResponse } from "./lib/http.ts";

/**
 * Entry point del Worker.
 *  - POST /telegram  → webhook (protetto dall'header segreto di Telegram)
 *  - GET  /setup     → registra webhook e menu comandi (protetto dal secret)
 *  - GET  /health    → stato di esecuzioni e fonti (protetto dal secret)
 *  - scheduled()     → ingestione a rotazione oppure digest, in base al cron
 */

/** Confronto a tempo costante per i secret nell'URL. */
function safeEqual(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function runCron(env: Env, cron: string, now: Date): Promise<void> {
  const store = createD1Store(env.DB);
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, (input, init) => fetch(input, init));
  const access: ChatAccess = chatAccess(env);
  const adminChatId = access.adminChatId;
  const started = Date.now();
  const deps = { store, fetcher: (input: string, init?: RequestInit) => fetch(input, init), ai: env.AI };

  // Le ore di digest valgono per tutti gli autorizzati: basta che una combaci.
  const digestHours = new Set<number>();
  for (const chatId of access.allowed) {
    const prefs = await store.getPrefs(chatId);
    for (const hour of prefs?.digestHours ?? [8, 19]) digestHours.add(hour);
  }

  if (jobFor(cron, now, [...digestHours]) === "digest") {
    const result = await sendDigests({ store, tg, now });
    await store.recordRun({
      startedAt: now.toISOString(), trigger: cron, sourcesOk: 0, sourcesFail: 0,
      itemsNew: result.messages, ms: Date.now() - started,
      note: `digest: ${result.chats} chat, ${result.messages} messaggi`,
    });
    return;
  }

  const summary: IngestSummary = await runIngest(deps, now);
  let instant = 0;
  // Al primo giro in assoluto l'archivio si riempie di concorsi vecchi: avvisare
  // subito sarebbe rumore, ci pensa il digest a presentarli.
  if (summary.itemsNew > 0 && !summary.archiveWasEmpty) {
    instant = (await sendInstantAlerts({ store, tg, now })).sent;
  }

  // Gli avvisi di sistema vanno all'admin, non a tutti: sono problemi tecnici.
  if (adminChatId !== null) {
    for (const sourceId of summary.deadSources) {
      await tg.sendMessage(adminChatId, `⚠️ <b>Fonte in errore</b>: ${sourceId} ha fallito 3 volte di fila. Controlla /fonti.`);
    }
  }

  await store.recordRun({
    startedAt: now.toISOString(), trigger: cron,
    sourcesOk: summary.sourcesOk, sourcesFail: summary.sourcesFail,
    itemsNew: summary.itemsNew, ms: summary.ms,
    note: [
      `${summary.sourcesDue} fonti dovute`, `${summary.duplicates} duplicati`,
      `${summary.filtered} fuori tema`, `${instant} istantanei`,
      `cpu ~${summary.cpuMs} ms`, summary.deferred > 0 ? `${summary.deferred} rimandati` : null,
      summary.archiveWasEmpty ? "primo giro: nessun istantaneo" : null,
      ...summary.notes.slice(0, 3),
    ]
      .filter((part): part is string => part !== null)
      .join(" | "),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const secret = url.searchParams.get("secret");

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
      });
      // Sempre 200: Telegram ritenta gli update non-2xx e noi li deduplichiamo.
      return jsonResponse({ ok: true, handled: result.handled });
    }

    if (url.pathname === "/setup") {
      if (!safeEqual(secret, env.WEBHOOK_SECRET)) return jsonResponse({ ok: false, error: "forbidden" }, 403);
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
      if (!safeEqual(secret, env.WEBHOOK_SECRET)) return jsonResponse({ ok: false, error: "forbidden" }, 403);
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
      if (!safeEqual(secret, env.WEBHOOK_SECRET)) return jsonResponse({ ok: false, error: "forbidden" }, 403);
      const access = chatAccess(env);
      const store = createD1Store(env.DB);
      const [runs, sources] = await Promise.all([store.recentRuns(5), store.getSources()]);
      return jsonResponse({
        ok: true,
        allowedChatIds: access.allowed,
        runs,
        sources: sources.map((source) => ({
          id: source.id, enabled: source.enabled, lastOkAt: source.lastOkAt, failStreak: source.failStreak,
        })),
      });
    }

    return jsonResponse({ ok: false, error: "not found" }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, event.cron, new Date(event.scheduledTime)));
  },
};
