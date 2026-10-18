import type { ItemRow } from "./types.ts";
import { insegneNominate, isInsegna } from "./config/brands.ts";

/**
 * 🛒 Vado a fare la spesa: cosa conviene comprare in un'insegna.
 *
 * Due elenchi, perché sono due domande diverse:
 *  - **solo qui**: le iniziative dell'insegna (la sua marca, o il testo che la
 *    nomina: "da Esselunga", "nei punti vendita Conad");
 *  - **ovunque**: i concorsi con acquisto e le offerte di una marca di prodotto
 *    che non nominano nessuna insegna — "compra Barilla e vinci" vale in
 *    qualunque supermercato. Chi nomina un'altra insegna resta fuori: non vale qui.
 *
 * Il testo è la prova che c'è; quello che manca (un bando che limita le insegne
 * solo nel PDF) non si inventa, e la schermata lo dice.
 */

function testoDi(item: ItemRow): string {
  return `${item.title} ${item.summary} ${item.url}`;
}

/** true se l'item è un'iniziativa di questa insegna. */
export function isSoloQui(item: ItemRow, insegna: string): boolean {
  return item.brand === insegna || insegneNominate(testoDi(item)).includes(insegna);
}

/** true se l'item si compra in qualunque supermercato. */
export function isOvunque(item: ItemRow): boolean {
  if (item.brand !== null && isInsegna(item.brand)) return false;
  if (item.kind === "contest" && !item.requiresPurchase) return false;
  return insegneNominate(testoDi(item)).length === 0;
}

/** Dal punteggio più alto: in cima quello che vale di più adesso. */
function perPunteggio(items: ItemRow[]): ItemRow[] {
  return [...items].sort((a, b) => b.score - a.score || a.id - b.id);
}

export function soloQui(items: ItemRow[], insegna: string): ItemRow[] {
  return perPunteggio(items.filter((item) => isSoloQui(item, insegna)));
}

export function ovunque(items: ItemRow[]): ItemRow[] {
  return perPunteggio(items.filter(isOvunque));
}

/** Quante iniziative "solo qui" ha ogni insegna: il numero sui bottoni. */
export function contaPerInsegna(items: ItemRow[], insegne: readonly string[]): Record<string, number> {
  return Object.fromEntries(insegne.map((insegna) => [insegna, items.filter((item) => isSoloQui(item, insegna)).length]));
}
