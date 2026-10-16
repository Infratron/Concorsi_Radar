import type { Prefs } from "../types.ts";

/**
 * Le regole delle impostazioni, in un posto solo.
 *
 * Servono due volte: a chi DISEGNA i bottoni (keyboard.ts, che deve proporre un
 * valore valido) e a chi APPLICA il tocco (bot.ts, che deve rifiutare i valori
 * inventati perché il callback_data arriva dal client). Tenendo qui il calcolo —
 * lo scatto della soglia, il giro della giornata sui cursori della fascia,
 * l'accensione di un'ora — non può succedere che un bottone mostrato sia poi
 * scartato dal router: le due parti usano la stessa funzione.
 */

/** Estremi della soglia degli avvisi immediati (è un punteggio 0-100). */
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;
/** Quanto spostano i ➖ ➕ sulla soglia. */
export const SCORE_STEP = 5;

/**
 * Fascia di silenzio da cui partono i cursori quando il silenzio è spento: se
 * tocchi ➖ ➕ vuoi una fascia, e questa è la solita (la stessa di defaultPrefs).
 */
export const QUIET_FALLBACK = { start: 23, end: 7 } as const;

/** Le ore del giorno che si possono accendere nel digest. */
export const DIGEST_HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => hour);

/** "23-7" → { start: 23, end: 7 }. Null se non è una fascia di ore vere. */
export function parseQuietRange(value: string): { start: number; end: number } | null {
  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  // Ore reali, non solo cifre: "99-99" non è una fascia di silenzio.
  if (start > 23 || end > 23) return null;
  return { start, end };
}

/** La fascia su cui lavorano i cursori: quella salvata, o la solita se è spento. */
export function quietRange(prefs: Prefs): { start: number; end: number } {
  return parseQuietRange(prefs.quietHours) ?? { start: QUIET_FALLBACK.start, end: QUIET_FALLBACK.end };
}

/**
 * Sposta di `delta` ore l'inizio o la fine della fascia, girando sulla giornata
 * (23 + 1 → 0): è così che si allunga una fascia che passa la mezzanotte, che è
 * il caso normale — nessuno mette il silenzio dalle 8 alle 17.
 */
export function shiftQuietRange(
  range: { start: number; end: number },
  which: "start" | "end",
  delta: number,
): string {
  const ore = (hour: number): number => ((hour + delta) % 24 + 24) % 24;
  const start = which === "start" ? ore(range.start) : range.start;
  const end = which === "end" ? ore(range.end) : range.end;
  return `${start}-${end}`;
}

/** Soglia dopo uno scatto, mai fuori da 0-100: ai bordi il bottone diventa inerte. */
export function stepScore(value: number, delta: number): number {
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, value + delta * SCORE_STEP));
}

/**
 * Accende l'ora se era spenta, la spegne se era accesa. L'elenco resta in ordine
 * crescente: lo legge la schermata, e "8, 19, 21" si legge meglio di "21, 8, 19".
 */
export function toggleDigestHour(hours: number[], hour: number): number[] {
  const senza = hours.filter((value) => value !== hour);
  return senza.length === hours.length ? [...senza, hour].sort((a, b) => a - b) : senza;
}

/** "9" → "09:00": nelle righe delle impostazioni le ore si leggono a due cifre. */
export function hourLabel(hour: number): string {
  return `${hourShort(hour)}:00`;
}

/** "9" → "09": nelle griglie di bottoni il ":00" è rumore. */
export function hourShort(hour: number): string {
  return String(hour).padStart(2, "0");
}
