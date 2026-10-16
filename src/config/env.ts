import type { Env } from "../types.ts";

/**
 * Lettura dell'ambiente. Il bot è privato: risponde solo ai chat id in
 * ALLOWED_CHAT_IDS (tu e chi vuoi tu). Il primo id è l'admin, che riceve anche
 * gli avvisi di sistema (fonte in errore, esecuzioni anomale).
 */

export interface ChatAccess {
  /** Chi riceve gli avvisi di sistema. */
  adminChatId: number | null;
  /** Tutti gli id autorizzati a usare il bot, in ordine di dichiarazione. */
  allowed: number[];
}

/** "123, 456 789" → [123, 456, 789], scartando il rumore. */
export function parseChatIds(value: string | null | undefined): number[] {
  if (!value) return [];
  const ids = value
    .split(/[\s,;]+/)
    .map((chunk) => Number.parseInt(chunk.trim(), 10))
    .filter((id) => Number.isSafeInteger(id) && id !== 0);
  return [...new Set(ids)];
}

export function chatAccess(env: Pick<Env, "ADMIN_CHAT_ID" | "ALLOWED_CHAT_IDS">): ChatAccess {
  const allowed = parseChatIds(env.ALLOWED_CHAT_IDS);
  const declaredAdmin = parseChatIds(env.ADMIN_CHAT_ID);
  const adminChatId = declaredAdmin[0] ?? allowed[0] ?? null;
  if (adminChatId !== null && !allowed.includes(adminChatId)) allowed.unshift(adminChatId);
  return { adminChatId, allowed };
}

/** Variabili mancanti: serve per fallire in modo leggibile invece che a metà esecuzione. */
export function missingBindings(env: Partial<Env>): string[] {
  const missing: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!env.WEBHOOK_SECRET) missing.push("WEBHOOK_SECRET");
  if (!env.DB) missing.push("DB (binding D1)");
  if (chatAccess(env as Pick<Env, "ADMIN_CHAT_ID" | "ALLOWED_CHAT_IDS">).allowed.length === 0) {
    missing.push("ALLOWED_CHAT_IDS");
  }
  return missing;
}
