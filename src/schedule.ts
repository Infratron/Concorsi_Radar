import type { RunRow } from "./types.ts";
import { localHour } from "./telegram/format.ts";

/**
 * Pianificazione: sta in un modulo separato perché tutto ciò che è esportato
 * dal file di entry (src/index.ts) viene interpretato da workerd come un
 * entry point del Worker — una costante esportata lì fa fallire l'avvio.
 */

/** Cron dei digest, come dichiarati in wrangler.toml. */
export const DIGEST_CRONS = ["5 6 * * *", "5 17 * * *"];
/**
 * Cron dei 15 minuti: avvisi istantanei e pulizia dell'archivio. La raccolta
 * dei feed non è più qui — la fa GitHub Actions, dalla cui rete le fonti
 * bloccate verso Cloudflare rispondono 200.
 */
export const NOTIFY_CRON = "*/15 * * * *";

/**
 * Finestra del digest con tolleranza di un'ora: il cron è in UTC, quindi in ora
 * legale italiana cade alle 8/19 e in ora solare alle 7/18.
 */
export function isDigestWindow(now: Date, hours: number[]): boolean {
  const hour = localHour(now);
  return hours.some((candidate) => Math.abs(hour - candidate) <= 1);
}

/** Quale lavoro tocca a questo giro di cron. */
export function jobFor(cron: string, now: Date, digestHours: number[]): "digest" | "notify" {
  if (DIGEST_CRONS.includes(cron)) return "digest";
  if (cron !== NOTIFY_CRON && isDigestWindow(now, digestHours)) return "digest";
  return "notify";
}

/**
 * La raccolta su GitHub Actions gira ogni 30 minuti: se tace per più di due ore
 * (secret scaduto, workflow disattivato per inattività, GitHub in tilt) il
 * Worker torna a raccogliere quel poco che la sua rete raggiunge, invece di
 * lasciare il radar muto senza che nessuno se ne accorga. È una rete di
 * sicurezza, non la via normale: la rete di Cloudflare è bloccata da diverse
 * fonti, quindi da qui passano poche fonti.
 */
export const FALLBACK_INGEST_AFTER_MS = 2 * 60 * 60 * 1000;

/** true se nessuna esecuzione della raccolta (trigger "actions") è recente. */
export function shouldFallbackIngest(runs: RunRow[], now: Date): boolean {
  const ultima = runs.find((run) => run.trigger === "actions");
  if (!ultima) return true;
  const at = Date.parse(ultima.startedAt);
  return !Number.isFinite(at) || now.getTime() - at > FALLBACK_INGEST_AFTER_MS;
}
