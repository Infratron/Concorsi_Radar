import type { FetchLike } from "../types.ts";

/**
 * Client minimale dell'API Bot Telegram.
 * Nessuna dipendenza: solo fetch. Errori e 429 sono restituiti, mai lanciati,
 * così il chiamante non perde il ciclo (cron) per colpa di un messaggio.
 */

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
  from?: TelegramUser;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
  from?: TelegramUser;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface SendResult {
  ok: boolean;
  messageId: number | null;
  error: string | null;
  retryAfter: number | null;
}

/** Limite tecnico Telegram 4096: teniamo un margine per sicurezza. */
export const MAX_MESSAGE_CHARS = 3800;

export interface SendMessageOptions {
  keyboard?: InlineKeyboardMarkup;
  disablePreview?: boolean;
}

/** Spezza un testo lungo in blocchi ≤ MAX_MESSAGE_CHARS, tagliando sulle righe. */
export function splitMessageText(text: string, max = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current.length > 0) chunks.push(current);
    // Riga singola più lunga del limite: tronco duro, non posso fare altrimenti.
    current = line.length <= max ? line : line.slice(0, max);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export class TelegramClient {
  // Campi dichiarati ed assegnati esplicitamente: le "parameter properties" di
  // TypeScript non sono supportate dal type-stripping di Node, che serve a
  // scripts/dry-run.ts per girare senza build.
  private readonly token: string;
  private readonly fetcher: FetchLike;

  constructor(token: string, fetcher: FetchLike = fetch) {
    this.token = token;
    this.fetcher = fetcher;
  }

  private async call(method: string, payload: unknown): Promise<Record<string, unknown>> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      return { ok: false, description: error instanceof Error ? error.message : String(error) };
    }
  }

  async sendMessage(
    chatId: number,
    text: string,
    opts: SendMessageOptions = {},
  ): Promise<SendResult> {
    const chunks = splitMessageText(text);
    let last: SendResult = { ok: false, messageId: null, error: "nessun contenuto", retryAfter: null };

    for (let index = 0; index < chunks.length; index++) {
      const isLast = index === chunks.length - 1;
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text: chunks[index],
        parse_mode: "HTML",
      };
      if (opts.disablePreview) payload.link_preview_options = { is_disabled: true };
      if (opts.keyboard && isLast) payload.reply_markup = opts.keyboard;
      last = toSendResult(await this.call("sendMessage", payload));
      if (!last.ok) return last;
    }
    return last;
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { keyboard?: InlineKeyboardMarkup } = {},
  ): Promise<SendResult> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    };
    if (opts.keyboard) payload.reply_markup = opts.keyboard;
    return toSendResult(await this.call("editMessageText", payload));
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<SendResult> {
    const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) payload.text = text;
    return toSendResult(await this.call("answerCallbackQuery", payload));
  }

  async setMyCommands(): Promise<SendResult> {
    const commands = [
      { command: "oggi", description: "Concorsi trovati nelle ultime 24 ore" },
      { command: "settimana", description: "Concorsi degli ultimi 7 giorni" },
      { command: "scadenze", description: "Concorsi che scadono entro 7 giorni" },
      { command: "cerca", description: "Cerca per parola chiave" },
      { command: "salva", description: "Salva un concorso per id" },
      { command: "vinto", description: "Segna un concorso come vinto" },
      { command: "ignora", description: "Ignora un concorso per id" },
      { command: "fonti", description: "Stato delle fonti monitorate" },
      { command: "health", description: "Stato delle ultime esecuzioni" },
      { command: "stop", description: "Sospendi le notifiche" },
      { command: "start", description: "Riattiva le notifiche" },
      { command: "help", description: "Elenco dei comandi" },
    ];
    return toSendResult(await this.call("setMyCommands", { commands, language_code: "it" }));
  }

  async setWebhook(url: string, secretToken: string): Promise<SendResult> {
    return toSendResult(
      await this.call("setWebhook", {
        url,
        secret_token: secretToken,
        allowed_updates: ["message", "callback_query"],
        max_connections: 1,
      }),
    );
  }

  async getMe(): Promise<{ ok: boolean; username: string | null }> {
    const data = await this.call("getMe", {});
    const result = data.result;
    const username =
      result && typeof result === "object" && typeof (result as { username?: unknown }).username === "string"
        ? ((result as { username: string }).username)
        : null;
    return { ok: data.ok === true, username };
  }
}

export function toSendResult(data: Record<string, unknown>): SendResult {
  const ok = data.ok === true;
  const description = typeof data.description === "string" ? data.description : null;
  const parameters = data.parameters;
  const retryAfter =
    parameters && typeof parameters === "object" && typeof (parameters as { retry_after?: unknown }).retry_after === "number"
      ? (parameters as { retry_after: number }).retry_after
      : null;
  const result = data.result;
  const messageId =
    result && typeof result === "object" && typeof (result as { message_id?: unknown }).message_id === "number"
      ? (result as { message_id: number }).message_id
      : null;
  return { ok, messageId, error: ok ? null : description ?? "errore API Telegram", retryAfter };
}
