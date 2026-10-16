import type { ItemQuery, ItemRow, Prefs, SourceRow, UiState } from "../types.ts";
import { truncate } from "../lib/text.ts";
import type { TelegramUpdate } from "./api.ts";
import type { NotifyDeps } from "./digest.ts";
import { regolamentoUrl } from "./digest.ts";
import { localDateString } from "./format.ts";
import { PAGE_SIZE } from "./keyboard.ts";
import {
  applyIntent,
  parseCallback,
  renderScreen,
  type Intent,
  type Screen,
  type ScreenCounts,
  type ScreenData,
} from "./screens.ts";

export type { NotifyDeps };

/**
 * Interfaccia del bot: menù a pulsanti su UN solo messaggio per chat.
 *
 * Come funziona: ogni tocco o comando diventa un Intent (src/telegram/screens.ts),
 * l'intento aggiorna lo stato della chat (`ui` in D1) e la schermata che ne
 * risulta viene *modificata* nel messaggio già presente — non ne viene mandato uno
 * nuovo. Il comando scritto dall'utente viene cancellato subito, così in chat
 * resta solo la schermata viva. Le notifiche (avvisi immediati) restano finché non
 * le usi: appena tocchi un bottone, il bot le toglie di mezzo.
 *
 * È privato: risponde solo ai chat id in ALLOWED_CHAT_IDS. Ogni update_id è
 * registrato, quindi i retry di Telegram non duplicano nulla.
 */

export interface BotDeps extends NotifyDeps {
  /** Chi riceve gli avvisi di sistema. */
  adminChatId: number;
  /** Chat autorizzati; se assente vale solo adminChatId. */
  allowedChatIds?: number[];
}

/** Quanti item si leggono per un elenco: oltre questo si guarda con 🔍 Cerca. */
export const LIST_FETCH_LIMIT = 60;
const WEEK_MS = 7 * 86_400_000;

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
  return Object.fromEntries(tags.map((tag) => [tag, delta]));
}

function shiftDate(dateString: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) return dateString;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function emptyState(chatId: number): UiState {
  return { chatId, messageId: null, section: "menu", page: 0, openItemId: null, lastCheckAt: null };
}

/**
 * Comandi → intenti. Sono una scorciatoia, non il modo normale di usare il bot:
 * il menù fa tutto. Restano perché sono comodi da tastiera e perché Telegram li
 * mostra nel menù "/".
 */
function intentForCommand(command: string, args: string): Intent | null {
  switch (command) {
    case "/start":
    case "/menu":
    case "/help":
    case "/aiuto":
      return { kind: "home" };
    case "/nuovi":
      return { kind: "section", section: "nuovi" };
    case "/oggi":
      return { kind: "section", section: "oggi" };
    case "/settimana":
      return { kind: "section", section: "settimana" };
    case "/scadenze":
      return { kind: "section", section: "scadenze" };
    case "/salvati":
      return { kind: "section", section: "salvati" };
    case "/cerca":
      return { kind: "section", section: "cerca" };
    case "/fonti":
    case "/health":
      return { kind: "section", section: "fonti" };
    case "/impostazioni":
      return { kind: "section", section: "impostazioni" };
    case "/stop":
      return { kind: "config", key: "notify", value: "off" };
    case "/salva":
    case "/vinto":
    case "/ignora": {
      const itemId = Number.parseInt(args.split(/\s+/)[0] ?? "", 10);
      if (!Number.isFinite(itemId)) return { kind: "home" };
      const action = command === "/salva" ? "save" : command === "/vinto" ? "won" : "ign";
      return { kind: "decision", action, itemId };
    }
    default:
      return null;
  }
}

