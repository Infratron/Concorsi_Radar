import type { ItemRow, Prefs } from "../types.ts";
import { truncate } from "../lib/text.ts";
import type { TelegramUpdate } from "./api.ts";
import type { NotifyDeps } from "./digest.ts";
import { escapeHtml, formatDate, formatItemLine, localDateString } from "./format.ts";

export type { NotifyDeps };

/**
 * Comandi e bottoni del bot. È privato: risponde solo ai chat id autorizzati
 * (ALLOWED_CHAT_IDS), così tu e chi vuoi tu potete usarlo con preferenze,
 * pesi e consegne separate.
 * Ogni update_id è registrato: i retry di Telegram non duplicano nulla.
 */

export interface BotDeps extends NotifyDeps {
  /** Chi riceve gli avvisi di sistema. */
  adminChatId: number;
  /** Chat autorizzati; se assente vale solo adminChatId. */
  allowedChatIds?: number[];
}

const HELP_TEXT = [
  "📡 <b>Concorsi Radar</b> — comandi",
  "",
  "/oggi — concorsi delle ultime 24 ore",
  "/settimana — ultimi 7 giorni",
  "/scadenze — chiudono entro 7 giorni",
  "/cerca &lt;parola&gt; — ricerca per parola chiave",
  "/salva &lt;id&gt; — salva un concorso",
  "/vinto &lt;id&gt; — segna come vinto",
  "/ignora &lt;id&gt; — ignora (i filtri si adattano)",
  "/fonti — stato delle fonti",
  "/health — stato delle esecuzioni",
  "/stop — sospendi le notifiche",
  "/start — riattiva le notifiche",
].join("\n");

export function defaultPrefs(chatId: number): Prefs {
  return {
    chatId,
    active: true,
    weights: {},
    minScoreInstant: 80,
    quietHours: "23-7",
    digestHours: [8, 19],
  };
}

function weightsFor(tags: string[], delta: number): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const tag of tags) weights[tag] = delta;
  return weights;
}

function shiftDate(dateString: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) return dateString;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function renderList(items: ItemRow[], now: Date, emptyMessage: string, header: string): string {
  if (items.length === 0) return emptyMessage;
  const lines = items.map((item) => formatItemLine(item, now));
  return [`<b>${escapeHtml(header)}</b> (${items.length})`, "", ...lines].join("\n");
}

