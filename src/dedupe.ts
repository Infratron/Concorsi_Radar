import type { Insight, ItemKind, ItemRow, NewItem, RawItem, SourceKind } from "./types.ts";
import type { Store } from "./db/store.ts";
import { classifyKind } from "./enrich/kind.ts";
import { readableTitle } from "./lib/titles.ts";
import {
  canonicalUrl,
  isDuplicateTitle,
  simhash,
  stripBoilerplate,
  stripSourceTokens,
  tokens,
  truncate,
  urlKey,
} from "./lib/text.ts";

/**
 * Deduplica: lo stesso concorso compare su 4-5 aggregatori con titoli diversi.
 * Due stadi, perché i dati hanno dimostrato che serve:
 *  1. prefilter SimHash largo (≤ DUP_CANDIDATE_MAX_HAMMING) per non scansionare tutto;
 *  2. decisione finale con isDuplicateTitle (token distintivi + coerenza importi).
 * Il solo SimHash sui titoli italiani NON separa i duplicati veri (Hamming 10-20)
 * dai concorsi diversi (da 8 in su): usarlo come giudice darebbe falsi accoppiamenti.
 */

export interface PreparedItem {
  url: string;
  /** Titolo ripulito dal nome della fonte: è anche quello mostrato in chat. */
  title: string;
  urlKey: string;
  simhash: string;
  /**
   * Concorso o articolo/aggregatore. Si decide in ingresso (src/enrich/kind.ts)
   * e viaggia con l'item, così in chat le due sezioni sono già separate.
   */
  kind: ItemKind;
}

/** Finestra entro cui considerare due item lo stesso concorso. */
export const DEDUPE_WINDOW_DAYS = 60;
/** Quanti candidati valutare per ogni item nuovo. */
export const DEDUPE_CANDIDATE_LIMIT = 8;

/**
 * Titolo come va salvato e mostrato: prima si tolgono la fonte e il boilerplate,
 * poi si sistema la forma (urlato, anno incollato). readableTitle è idempotente,
 * quindi il risultato resta stabile anche se un item ripassa di qui.
 */
export function cleanTitle(rawTitle: string, sourceName?: string | Set<string>): string {
  const pulito = stripBoilerplate(rawTitle);
  return truncate(readableTitle(sourceName ? stripSourceTokens(pulito, sourceName) : pulito), 300);
}

export async function prepareItem(
  raw: RawItem,
  sourceName?: string | Set<string>,
  sourceKind: SourceKind = "rss",
): Promise<PreparedItem> {
  const canonical = canonicalUrl(raw.url);
  const title = cleanTitle(raw.title, sourceName);
  return {
    url: canonical,
    title,
    urlKey: urlKey(canonical),
    simhash: simhash(title),
    kind: classifyKind({ url: canonical, title, sourceKind }),
  };
}

/**
 * Il titolo migliore dello stesso concorso.
 *
 * Perché serve: lo stesso concorso arriva da più fonti con nomi diversi, e
 * l'ordine di arrivo decideva quale restava in archivio. Il caso misurato il
 * 16/10/2026: la sitemap di Scontrino Felice usa lo slug ("Concorso Lievital"),
 * il suo feed RSS il titolo vero ("Concorso Lievital: vinci Forni e
 * Scaldavivande"). Se capitava prima la sitemap, in chat restava il nome mozzo.
 *
 * Vince il candidato quando è più completo (contiene tutte le parole del titolo
 * salvato e ne ha altre) oppure, a parità di parole, quando è scritto meglio
 * (meno urlato). In ogni altro caso il titolo in archivio non si tocca: meglio
 * un nome imperfetto che un nome sostituito con uno peggiore.
 */
export function isBetterTitle(stored: string, candidate: string): boolean {
  if (stored === candidate) return false;
  const attuale = tokens(stored);
  const nuovo = tokens(candidate);
  if (attuale.length === 0 || nuovo.length === 0) return false;

  if (nuovo.length > attuale.length && attuale.every((word) => nuovo.includes(word))) return true;

  const stesseParole =
    attuale.length === nuovo.length && attuale.every((word, index) => word === nuovo[index]);
  return stesseParole && shoutRatio(candidate) <= shoutRatio(stored);
}

/** Quota di lettere maiuscole: è la misura di quanto un titolo sia urlato. */
function shoutRatio(input: string): number {
  const letters = input.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  const upper = letters.filter((letter) => letter === letter.toUpperCase() && letter !== letter.toLowerCase()).length;
  return upper / letters.length;
}

/**
 * Migliora il titolo di una riga già in archivio, se questa copia lo scrive
 * meglio. Titolo e simhash si aggiornano insieme: il simhash è la firma di
 * quel titolo, e lasciarlo vecchio renderebbe la deduplica meno precisa.
 */