/** Applica una preferenza scelta dalle impostazioni. Valori fuori elenco: ignorati. */
function withConfig(prefs: Prefs, key: "score" | "quiet" | "digest" | "notify", value: string): Prefs {
  switch (key) {
    case "score": {
      const score = Number.parseInt(value, 10);
      return Number.isFinite(score) && score >= 0 && score <= 100 ? { ...prefs, minScoreInstant: score } : prefs;
    }
    case "quiet": {
      if (value === "off") return { ...prefs, quietHours: "" };
      const fascia = /^(\d{1,2})-(\d{1,2})$/.exec(value);
      if (!fascia) return prefs;
      const start = Number(fascia[1]);
      const end = Number(fascia[2]);
      // Ore reali, non solo cifre: "99-99" non è una fascia di silenzio.
      if (start > 23 || end > 23) return prefs;
      return { ...prefs, quietHours: value };
    }
    case "digest": {
      if (value === "off") return { ...prefs, digestHours: [] };
      const hours = value
        .split(",")
        .map((chunk) => Number.parseInt(chunk, 10))
        .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
      return hours.length > 0 ? { ...prefs, digestHours: hours } : prefs;
    }
    case "notify":
      return { ...prefs, active: value === "on" };
  }
}

/** Il messaggio in sovraimpressione: conferma l'effetto di ciò che hai toccato. */
function toastFor(intent: Intent, prefs: Prefs): string | null {
  switch (intent.kind) {
    case "decision":
      return intent.action === "save"
        ? "✅ Salvato"
        : intent.action === "ign"
          ? "🚫 Ignorato: i filtri si adattano"
          : "🏆 Complimenti!";
    case "refresh":
      return "🔄 Aggiornato";
    case "config":
      if (intent.key === "score") return `🔔 Avvisi sopra ${prefs.minScoreInstant}/100`;
      if (intent.key === "quiet") {
        return prefs.quietHours ? `🌙 Silenzio ${prefs.quietHours.replace("-", "–")}` : "🌙 Silenzio disattivato";
      }
      if (intent.key === "digest") {
        return prefs.digestHours.length > 0 ? `📬 Digest alle ${prefs.digestHours.join(" e ")}` : "📬 Digest spenti";
      }
      return prefs.active ? "▶️ Notifiche attive" : "⏸ Notifiche sospese";
    default:
      return null;
  }
}

/** Query della sezione corrente, senza limit: il totale lo conta countItems. */
function sectionQuery(section: string, now: Date, lastCheckAt: string | null): ItemQuery {
  if (section === "nuovi") return { since: lastCheckAt ?? new Date(now.getTime() - WEEK_MS).toISOString() };
  if (section === "oggi") return { since: new Date(now.getTime() - 86_400_000).toISOString() };
  if (section === "settimana") return { since: new Date(now.getTime() - WEEK_MS).toISOString() };
  if (section === "scadenze") {
    // Solo scadenze future: un concorso già chiuso non serve in questa sezione.
    return {
      statuses: ["new", "sent"],
      deadlineAfter: localDateString(now),
      deadlineBefore: shiftDate(localDateString(now), 7),
      orderBy: "deadline",
    };
  }
  return { keyword: section.slice("cerca:".length), orderBy: "score" };
}

function isListSection(section: string): boolean {
  return (
    section === "nuovi" ||
    section === "oggi" ||
    section === "settimana" ||
    section === "scadenze" ||
    section === "salvati" ||
    section.startsWith("cerca:")
  );
}

async function decisionFor(deps: BotDeps, chatId: number, itemId: number): Promise<string | null> {
  for (const kind of ["won", "ignored", "saved"] as const) {
    if (await deps.store.isDelivered(chatId, itemId, kind)) return kind;
  }
  for (const kind of ["instant", "digest"] as const) {
    if (await deps.store.isDelivered(chatId, itemId, kind)) return "sent";
  }
  return null;
}

