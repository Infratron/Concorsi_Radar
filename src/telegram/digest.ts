import type { Store } from "../db/store.ts";
import type { ItemRow, Prefs } from "../types.ts";
import type { TelegramClient } from "./api.ts";
import { daysLeft, formatDigest, formatItemCard, localHour, type DigestSection } from "./format.ts";
import { digestKeyboard, instantKeyboard } from "./keyboard.ts";
import { staleItemReason } from "../enrich/freshness.ts";

/**
 * Digest programmati e avvisi istantanei.
 * Regola d'oro: mai un messaggio vuoto, mai lo stesso concorso due volte,
 * mai più di un avviso istantaneo ogni 20 minuti.
 */

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
  const haystack = `${item.summary} ${item.participation ?? ""}`;
  const match = /https?:\/\/[^\s"'<>)]*regolament[^\s"'<>)]*/i.exec(haystack);
  if (!match) return null;
  const url = match[0].replace(/[.,;]+$/, "");
  return url === item.url ? null : url;
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
    const candidates = await store.queryItems({
      since,
      limit: 60,
      orderBy: "score",
    });
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

    const candidates = await store.queryItems({
      minScore: prefs.minScoreInstant,
      orderBy: "score",
      limit: 5,
    });

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