export async function handleUpdate(
  update: TelegramUpdate,
  deps: BotDeps,
): Promise<{ handled: boolean }> {
  const { store, tg, now, adminChatId } = deps;
  const allowed = new Set(
    deps.allowedChatIds && deps.allowedChatIds.length > 0 ? deps.allowedChatIds : [adminChatId],
  );
  const nowIso = now.toISOString();

  if (!(await store.claimUpdate(update.update_id, nowIso))) {
    return { handled: false };
  }

  const callback = update.callback_query;
  if (callback) {
    const chatId = callback.message?.chat.id ?? adminChatId;
    if (!allowed.has(chatId)) {
      await tg.answerCallbackQuery(callback.id, "⛔ Bot privato.");
      return { handled: true };
    }
    const [action, rawId] = (callback.data ?? "").split(":");
    const itemId = Number(rawId);
    if (!Number.isFinite(itemId)) {
      await tg.answerCallbackQuery(callback.id, "Azione non valida");
      return { handled: true };
    }
    const item = await store.getItem(itemId);
    if (!item) {
      await tg.answerCallbackQuery(callback.id, "Concorso non trovato");
      return { handled: true };
    }
    // Le decisioni dell'utente sono PER CHAT (tabella deliveries): il bot è usato
    // in due, e ciò che ignori tu non deve sparire anche all'altra persona.
    switch (action) {
      case "save":
        await store.recordDelivery(chatId, itemId, "saved", nowIso);
        await store.bumpWeights(chatId, weightsFor(item.tags, 1));
        await tg.answerCallbackQuery(callback.id, "✅ Salvato");
        break;
      case "ign":
        await store.recordDelivery(chatId, itemId, "ignored", nowIso);
        await store.bumpWeights(chatId, weightsFor(item.tags, -1));
        await tg.answerCallbackQuery(callback.id, "🚫 Ignorato: i filtri si adattano");
        break;
      case "won":
        await store.recordDelivery(chatId, itemId, "won", nowIso);
        await tg.answerCallbackQuery(callback.id, "🏆 Complimenti!");
        break;
      default:
        await tg.answerCallbackQuery(callback.id, "Azione sconosciuta");
    }
    return { handled: true };
  }

  const message = update.message;
  if (!message || typeof message.text !== "string") return { handled: false };

  const chatId = message.chat.id;
  if (!allowed.has(chatId)) {
    // Il tuo id è la chiave d'accesso: lo mostriamo così l'admin può aggiungerti.
    await tg.sendMessage(
      chatId,
      `⛔ Bot privato. Il tuo chat id è <code>${chatId}</code>: chiedi di aggiungerlo a ALLOWED_CHAT_IDS.`,
    );
    return { handled: true };
  }

  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  const command = (rawCommand ?? "").toLowerCase().replace(/@[\w_]+$/, "");
  const keyword = args.join(" ").trim();
  const numericId = Number(args[0]);

  switch (command) {
    case "/start": {
      const existing = await store.getPrefs(chatId);
      await store.upsertPrefs(existing ? { ...existing, active: true } : defaultPrefs(chatId));
      await tg.sendMessage(chatId, `▶️ Notifiche attive.\n\n${HELP_TEXT}`);
      return { handled: true };
    }
    case "/stop": {
      const existing = (await store.getPrefs(chatId)) ?? defaultPrefs(chatId);
      await store.upsertPrefs({ ...existing, active: false });
      await tg.sendMessage(chatId, "⏸ Notifiche sospese. /start per riattivarle.");
      return { handled: true };
    }
    case "/oggi": {
      const items = await store.queryItems({
        since: new Date(now.getTime() - 86_400_000).toISOString(),
        limit: 15,
        orderBy: "score",
      });
      await tg.sendMessage(chatId, renderList(items, now, "Nessun concorso nelle ultime 24 ore.", "Ultime 24 ore"));
      return { handled: true };
    }
    case "/settimana": {
      const items = await store.queryItems({
        since: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
        limit: 15,
        orderBy: "score",
      });
      await tg.sendMessage(chatId, renderList(items, now, "Nessun concorso negli ultimi 7 giorni.", "Ultimi 7 giorni"));
      return { handled: true };
    }
    case "/scadenze": {
      const items = await store.queryItems({
        statuses: ["new", "sent"],
        deadlineBefore: shiftDate(localDateString(now), 7),
        orderBy: "deadline",
        limit: 15,
      });
      await tg.sendMessage(chatId, renderList(items, now, "Nessuna scadenza entro 7 giorni.", "Scadenze entro 7 giorni"));
      return { handled: true };
    }
    case "/cerca": {
      if (keyword.length === 0) {
        await tg.sendMessage(chatId, "Uso: <code>/cerca gift card</code>");
        return { handled: true };
      }
      const items = await store.queryItems({ keyword, limit: 10, orderBy: "score" });
      await tg.sendMessage(
        chatId,
        renderList(items, now, `Nessun risultato per «${escapeHtml(truncate(keyword, 40))}».`, `Ricerca: ${keyword}`),
      );
      return { handled: true };
    }
    case "/salva":
    case "/vinto":
    case "/ignora": {
      if (!Number.isFinite(numericId)) {
        await tg.sendMessage(chatId, `Uso: <code>${command} 123</code>`);
        return { handled: true };
      }
      const item = await store.getItem(numericId);
      if (!item) {
        await tg.sendMessage(chatId, `Nessun concorso con id ${numericId}.`);
        return { handled: true };
      }
      const kind = command === "/salva" ? "saved" : command === "/vinto" ? "won" : "ignored";
      await store.recordDelivery(chatId, numericId, kind, nowIso);
      if (kind !== "won") {
        await store.bumpWeights(chatId, weightsFor(item.tags, kind === "saved" ? 1 : -1));
      }
      const label = kind === "saved" ? "✅ Salvato" : kind === "won" ? "🏆 Segnato come vinto" : "🚫 Ignorato";
      await tg.sendMessage(chatId, `${label}: ${escapeHtml(truncate(item.title, 90))}`);
      return { handled: true };
    }
    case "/fonti": {
      const sources = await store.getSources();
      if (sources.length === 0) {
        await tg.sendMessage(chatId, "Nessuna fonte configurata.");
        return { handled: true };
      }
      const lines = sources.map((source) => {
        const state = source.enabled ? "🟢" : "⚪️";
        const lastOk = source.lastOkAt ? formatDate(source.lastOkAt) : "mai";
        return `${state} <code>${escapeHtml(source.id)}</code> · ok ${lastOk} · errori ${source.failStreak}`;
      });
      await tg.sendMessage(chatId, [`<b>Fonti</b> (${sources.length})`, "", ...lines].join("\n"));
      return { handled: true };
    }
    case "/health": {
      const runs = await store.recentRuns(5);
      if (runs.length === 0) {
        await tg.sendMessage(chatId, "Nessuna esecuzione registrata.");
        return { handled: true };
      }
      const lines = runs.map(
        (run) =>
          `• ${escapeHtml(run.trigger)} · ${run.sourcesOk} ok / ${run.sourcesFail} errori · ${run.itemsNew} nuovi · ${run.ms} ms`,
      );
      await tg.sendMessage(chatId, [`<b>Ultime esecuzioni</b> (${runs.length})`, "", ...lines].join("\n"));
      return { handled: true };
    }
    case "/help":
    case "": {
      await tg.sendMessage(chatId, HELP_TEXT);
      return { handled: true };
    }
    default: {
      await tg.sendMessage(chatId, `Comando non riconosciuto. Prova /help.\n(richiesta registrata alle ${escapeHtml(nowIso.slice(11, 16))} UTC)`);
      return { handled: true };
    }
  }
}
