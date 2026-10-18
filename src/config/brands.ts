import { tokens } from "../lib/text.ts";
import { SOURCES } from "./sources.ts";

/**
 * Le marche che si possono seguire (⭐ Marche seguite).
 *
 * Perché un registro a parte e non l'elenco dei tag degli item: il tag dice da
 * dove arriva un concorso, la marca dice DI CHI è. Le due cose non coincidono —
 * la sitemap di Conad porta anche i bollini di altre insegne, e un concorso
 * Kinder ripreso da un aggregatore non ha nessun tag "ferrero" addosso. Qui
 * invece la marca si riconosce in due modi, e valgono tutti e due:
 *
 *  1. dalla FONTE: i tag di src/config/sources.ts contengono già lo slug della
 *     marca ("ferrero", "conad", "cocacola"…), e per le fonti di marca quel tag
 *     è la risposta giusta — la pagina di un brand non sempre nomina se stessa
 *     nell'URL ("/promozioni/…").
 *  2. dal TESTO (titolo, sommario e URL) quando la fonte è un aggregatore o una
 *     query di news: "Concorso Nutella" è Ferrero anche se arriva da
 *     Premi e Concorsi.
 *
 * Le parole sono confrontate come TOKEN interi e senza diacritici, non come
 * sottostringhe: "aia" non deve riconoscere "baia" né "ghiaia", e "coca cola" e
 * "coca-cola" sono la stessa cosa. Le sotto-marche stanno dentro la marca che le
 * possiede (kinder e nutella → ferrero): chi segue Ferrero vuole anche quelle.
 */
export interface Brand {
  /** Slug: è l'id salvato nei filtri della chat, quindi non cambia una volta usato. */
  id: string;
  /** Nome mostrato nei bottoni. */
  label: string;
  /**
   * Parole che nominano la marca. Ogni voce è un gruppo di token che devono
   * essere presenti TUTTI (per "coca cola" servono "coca" e "cola").
   */
  words: string[];
}

export const BRANDS: Brand[] = [
  { id: "ferrero", label: "Ferrero", words: ["ferrero", "kinder", "nutella", "rocher", "estathe", "tic tac"] },
  { id: "barilla", label: "Barilla", words: ["barilla"] },
  { id: "mulinobianco", label: "Mulino Bianco", words: ["mulino bianco"] },
  { id: "lavazza", label: "Lavazza", words: ["lavazza"] },
  { id: "cocacola", label: "Coca-Cola", words: ["coca cola", "fanta", "sprite"] },
  { id: "sanpellegrino", label: "San Pellegrino", words: ["san pellegrino"] },
  { id: "levissima", label: "Levissima", words: ["levissima"] },
  { id: "parmalat", label: "Parmalat", words: ["parmalat"] },
  { id: "granarolo", label: "Granarolo", words: ["granarolo"] },
  { id: "galbani", label: "Galbani", words: ["galbani"] },
  { id: "riomare", label: "Rio Mare", words: ["rio mare"] },
  // AIA si riconosce dal dominio invece che dal nome: "aia" in italiano è una
  // parola comune (l'aia della fattoria), e un concorso che parla di un'aia non è
  // di AIA. La parola "aiafood" c'è in tutti i suoi URL, quindi la marca si
  // riconosce lo stesso — anche su una copia arrivata da un aggregatore.
  { id: "aia", label: "AIA", words: ["aiafood"] },
  { id: "findus", label: "Findus", words: ["findus"] },
  { id: "sammontana", label: "Sammontana", words: ["sammontana"] },
  { id: "bauli", label: "Bauli", words: ["bauli"] },
  { id: "maina", label: "Maina", words: ["maina"] },
  { id: "perugina", label: "Perugina", words: ["perugina"] },
  { id: "conad", label: "Conad", words: ["conad"] },
  { id: "esselunga", label: "Esselunga", words: ["esselunga"] },
  { id: "coop", label: "Coop", words: ["coop"] },
  { id: "eurospin", label: "Eurospin", words: ["eurospin"] },
  { id: "penny", label: "Penny", words: ["penny"] },
  { id: "lidl", label: "Lidl", words: ["lidl"] },
  { id: "carrefour", label: "Carrefour", words: ["carrefour"] },
  { id: "bennet", label: "Bennet", words: ["bennet"] },
  { id: "eni", label: "Eni", words: ["eni"] },
  { id: "payback", label: "PAYBACK", words: ["payback"] },
  { id: "burgerking", label: "Burger King", words: ["burger king"] },
  { id: "samsung", label: "Samsung", words: ["samsung"] },
  { id: "mediaworld", label: "MediaWorld", words: ["mediaworld", "media world"] },
  { id: "unieuro", label: "UniEuro", words: ["unieuro"] },
  { id: "decathlon", label: "Decathlon", words: ["decathlon"] },
  { id: "pampers", label: "Pampers", words: ["pampers"] },
  { id: "nivea", label: "Nivea", words: ["nivea"] },
  { id: "pizzahut", label: "Pizza Hut", words: ["pizza hut"] },
];

