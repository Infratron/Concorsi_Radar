import type { ChatFilters, ItemQuery, ItemRow } from "./types.ts";
import type { Store } from "./db/store.ts";
import { DAILY_PLAY_TAG } from "./enrich/rules.ts";
import { filtersFor } from "./filters.ts";
import { localDateString } from "./telegram/format.ts";

/**
 * 🎯 Il giro di oggi: i concorsi che si giocano ogni giorno, con ✅ Giocato che
 * riparte a mezzanotte (ora italiana). Qui c'è solo la parte pura — l'ordine
 * dell'elenco e la serie di giorni di fila — così si prova senza database.
 */

/**
 * I concorsi del giro: quelli che si giocano ogni giorno, ancora aperti. I filtri
 * della chat valgono (una fonte o una marca spenta resta spenta), le stelle no:
 * il giro è una routine da fare tutta, non una classifica da tagliare.
 */
export function giroQuery(filters: ChatFilters, now: Date): ItemQuery {
  return filtersFor(
    { ...filters, minScore: 0 },
    {
      kinds: ["contest"],
      statuses: ["new", "sent"],
      tags: [DAILY_PLAY_TAG],
      deadlineNotBefore: localDateString(now),
      orderBy: "score",
    },
  );
}

/** Quanti concorsi del giro si caricano al massimo: oggi sono una ventina. */
export const GIRO_MAX = 200;

/**
 * I concorsi del giro di QUESTA chat: quelli scartati con 🚫 escono, ed è il modo
 * di togliere dal giro un gioco che non interessa (o un instant win che in realtà
 * si gioca una volta sola).
 */
export async function giroItems(store: Store, chatId: number, filters: ChatFilters, now: Date): Promise<ItemRow[]> {
  const [giro, scartati] = await Promise.all([
    store.queryItems({ ...giroQuery(filters, now), limit: GIRO_MAX }),
    store.listDeliveredItems(chatId, "ignored", GIRO_MAX),
  ]);
  const fuori = new Set(scartati.map((item) => item.id));
  return giro.filter((item) => !fuori.has(item.id));
}

/** Le ore che si possono scegliere per il promemoria del mattino. */
export const GIRO_HOURS = [7, 8, 9] as const;

/** true se l'ora è una di quelle offerte: è la validazione del callback_data. */
export function isGiroHour(value: number): boolean {
  return (GIRO_HOURS as readonly number[]).includes(value);
}

/**
 * Prima quelli ancora da fare (dal punteggio più alto), poi quelli già giocati:
 * l'elenco si accorcia mentre lo si fa, e quello che resta è sempre in cima.
 */
export function giroOrder(items: ItemRow[], played: ReadonlySet<number>): ItemRow[] {
  return [...items].sort(
    (a, b) => Number(played.has(a.id)) - Number(played.has(b.id)) || b.score - a.score || a.id - b.id,
  );
}

/** Il giorno prima di `day` (YYYY-MM-DD), senza fusi: è una data di calendario. */
function giornoPrima(day: string): string {
  const [anno, mese, giorno] = day.split("-").map(Number);
  return new Date(Date.UTC(anno, mese - 1, giorno - 1)).toISOString().slice(0, 10);
}

/** Fin dove si guarda indietro per la serie: oltre un anno il numero smette di contare. */
export const STREAK_WINDOW_DAYS = 400;

/** Il primo giorno da leggere per la serie che arriva a `today`. */
export function streakWindowStart(today: string): string {
  const [anno, mese, giorno] = today.split("-").map(Number);
  return new Date(Date.UTC(anno, mese - 1, giorno - STREAK_WINDOW_DAYS)).toISOString().slice(0, 10);
}

/**
 * Quanti giorni di fila, fino a oggi, con almeno una giocata. Se oggi non hai
 * ancora giocato la serie di ieri è ancora viva (si chiude a mezzanotte, non
 * all'alba): si conta da ieri. `days` sono giorni distinti, in qualunque ordine.
 */
export function streakFrom(days: readonly string[], today: string): number {
  const giocati = new Set(days);
  let giorno = giocati.has(today) ? today : giornoPrima(today);
  let serie = 0;
  while (giocati.has(giorno)) {
    serie++;
    giorno = giornoPrima(giorno);
  }
  return serie;
}
