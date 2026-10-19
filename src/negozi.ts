import type { ItemRow } from "./types.ts";
import { brandLabel, insegneNominate, isNegozio } from "./config/brands.ts";

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
  if (item.brand !== null && isNegozio(item.brand)) return false;
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

/**
 * 🤝 Le accoppiate: la stessa marca con un'offerta (rimborso, cashback, buono)
 * e un concorso con acquisto. Si compra una volta, e lo stesso scontrino può
 * valere due volte — SE i due bandi lo permettono, che è quello che la chat dice
 * di controllare: molti cashback escludono altre promozioni.
 *
 * La marca è quella del registro, quando c'è; altrimenti una parola del titolo
 * con l'iniziale maiuscola presente in tutti e due ("Cashback **Dash** e Fairy",
 * "Concorso **Dash**: vinci un anno di bucato"). Il registro da solo non basta:
 * misurato il 19/10/2026, con la sola marca registrata usciva UNA accoppiata
 * (di Esselunga, che a Lecce non c'è); con le parole del titolo sette vere —
 * Dash, Gillette, Crema Novi, Calgon, Scottex, Scottonelle — e nessuna falsa.
 * Le parole da promozione ("Cashback", "Rimborso"…) e quelle troppo comuni
 * (più di ACCOPPIATE_MAX_FREQ titoli) non contano.
 */
export interface Accoppiata {
  /** Il nome come si legge nel titolo ("Dash", "Crema Novi"). */
  marca: string;
  offerte: ItemRow[];
  concorsi: ItemRow[];
}

/** Una parola presente in più titoli di così è un genere, non una marca. */
export const ACCOPPIATE_MAX_FREQ = 4;

const PAROLE_DA_PROMOZIONE = new Set([
  "cashback", "concorso", "concorsi", "buono", "buoni", "sconto", "coupon", "raccolta", "punti", "rimborso",
  "rimborsi", "edizione", "speciale", "calendario", "avvento", "mese", "premi", "premio", "gift", "card", "vinci",
  "richiedi", "ricevi", "italia", "natale", "estate", "autunno", "inverno", "primavera", "black", "friday",
  "halloween", "amazon", "promo", "promozione", "offerta", "offerte", "euro", "instant", "win", "omaggio",
  "regalo", "gratis", "scontrino", "spesa", "settimana", "festa", "super", "grande", "nuovo", "nuova", "special",
  "day", "club", "family", "plus", "kit", "set", "stampare", "come", "con", "per", "dal", "del", "della",
]);

function chiave(parola: string): string {
  return parola.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Le parole "di marca" di un titolo, con la grafia del titolo. */
function paroleDiMarca(title: string): Map<string, string> {
  const trovate = new Map<string, string>();
  for (const parola of title.split(/[^\p{L}\p{N}&']+/u)) {
    if (parola.length < 3 || !/^\p{Lu}/u.test(parola)) continue;
    const k = chiave(parola);
    if (PAROLE_DA_PROMOZIONE.has(k) || insegneNominate(parola).length > 0) continue;
    if (!trovate.has(k)) trovate.set(k, parola);
  }
  return trovate;
}

export function accoppiate(items: ItemRow[]): Accoppiata[] {
  const candidati = items.filter((item) => item.kind === "coupon" || (item.kind === "contest" && item.requiresPurchase));
  // Per ogni chiave (marca del registro o parola del titolo) gli item che la portano.
  const perChiave = new Map<string, { nome: string; items: ItemRow[] }>();
  const aggiungi = (k: string, nome: string, item: ItemRow): void => {
    const gruppo = perChiave.get(k) ?? { nome, items: [] };
    if (!gruppo.items.includes(item)) gruppo.items.push(item);
    perChiave.set(k, gruppo);
  };
  for (const item of candidati) {
    if (item.brand !== null && !isNegozio(item.brand)) aggiungi(`marca:${item.brand}`, brandLabel(item.brand), item);
    for (const [k, nome] of paroleDiMarca(item.title)) aggiungi(`parola:${k}`, nome, item);
  }

  // Due parole che portano gli stessi item sono la stessa marca scritta in due
  // pezzi ("Crema" e "Novi"): un'accoppiata sola, con il nome intero.
  const perInsieme = new Map<string, Accoppiata & { primo: string }>();
  for (const { nome, items: gruppo } of perChiave.values()) {
    if (gruppo.length > ACCOPPIATE_MAX_FREQ) continue;
    const offerte = gruppo.filter((item) => item.kind === "coupon");
    const concorsi = gruppo.filter((item) => item.kind === "contest");
    if (offerte.length === 0 || concorsi.length === 0) continue;
    const firma = gruppo.map((item) => item.id).sort((a, b) => a - b).join(",");
    const esistente = perInsieme.get(firma);
    if (!esistente) {
      perInsieme.set(firma, { marca: nome, offerte, concorsi, primo: offerte[0].title });
      continue;
    }
    if (esistente.marca.split(" ").includes(nome)) continue;
    // I pezzi del nome nell'ordine in cui il titolo li scrive.
    const pezzi = [...esistente.marca.split(" "), nome];
    pezzi.sort((a, b) => esistente.primo.indexOf(a) - esistente.primo.indexOf(b));
    esistente.marca = pezzi.join(" ");
  }
  return [...perInsieme.values()]
    .map(({ marca, offerte, concorsi }) => ({ marca, offerte, concorsi }))
    .sort((a, b) => b.offerte.length + b.concorsi.length - (a.offerte.length + a.concorsi.length) || a.marca.localeCompare(b.marca, "it"));
}

/** Quante iniziative "solo qui" ha ogni insegna: il numero sui bottoni. */
export function contaPerInsegna(items: ItemRow[], insegne: readonly string[]): Record<string, number> {
  return Object.fromEntries(insegne.map((insegna) => [insegna, items.filter((item) => isSoloQui(item, insegna)).length]));
}
