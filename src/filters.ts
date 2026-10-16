import { SOURCES } from "./config/sources.ts";
import { brandLabel, isBrandId } from "./config/brands.ts";
import type { Category, ChatFilters, ItemKind, ItemQuery } from "./types.ts";

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
 *
 * L'unica eccezione sono le marche seguite (⭐ Preferiti per marca), e la
 * differenza è voluta: accendere una marca non toglie niente a nessuno — aggiunge
 * un punteggio più alto e la sua sezione — mentre è `brandsOnly` a nascondere il
 * resto, e quello è un filtro come gli altri.
 */

export const DEFAULT_FILTERS: ChatFilters = {
  favoriteBrands: [],
  brandsOnly: false,
  mutedSources: [],
  mutedCategories: [],
  mutedTags: [],
  freeOnly: false,
  minScore: 0,
};

/** Copia nuova dei filtri di default: nessuno può mutare la costante. */
export function defaultFilters(): ChatFilters {
  return {
    favoriteBrands: [],
    brandsOnly: false,
    mutedSources: [],
    mutedCategories: [],
    mutedTags: [],
    freeOnly: false,
    minScore: 0,
  };
}

/**
 * Le soglie di stelle offerte in elenco: poche e tonde, perché un filtro da
 * toccare mentre si scorre deve stare in una riga sola. 0 = tutte.
 */
export const STAR_CHOICES = [0, 70, 80];

export function starLabel(soglia: number): string {
  return soglia === 0 ? "⭐ Tutte" : `⭐ ${soglia}+`;
}

/** Ordine in cui i filtri si mostrano: prima i concorsi, poi le offerte, poi il resto. */
export const CATEGORY_ORDER: Category[] = ["online", "punto_vendita", "scontrino", "giftcard", "coupon", "altro"];

