import { localHour } from "./telegram/format.ts";

/**
 * Pianificazione: sta in un modulo separato perché tutto ciò che è esportato
 * dal file di entry (src/index.ts) viene interpretato da workerd come un
 * entry point del Worker — una costante esportata lì fa fallire l'avvio.
 */

/** Cron dei digest, come dichiarati in wrangler.toml. */
export const DIGEST_CRONS = ["5 6 * * *", "5 17 * * *"];
/** Cron dell'ingestione a rotazione. */
export const INGEST_CRON = "*/15 * * * *";

/**
 * Finestra del digest con tolleranza di un'ora: il cron è in UTC, quindi in ora
 * legale italiana cade alle 8/19 e in ora solare alle 7/18.
 */
export function isDigestWindow(now: Date, hours: number[]): boolean {
  const hour = localHour(now);
  return hours.some((candidate) => Math.abs(hour - candidate) <= 1);
}

/** Quale lavoro tocca a questo giro di cron. */
export function jobFor(cron: string, now: Date, digestHours: number[]): "digest" | "ingest" {
  if (DIGEST_CRONS.includes(cron)) return "digest";
  if (cron !== INGEST_CRON && isDigestWindow(now, digestHours)) return "digest";
  return "ingest";
}
