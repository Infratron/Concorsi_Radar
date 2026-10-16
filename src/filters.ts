import { SOURCES } from "./config/sources.ts";
import type { Category, ChatFilters, ItemQuery } from "./types.ts";

/**
 * I filtri di una chat, in un punto solo.
 *
 * Perché un modulo a parte: lo stesso filtro deve valere nelle sezioni della
 * chat, nei digest e negli avvisi istantanei. Se ognuno dei tre posti
 * traducesse `ChatFilters` a modo suo, il giorno dopo il filtro varrebbe in due
 * posti su tre — e la cosa si nota solo quando arriva la notifica che non
 * volevi. Qui c'è la traduzione, e c'è una funzione sola che la fa.
 *
 * Sono tutti elenchi di ESCLUSIONI: una fonte o un tipo nuovi sono visibili a
 * tutti finché qualcuno non li spegne. Con l'elenco inverso (inclusioni) una
 * fonte aggiunta oggi resterebbe invisibile a chi non la conosce.
 */

export const DEFAULT_FILTERS: ChatFilters = {
  mutedSources: [],
  mutedCategories: [],
  mutedTags: [],
  freeOnly: false,
};

/** Copia nuova dei filtri di default: nessuno può mutare la costante. */
export function defaultFilters(): ChatFilters {
  return { mutedSources: [], mutedCategories: [], mutedTags: [], freeOnly: false };
}

/** Ordine in cui i filtri si mostrano: dal più ampio al più specifico. */
export const CATEGORY_ORDER: Category[] = ["online", "punto_vendita", "scontrino", "giftcard", "altro"];

export const CATEGORY_LABELS: Record<Category, string> = {
  online: "🌐 Online",
  punto_vendita: "🏬 Punto vendita",
  scontrino: "🧾 Scontrino",
  giftcard: "💳 Gift card",
  altro: "📦 Altro",
};

/**
 * Tipi di concorso che si possono spegnere. Sono i tag degli item — quelli che
 * src/enrich/rules.ts assegna leggendo premio e testo — quindi la scelta è
 * limitata a quelli che parlano davvero di *che tipo di concorso è*: la marca
 * ("eni", "ferrero") o il meccanismo di raccolta ("sitemap") non sono un tipo.
 */
export const TAG_FILTERS: { tag: string; label: string }[] = [
  { tag: "raccolta_punti", label: "🏪 Raccolte punti" },
  { tag: "premio_certo", label: "🎁 Premio certo" },
  { tag: "giftcard", label: "💳 Gift card" },
  { tag: "viaggio", label: "✈️ Viaggi" },
  { tag: "elettronica", label: "📱 Elettronica" },
  { tag: "casa", label: "🏠 Casa" },
  { tag: "food", label: "🍝 Food" },
  { tag: "moda", label: "👗 Moda" },
  { tag: "bambini", label: "🧸 Bambini" },
];

export function tagLabel(tag: string): string {
  return TAG_FILTERS.find((entry) => entry.tag === tag)?.label ?? tag;
}

/** Categorie davvero presenti fra le fonti accese: filtrare un tipo che non esiste è rumore. */
export function categoriesToOffer(): Category[] {
  const usate = new Set<Category>();
  for (const source of SOURCES) if (source.enabled) usate.add(source.category);
  return CATEGORY_ORDER.filter((category) => usate.has(category));
}

/** Una fonte che la chat può spegnere: solo quelle accese in configurazione. */
export interface FilterSource {
  id: string;
  name: string;
  category: Category;
}

export function filterableSources(): FilterSource[] {
  return SOURCES.filter((source) => source.enabled).map((source) => ({
    id: source.id,
    name: source.name,
    category: source.category,
  }));
}

/**
 * Fonti che la chat non vuole vedere: quelle spente una per una, più tutte
 * quelle delle categorie spente. Si risolve dalla configurazione — le categorie
 * vivono lì, non sugli item — così il filtro per categoria vale anche per gli
 * item arrivati prima che la fonte esistesse.
 */
export function mutedSourceIds(filters: ChatFilters): string[] {
  const spenti = new Set(filters.mutedSources);
  for (const source of SOURCES) {
    if (filters.mutedCategories.includes(source.category)) spenti.add(source.id);
  }
  return [...spenti];
}

/** Quanti filtri sono accesi: è il numero che l'interfaccia mostra sul bottone. */
export function activeFilterCount(filters: ChatFilters): number {
  return (
    filters.mutedSources.length +
    filters.mutedCategories.length +
    filters.mutedTags.length +
    (filters.freeOnly ? 1 : 0)
  );
}