const BY_ID = new Map<string, Brand>(BRANDS.map((brand) => [brand.id, brand]));

/**
 * Fonte → marca, ricavata dai tag di configurazione: così la marca di una fonte
 * di brand si dichiara in un posto solo (src/config/sources.ts) e non c'è una
 * seconda lista da tenere allineata.
 */
const SOURCE_BRAND = new Map<string, string>();
for (const source of SOURCES) {
  const tag = source.tags.find((entry) => BY_ID.has(entry));
  if (tag) SOURCE_BRAND.set(source.id, tag);
}

/** Una voce per OGNI parola di OGNI marca, con i token già normalizzati. */
const WORD_INDEX: { id: string; tokens: string[] }[] = BRANDS.flatMap((brand) =>
  brand.words
    .map((word) => tokens(word))
    .filter((gruppo) => gruppo.length > 0)
    .map((gruppo) => ({ id: brand.id, tokens: gruppo })),
);

/**
 * Le insegne dove si fa la spesa: le porte di 🛒 Vado a fare la spesa. Sono un
 * sottoinsieme del registro delle marche, e solo i supermercati: chi apre questa
 * schermata ha in mano la lista della spesa, non il sito di un'elettronica.
 */
export const INSEGNE: readonly string[] = ["esselunga", "conad", "coop", "carrefour", "lidl", "eurospin", "penny", "bennet"];

export function isInsegna(value: string): boolean {
  return INSEGNE.includes(value);
}

/**
 * Le insegne NOMINATE nel testo, anche quando la marca del concorso è un'altra:
 * "Ferrero ti regala... da Esselunga" è di Ferrero ma vale solo da Esselunga.
 * `brandFor` restituisce una marca sola (la prima che trova), quindi qui si
 * guardano tutte.
 */
export function insegneNominate(text: string): string[] {
  const presenti = new Set(tokens(text));
  const trovate = new Set<string>();
  for (const entry of WORD_INDEX) {
    if (isInsegna(entry.id) && entry.tokens.every((token) => presenti.has(token))) trovate.add(entry.id);
  }
  return [...trovate];
}

/** true se lo slug è una marca del registro: è la validazione del callback_data. */
export function isBrandId(value: string): boolean {
  return BY_ID.has(value);
}

/** Nome leggibile di una marca; uno slug sconosciuto resta se stesso. */
export function brandLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/** Tutte le marche del registro, nell'ordine in cui sono scritte qui. */
export function brandIds(): string[] {
  return BRANDS.map((brand) => brand.id);
}

/**
 * La marca di un concorso: prima la fonte, poi il testo. null = non riconosciuta,
 * ed è un'informazione come le altre (una marca che non conosciamo non si
 * inventa, altrimenti le statistiche del registro direbbero bugie).
 */
export function brandFor(input: {
  sourceId: string;
  title?: string;
  summary?: string;
  url?: string;
}): string | null {
  const fromSource = SOURCE_BRAND.get(input.sourceId);
  if (fromSource) return fromSource;

  const testo = `${input.title ?? ""} ${input.summary ?? ""} ${input.url ?? ""}`.trim();
  if (testo.length === 0) return null;
  const presenti = new Set(tokens(testo));
  for (const entry of WORD_INDEX) {
    if (entry.tokens.every((token) => presenti.has(token))) return entry.id;
  }
  return null;
}

/**
 * Ordine delle marche nella schermata: prima quelle che hanno concorsi in
 * archivio (dalla più presente), poi le altre in ordine alfabetico. Il conteggio
 * viene dai dati, non dal registro: una marca senza concorsi è un bottone che si
 * accende e non cambia niente, meglio in fondo.
 */
export function brandOrder(counts: Record<string, number>): string[] {
  return [...BRANDS]
    .sort((a, b) => {
      const diff = (counts[b.id] ?? 0) - (counts[a.id] ?? 0);
      return diff !== 0 ? diff : a.label.localeCompare(b.label, "it");
    })
    .map((brand) => brand.id);
}

/** Una marca come compare nella schermata ⭐ Marche seguite. */
export interface BrandChoice {
  id: string;
  label: string;
  /** Concorsi di questa marca in archivio (0 = nessuno, per ora). */
  count: number;
  /** true se QUESTA chat la segue. */
  followed: boolean;
}

/** Le marche da mostrare, in ordine: quelle con concorsi in cima, le seguite in evidenza. */
export function brandChoices(counts: Record<string, number>, favorites: string[]): BrandChoice[] {
  const seguite = new Set(favorites);
  return brandOrder(counts).map((id) => ({
    id,
    label: brandLabel(id),
    count: counts[id] ?? 0,
    followed: seguite.has(id),
  }));
}