/** Tutto ciò che serve a disegnare la schermata corrente. */
async function loadScreenData(
  deps: BotDeps,
  chatId: number,
  state: UiState,
  prefs: Prefs,
  now: Date,
): Promise<ScreenData> {
  const { store } = deps;
  const settimanaFa = new Date(now.getTime() - WEEK_MS).toISOString();
  const ventiquattroOreFa = new Date(now.getTime() - 86_400_000).toISOString();
  const sinceNuovi = state.lastCheckAt ?? settimanaFa;
  const scadenza = sectionQuery("scadenze", now, null);
  const salvati = await store.listDeliveredItems(chatId, "saved", 200);

  // I conteggi sono query SQL di conteggio: non caricano righe, quindi il menù
  // resta leggero anche con un archivio grande.
  const [archiveTotal, nuovi, oggi, settimana, scadenze] = await Promise.all([
    store.countItems({}),
    store.countItems({ since: sinceNuovi }),
    store.countItems({ since: ventiquattroOreFa }),
    store.countItems({ since: settimanaFa }),
    store.countItems(scadenza),
  ]);
  const counts: ScreenCounts = { nuovi, oggi, settimana, scadenze, salvati: salvati.length };

  const wantsList = state.openItemId === null && isListSection(state.section);
  let items: ItemRow[] = [];
  let total = 0;
  if (wantsList) {
    const completo =
      state.section === "salvati"
        ? salvati
        : await store.queryItems({ ...sectionQuery(state.section, now, state.lastCheckAt), limit: LIST_FETCH_LIMIT });
    total = state.section === "salvati" ? salvati.length : await store.countItems(sectionQuery(state.section, now, state.lastCheckAt));
    // La pagina si riporta dentro l'intervallo PRIMA di ritagliare: uno stato
    // vecchio (o una lista accorciata) non deve mostrare una pagina vuota.
    const pagine = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pagina = Math.min(Math.max(state.page, 0), pagine - 1);
    items = completo.slice(pagina * PAGE_SIZE, pagina * PAGE_SIZE + PAGE_SIZE);
  }

  const openItem = state.openItemId !== null ? await store.getItem(state.openItemId) : null;
  const decision = state.openItemId !== null ? await decisionFor(deps, chatId, state.openItemId) : null;
  const pagine = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(state.page, 0), pagine - 1);

  return {
    counts,
    page,
    items,
    total,
    openItem,
    decision,
    regolamentoUrl: openItem ? regolamentoUrl(openItem) : null,
    sources: state.section === "fonti" ? await store.getSources() : ([] as SourceRow[]),
    runs: state.section === "fonti" ? await store.recentRuns(4) : [],
    prefs,
    archiveTotal,
  };
}

/**
 * Applica la schermata all'unico messaggio della chat: modifica quello esistente e
 * solo se non c'è più (l'utente l'ha cancellato) ne manda uno nuovo.
 */
async function paint(deps: BotDeps, chatId: number, state: UiState, screen: Screen): Promise<UiState> {
  if (state.messageId !== null) {
    const edited = await deps.tg.editMessageText(chatId, state.messageId, screen.text, { keyboard: screen.keyboard });
    if (edited.ok) return state;
  }
  const sent = await deps.tg.sendMessage(chatId, screen.text, {
    keyboard: screen.keyboard,
    disablePreview: true,
  });
  return { ...state, messageId: sent.messageId };
}