export async function upgradeTitle(
  store: Store,
  existing: ItemRow,
  prepared: PreparedItem,
): Promise<boolean> {
  if (!isBetterTitle(existing.title, prepared.title)) return false;
  await store.updateItem(existing.id, { title: prepared.title, simhash: prepared.simhash });
  return true;
}

/**
 * Duplicato già noto e già completo: non serve rifare l'arricchimento. Si
 * aggiorna solo "visto di nuovo" (e il marcatore multi-fonte la prima volta).
 * È il percorso caldo del regime: dopo i primi giri quasi tutto è un duplicato.
 */
export async function touchDuplicate(store: Store, existing: ItemRow, now: Date): Promise<void> {
  const iso = now.toISOString();
  if (existing.clusterId === null) {
    await store.updateItem(existing.id, { clusterId: existing.id, lastSeenAt: iso });
    return;
  }
  await store.touchItem(existing.id, iso);
}

/** Un item è già "completo" se ha tutto ciò che le regole saprebbero aggiungere. */
export function isFullyEnriched(existing: ItemRow): boolean {
  return existing.deadline !== null && existing.prize !== null && existing.participation !== null;
}

/**
 * Prima metà della deduplica: la query all'archivio. È I/O (su D1 il filtro
 * simhash lo fa SQL), quindi NON consuma la CPU del piano Free.
 */
export async function loadDuplicateCandidates(
  store: Store,
  prepared: PreparedItem,
  now: Date,
): Promise<ItemRow[]> {
  const since = new Date(now.getTime() - DEDUPE_WINDOW_DAYS * 86_400_000).toISOString();
  return store.findDuplicateCandidates(prepared.urlKey, prepared.simhash, since, DEDUPE_CANDIDATE_LIMIT);
}

/**
 * Seconda metà: la decisione sui candidati. Questa è CPU nostra (confronto dei
 * token e degli importi) e per item costa quanto l'arricchimento: la pipeline la
 * cronometra per il freno di budget, per questo è separata dalla query.
 */
export function pickDuplicate(candidates: ItemRow[], prepared: PreparedItem): ItemRow | null {
  for (const candidate of candidates) {
    if (candidate.urlKey === prepared.urlKey) return candidate;
    if (isDuplicateTitle(candidate.title, prepared.title)) return candidate;
  }
  return null;
}

/** Le due metà insieme: comodo per i test e per chi non deve misurare la CPU. */
export async function findDuplicate(
  store: Store,
  prepared: PreparedItem,
  now: Date,
): Promise<ItemRow | null> {
  return pickDuplicate(await loadDuplicateCandidates(store, prepared, now), prepared);
}

export function toNewItem(
  raw: RawItem,
  prepared: PreparedItem,
  insight: Insight,
  score: number,
  now: Date,
): NewItem {
  return {
    sourceId: raw.sourceId,
    kind: prepared.kind,
    url: prepared.url,
    urlKey: prepared.urlKey,
    simhash: prepared.simhash,
    title: prepared.title,
    summary: truncate(stripBoilerplate(raw.summary), 1200),
    publishedAt: raw.publishedAt,
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    deadline: insight.deadline,
    prize: insight.prize,
    participation: insight.participation,
    prizeValue: insight.prizeValue,
    effort: insight.effort,
    requiresPurchase: insight.requiresPurchase,
    tags: insight.tags,
    score,
    clusterId: null,
    status: "new",
    aiUsed: insight.aiUsed,
  };
}

/**
 * Un duplicato conferma che il concorso esiste davvero: la prima volta che ne
 * troviamo un secondo esemplare marchiamo la riga con clusterId = id proprio,
 * così /health può contare i concorsi confermati da più fonti.
 */
export async function mergeDuplicate(
  store: Store,
  existing: ItemRow,
  insight: Insight,
  score: number,
  now: Date,
): Promise<void> {
  const iso = now.toISOString();
  if (existing.clusterId === null) {
    await store.updateItem(existing.id, { clusterId: existing.id, lastSeenAt: iso });
    return;
  }

  // Il concorso esiste già: se le nuove regole hanno trovato qualcosa in più,
  // arricchiamo la riga esistente invece di buttare via l'informazione.
  const patch: Parameters<Store["updateItem"]>[1] = { lastSeenAt: iso };
  let improved = false;
  if (existing.deadline === null && insight.deadline !== null) {
    patch.deadline = insight.deadline;
    improved = true;
  }
  if (existing.prize === null && insight.prize !== null) {
    patch.prize = insight.prize;
    improved = true;
  }
  if (existing.participation === null && insight.participation !== null) {
    patch.participation = insight.participation;
    improved = true;
  }
  const tags = [...new Set([...existing.tags, ...insight.tags])];
  if (tags.length !== existing.tags.length) {
    patch.tags = tags;
    improved = true;
  }
  if (improved) {
    patch.prizeValue = Math.max(existing.prizeValue, insight.prizeValue);
    patch.score = Math.max(existing.score, score);
    await store.updateItem(existing.id, patch);
    return;
  }
  await store.touchItem(existing.id, iso);
}