/** true quando la chat vede tutto: serve a non scrivere "filtri attivi" per niente. */
export function isSeeingAll(filters: ChatFilters): boolean {
  return (
    filters.mutedSources.length === 0 &&
    filters.mutedCategories.length === 0 &&
    filters.mutedTags.length === 0 &&
    !filters.freeOnly
  );
}

/**
 * Applica i filtri a una query. Va chiamata OVUNQUE si legga l'archivio per una
 * chat — sezioni, menù, digest, avvisi — altrimenti il filtro esiste in un posto
 * e non nell'altro.
 *
 * Non si applica invece a tre letture che sono per definizione una scelta
 * esplicita dell'utente: ⭐ Watchlist (l'hai salvato tu), 🗂 Storico (le tue
 * decisioni) e 🔍 Cerca (hai scritto tu cosa cercare).
 */
export function filtersFor(filters: ChatFilters, query: ItemQuery = {}): ItemQuery {
  const sources = mutedSourceIds(filters);
  const risultato: ItemQuery = { ...query };
  if (sources.length > 0) {
    risultato.excludeSources = [...(query.excludeSources ?? []), ...sources];
  }
  if (filters.mutedTags.length > 0) {
    risultato.excludeTags = [...(query.excludeTags ?? []), ...filters.mutedTags];
  }
  if (filters.freeOnly) risultato.withoutPurchase = true;
  return risultato;
}

/** Cosa ha toccato l'utente nelle impostazioni: un filtro, o il ritorno a tutto. */
export type FilterChange =
  | { kind: "source"; value: string }
  | { kind: "category"; value: Category }
  | { kind: "tag"; value: string }
  | { kind: "free"; value: boolean }
  | { kind: "reset" };

function toggled<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

/** Applica un tocco ai filtri. È pura: chi la chiama decide dove salvarli. */
export function withFilterChange(filters: ChatFilters, change: FilterChange): ChatFilters {
  switch (change.kind) {
    case "source":
      return { ...filters, mutedSources: toggled(filters.mutedSources, change.value) };
    case "category":
      return { ...filters, mutedCategories: toggled(filters.mutedCategories, change.value) };
    case "tag":
      return { ...filters, mutedTags: toggled(filters.mutedTags, change.value) };
    case "free":
      return { ...filters, freeOnly: change.value };
    case "reset":
      return defaultFilters();
  }
}

/** Etichetta di conferma del tocco, per il messaggio in sovraimpressione. */
export function filterChangeLabel(filters: ChatFilters, change: FilterChange, nameFor: (value: string) => string): string {
  switch (change.kind) {
    case "source":
      return filters.mutedSources.includes(change.value) ? `🚫 ${nameFor(change.value)}` : `✅ ${nameFor(change.value)}`;
    case "category":
      return filters.mutedCategories.includes(change.value as Category)
        ? `🚫 ${CATEGORY_LABELS[change.value as Category]}`
        : `✅ ${CATEGORY_LABELS[change.value as Category]}`;
    case "tag":
      return filters.mutedTags.includes(change.value) ? `🚫 ${tagLabel(change.value)}` : `✅ ${tagLabel(change.value)}`;
    case "free":
      return change.value ? "🎁 Solo senza acquisto" : "🎁 Anche con acquisto";
    case "reset":
      return "♻️ Vedi di nuovo tutto";
  }
}

function stringList(value: unknown, allowed?: (entry: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  const risultato: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 80) continue;
    if (allowed && !allowed(entry)) continue;
    if (!risultato.includes(entry)) risultato.push(entry);
  }
  return risultato;
}

/**
 * Filtri letti da una colonna JSON del database. Un valore rovinato non deve
 * rompere il bot: al massimo si torna a vedere tutto.
 */
export function parseFilters(raw: unknown): ChatFilters {
  let valore: unknown = raw;
  if (typeof raw === "string") {
    try {
      valore = JSON.parse(raw);
    } catch {
      return defaultFilters();
    }
  }
  if (valore === null || typeof valore !== "object") return defaultFilters();
  const record = valore as Record<string, unknown>;
  const categorie = stringList(record.mutedCategories).filter((category): category is Category =>
    CATEGORY_ORDER.includes(category as Category),
  );
  return {
    mutedSources: stringList(record.mutedSources),
    mutedCategories: categorie,
    mutedTags: stringList(record.mutedTags),
    freeOnly: record.freeOnly === true,
  };
}