export const CATEGORY_LABELS: Record<Category, string> = {
  online: "🌐 Online",
  punto_vendita: "🏬 Punto vendita",
  scontrino: "🧾 Scontrino",
  giftcard: "💳 Gift card",
  // Le fonti di coupon: spegnere questa categoria toglie di mezzo 💶 Coupon e
  // rimborsi, e nient'altro (i concorsi di quelle insegne arrivano da altrove).
  coupon: "💶 Coupon e rimborsi",
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

/**
 * Un tipo di premio che si apre come SEZIONE dal menù (🎁 Tipi di premio).
 *
 * Non è un filtro da accendere: i filtri di 🎛 Cosa vedi sono esclusioni, restano
 * accese e cambiano tutte le sezioni. Queste sono domande secche — "che premio
 * cerchi?" — quindi la sezione che aprono filtra in INCLUSIONE sul tag
 * (`tags` nella query) e non tocca le preferenze di nessuno.
 */
export interface PrizeQuickFilter {
  /** Tag dell'item. null solo per 🆓 Gratis, che non è un tag ma l'obbligo d'acquisto. */
  tag: string | null;
  /** Sezione che apre il bottone ("premi:giftcard"). */
  section: string;
  emoji: string;
  /** Nome senza emoji: serve anche dentro una frase ("Nessun concorso con …"). */
  label: string;
}

/**
 * L'ordine è quello dei bottoni, e i tag sono quelli che le regole assegnano
 * leggendo premio e testo (src/enrich/rules.ts).
 *
 * 🆓 Gratis sta in mezzo agli altri perché la domanda è la stessa ("che cosa
 * cerchi?"), ma non è un tipo di premio: apre la sezione che il menù ha già,
 * con il vincolo sull'obbligo di acquisto. Duplicarla qui vorrebbe dire due
 * query e due testi da tenere allineati per lo stesso elenco.
 */
/**
 * 📚 Archivio: i tre tipi in cui si può restringere l'archivio completo, uno per
 * riga dei bottoni. `archivio:<kind>` è una sezione come `premi:<tag>` — un
 * prefisso nella sezione, nessuna preferenza toccata — e la validazione del
 * tipo evita che una sezione inventata legga tutto per sbaglio (vedi
 * isKnownSection).
 */
export interface ArchivioKind {
  kind: ItemKind;
  /** Sezione che apre il bottone ("archivio:coupon"). */
  section: string;
  emoji: string;
  label: string;
}

export const ARCHIVIO_KINDS: ArchivioKind[] = [
  { kind: "contest", section: "archivio:contest", emoji: "🎁", label: "Concorsi" },
  { kind: "coupon", section: "archivio:coupon", emoji: "💶", label: "Coupon" },
  { kind: "news", section: "archivio:news", emoji: "📰", label: "Articoli" },
];

/** Il tipo di questa sezione dell'archivio, oppure null se è l'archivio intero. */
export function archivioKindFor(section: string): ItemKind | null {
  return ARCHIVIO_KINDS.find((voce) => voce.section === section)?.kind ?? null;
}

export const PRIZE_QUICK_FILTERS: PrizeQuickFilter[] = [
  { tag: "giftcard", section: "premi:giftcard", emoji: "💳", label: "Gift card" },
  { tag: "auto", section: "premi:auto", emoji: "🚗", label: "Auto e moto" },
  { tag: "viaggio", section: "premi:viaggio", emoji: "✈️", label: "Viaggi" },
  { tag: "buoni_spesa", section: "premi:buoni_spesa", emoji: "🛒", label: "Buoni spesa" },
  { tag: null, section: "gratis", emoji: "🆓", label: "Gratis" },
];

/** Il tipo di premio di questa sezione, oppure null se non è una di quelle porte. */
export function prizeFilterFor(section: string): PrizeQuickFilter | null {
  return PRIZE_QUICK_FILTERS.find((entry) => entry.section === section) ?? null;
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

/**
 * Quanti filtri sono accesi: è il numero che l'interfaccia mostra sul bottone.
 * Le marche seguite contano solo se il filtro "solo queste marche" è acceso: la
 * lista dei preferiti da sola non nasconde niente, e contarli direbbe all'utente
 * che sta perdendo qualcosa quando non è vero.
 */
export function activeFilterCount(filters: ChatFilters): number {
  return (
    (onlyFavoriteBrands(filters) ? 1 : 0) +
    filters.mutedSources.length +
    filters.mutedCategories.length +
    filters.mutedTags.length +
    (filters.freeOnly ? 1 : 0) +
    (filters.minScore > 0 ? 1 : 0)
  );
}

/**
 * true quando il filtro "solo le marche che seguo" è davvero operante: acceso e
 * con almeno una marca da seguire. Senza marche non filtra niente, e trattarlo
 * come un filtro attivo farebbe mentire il numero del bottone.
 */
export function onlyFavoriteBrands(filters: ChatFilters): boolean {
  return filters.brandsOnly && filters.favoriteBrands.length > 0;
}

/** true quando la chat vede tutto: serve a non scrivere "filtri attivi" per niente. */
export function isSeeingAll(filters: ChatFilters): boolean {
  return (
    !onlyFavoriteBrands(filters) &&
    filters.mutedSources.length === 0 &&
    filters.mutedCategories.length === 0 &&
    filters.mutedTags.length === 0 &&
    !filters.freeOnly &&
    filters.minScore === 0
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
  if (onlyFavoriteBrands(filters)) {
    risultato.brands = [...filters.favoriteBrands];
  }
  if (sources.length > 0) {
    risultato.excludeSources = [...(query.excludeSources ?? []), ...sources];
  }
  if (filters.mutedTags.length > 0) {
    risultato.excludeTags = [...(query.excludeTags ?? []), ...filters.mutedTags];
  }
  if (filters.freeOnly) risultato.withoutPurchase = true;
  // Le stelle minime si sommano a quelle che la query già chiedeva (una soglia
  // più alta vince: nessuna sezione chiede mai meno di quello che hai scelto).
  if (filters.minScore > 0) risultato.minScore = Math.max(query.minScore ?? 0, filters.minScore);
  return risultato;
}

/** Cosa ha toccato l'utente nelle impostazioni: un filtro, o il ritorno a tutto. */
export type FilterChange =
  | { kind: "source"; value: string }
  | { kind: "category"; value: Category }
  | { kind: "tag"; value: string }
  | { kind: "free"; value: boolean }
  | { kind: "star"; value: number }
  /** Una marca del registro che si accende o si spegne nell'elenco dei preferiti. */
  | { kind: "brand"; value: string }
  | { kind: "brandsOnly"; value: boolean }
  | { kind: "brandsReset" }
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
    case "star":
      return { ...filters, minScore: STAR_CHOICES.includes(change.value) ? change.value : 0 };
    case "brand":
      return { ...filters, favoriteBrands: toggled(filters.favoriteBrands, change.value) };
    case "brandsOnly":
      return { ...filters, brandsOnly: change.value };
    // Svuotare i preferiti spegne anche il filtro: lasciarlo acceso senza marche
    // non filtrerebbe niente, ma resterebbe scritto che c'è un filtro.
    case "brandsReset":
      return { ...filters, favoriteBrands: [], brandsOnly: false };
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
    case "star":
      return change.value === 0 ? "⭐ Tutti i punteggi" : `⭐ Solo da ${change.value} in su`;
    case "brand":
      return filters.favoriteBrands.includes(change.value)
        ? `🏷 Segui ${brandLabel(change.value)}`
        : `🏷 Non segui più ${brandLabel(change.value)}`;
    case "brandsOnly":
      return change.value ? "🏷 Solo le marche che seguo" : "🏷 Anche le altre marche";
    case "brandsReset":
      return "🧹 Elenco marche svuotato";
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
  const stelle = typeof record.minScore === "number" && Number.isFinite(record.minScore) ? Math.trunc(record.minScore) : 0;
  return {
    // Una marca uscita dal registro si legge come "non seguita": tenerla in
    // elenco farebbe filtrare `brandsOnly` su un id che non esiste più, cioè su
    // niente.
    favoriteBrands: stringList(record.favoriteBrands, isBrandId),
    brandsOnly: record.brandsOnly === true,
    mutedSources: stringList(record.mutedSources),
    mutedCategories: categorie,
    mutedTags: stringList(record.mutedTags),
    freeOnly: record.freeOnly === true,
    minScore: stelle >= 0 && stelle <= 100 ? stelle : 0,
  };
}