export async function handleUpdate(update: TelegramUpdate, deps: BotDeps): Promise<{ handled: boolean }> {
  const { store, tg, now, adminChatId } = deps;
  const allowed = new Set(deps.allowedChatIds && deps.allowedChatIds.length > 0 ? deps.allowedChatIds : [adminChatId]);
  const nowIso = now.toISOString();

  if (!(await store.claimUpdate(update.update_id, nowIso))) return { handled: false };

  const callback = update.callback_query;
  const message = update.message;
  const chatId = callback?.message?.chat.id ?? message?.chat.id;
  if (chatId === undefined) return { handled: false };
  if (!callback && message?.text === undefined) return { handled: false };

  if (!allowed.has(chatId)) {
    // Il tuo id è la chiave d'accesso: lo mostriamo così l'admin può aggiungerti.
    if (callback) await tg.answerCallbackQuery(callback.id, "⛔ Bot privato.");
    else {
      await tg.sendMessage(
        chatId,
        `⛔ Bot privato. Il tuo chat id è <code>${chatId}</code>: chiedi di aggiungerlo a ALLOWED_CHAT_IDS.`,
      );
    }
    return { handled: true };
  }

  const state = (await store.getUiState(chatId)) ?? emptyState(chatId);
  // Prefisso `d:` = il tocco arriva da un digest: quel messaggio è contenuto da
  // rileggere, quindi non si cancella. Un avviso immediato invece ha già fatto il
  // suo lavoro appena lo usi, e allora sparisce: in chat non resta niente appeso.
  const datiCallback = callback?.data ?? "";
  const conserva = datiCallback.startsWith("d:");
  const notificationId =
    !conserva && callback?.message?.message_id !== undefined && callback.message.message_id !== state.messageId
      ? callback.message.message_id
      : null;

  let prefs = (await store.getPrefs(chatId)) ?? defaultPrefs(chatId);

  // Il comando scritto dall'utente sparisce subito: in chat resta la schermata.
  if (message) await tg.deleteMessage(chatId, message.message_id);

  let intent: Intent;
  if (callback) {
    intent = parseCallback(conserva ? datiCallback.slice(2) : datiCallback);
  } else {
    const text = (message?.text ?? "").trim();
    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = (rawCommand ?? "").toLowerCase().replace(/@[\w_]+$/, "");
    const fromCommand = command.startsWith("/") ? intentForCommand(command, rest.join(" ")) : null;
    if (fromCommand) intent = fromCommand;
    // Senza comando: se la chat è in modalità ricerca, il testo è la ricerca.
    else if (state.section === "cerca" && text.length > 0) intent = { kind: "section", section: `cerca:${truncate(text, 40)}` };
    else intent = { kind: "home" };
  }

  if (intent.kind === "decision") {
    const item = await store.getItem(intent.itemId);
    if (!item) {
      if (callback) await tg.answerCallbackQuery(callback.id, "Concorso non trovato");
      return { handled: true };
    }
    const kind = intent.action === "save" ? "saved" : intent.action === "ign" ? "ignored" : "won";
    const ripetuta = await store.isDelivered(chatId, intent.itemId, kind);
    await store.recordDelivery(chatId, intent.itemId, kind, nowIso);
    // Decidere due volte la stessa cosa (doppio tocco sullo stesso bottone, o
    // scheda e digest dello stesso concorso) non sposta i pesi due volte.
    if (intent.action !== "won" && !ripetuta) {
      await store.bumpWeights(chatId, weightsFor(item.tags, intent.action === "save" ? 1 : -1));
    }
  }

  if (intent.kind === "config") {
    prefs = withConfig(prefs, intent.key, intent.value);
    await store.upsertPrefs(prefs);
  }

  // /start è anche l'iscrizione: chi lo scrive vuole le notifiche attive.
  if (message && (message.text ?? "").trim().toLowerCase().startsWith("/start") && !prefs.active) {
    prefs = { ...prefs, active: true };
    await store.upsertPrefs(prefs);
  }

  const next = applyIntent(state, intent, now);
  // I dati si leggono con il lastCheckAt VECCHIO: è quello che rende possibile
  // mostrare i nuovi arrivati. Solo dopo averli mostrati il contatore riparte.
  const data = await loadScreenData(deps, chatId, next, prefs, now);
  // La pagina salvata è quella davvero mostrata: così anche uno stato vecchio
  // (per esempio dopo una pulizia dell'archivio) resta coerente.
  const normalized = { ...next, page: data.page };
  const painted = await paint(deps, chatId, normalized, renderScreen(normalized, data, now));
  const visto = normalized.section === "nuovi" && normalized.openItemId === null;
  await store.saveUiState(visto ? { ...painted, lastCheckAt: nowIso } : painted);

  if (notificationId !== null) await tg.deleteMessage(chatId, notificationId);
  if (callback) await tg.answerCallbackQuery(callback.id, toastFor(intent, prefs) ?? undefined);
  return { handled: true };
}
