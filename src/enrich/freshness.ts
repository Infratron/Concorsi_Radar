import { SOURCES } from "../config/sources.ts";
import { looksLikeListingContest } from "./rules.ts";

/**
 * Il cancello di "concorso ANCORA ATTIVO".
 *
 * Perché esiste: le fonti di elenco (sitemap e pagine HTML) non sono feed. Una
 * sitemap di brand porta tutto ciò che il sito pubblica sotto un certo percorso
 * — pagine indice, cataloghi di oggetti da collezionare, promozioni chiuse anni
 * fa — e senza questo cancello finiscono in archivio come se fossero concorsi
 * appena usciti. Il caso reale che l'ha reso necessario: la sitemap Conad, che
 * sotto /carte-e-premi/collezioni-e-concorsi/ pubblica centinaia di pagine di
 * tazze e borse, oltre a una promo del 2024.
 *
 * Il cancello è volutamente CONSERVATIVO e vale per TUTTE le fonti: scarta solo
 * con una prova. Una scadenza futura salva subito l'item; un anno passato, una
 * parola di chiusura, una pagina ferma da mesi o — solo per le fonti di elenco,
 * dove il titolo è lo slug — l'assenza totale di segnali di concorso lo
 * condannano. Il costo dichiarato è la coda: un concorso vivo il cui URL non
 * contiene nessuna parola di concorso, senza testo e senza data, viene scartato.
 * Meglio così che riempire il digest di pagine catalogo.
 */

/**
 * Senza scadenza, una pagina che non si aggiorna da così tanti giorni non è più
 * un concorso attivo: le promozioni vere hanno una data di chiusura (e quindi non
 * arrivano qui) oppure vengono ripubblicate. Mezzo anno è largo di proposito,
 * perché scartare un concorso vivo costa più che tenere un dubbio.
 */
export const STALE_PAGE_DAYS = 180;

/** Anni in un titolo, in un testo o in un URL. */
const YEAR = /\b(20\d{2})\b/g;

/**
 * Parole che dicono che il concorso è finito. Sono al passato di proposito:
 * "si concluderà il 30 novembre" non deve far scartare un concorso vivo, mentre
 * "concorso concluso" sì.
 *
 * La parola "vincitore" da sola NON basta: il 16/10/2026 ha fatto scartare il
 * concorso Caffè Borbone, il cui titolo dice "incontra il vincitore di X Factor
 * 2026" — cioè il vincitore è il premio, non la notizia che la gara è chiusa.
 * Conta solo dentro una frase che annuncia la chiusura ("elenco dei vincitori",
 * "i vincitori sono stati proclamati").
 *
 * Il confronto ignora le maiuscole: i titoli dei feed cominciano spesso con la
 * frase in maiuscolo ("I vincitori sono stati contattati") e senza il flag `i`
 * quelle chiusure non si vedevano affatto.
 *
 * Un titolo che COMINCIA con "vincitori" è invece la pagina che annuncia chi ha
 * vinto, e vale come chiusura: le sitemap dei brand ne sono piene (misurato il
 * 16/10/2026 su Pampers: "I Vincitori 2013", "I Vincitori 2012", "I Vincitori
 * 2011" entravano in archivio come concorsi). L'ancora all'inizio è quello che
 * tiene fuori "incontra il vincitore di X Factor", dove il vincitore è il premio.
 */
const CLOSED_TEXT =
  /^(?:i |gli |le |la )?(?:vincitor[ei]|vincitric[ei])\b|\b((?:elenco|lista|proclamazione)\s+de[il]\s+vincitor[ei]|vincitor[ei]\s+de[il]\s+(?:concors\w*|premi\w*|estrazion\w*|edizion\w*)|i\s+vincitor[ei]\s+sono|vincitor[ei]\s+proclamat[ei]|graduatoria|verbale|estrazione avvenuta|estratto a sorte|sono stati estratti|premi assegnati|conclus[oi]|conclus[ae]|terminat[oi]|terminat[ae]|scadut[oi]|scadut[ae]|non pi[uù] attivo|si [eè] chius[oa]|edizione (?:passata|precedente|scorsa)|in archivio)\b/i;

/**
 * Un anno citato vale come "edizione chiusa" solo se è plausibile come anno di
 * un'edizione: entro gli ultimi YEAR_LOOKBACK anni. Senza questo limite il
 * modello di un prodotto fa scartare un concorso vero — misurato il 16/10/2026:
 * "Concorso Sottilette: in palio friggitrici ad aria Philips" letto come
 * "edizione chiusa (2000)" per via della Philips Airfryer Serie 2000.
 */
const YEAR_LOOKBACK = 5;

export interface FreshnessInput {
  title: string;
  url: string;
  summary: string;
  /** ISO 8601: data di pubblicazione, o lastmod per le pagine di elenco. */
  publishedAt: string | null;
  /** Scadenza già estratta: se c'è, il concorso è aperto e non si discute. */
  deadline: string | null;
  /** true per le fonti di elenco (sitemap, html): lì il titolo è lo slug. */
  fromListing: boolean;
}

/** Fonti il cui titolo è ricavato dall'URL e che non portano testo di pagina. */
const LISTING_SOURCE_IDS = new Set(
  SOURCES.filter((source) => source.kind === "sitemap" || source.kind === "html").map((source) => source.id),
);

export function isListingSource(sourceId: string): boolean {
  return LISTING_SOURCE_IDS.has(sourceId);
}

/**
 * Un item già in archivio: le fonti di elenco si riconoscono dal `sourceId`.
 * Per una fonte non più in configurazione si usa il testo vuoto come indizio,
 * perché è la firma di un item nato da uno slug.
 */
export function isListingItem(sourceId: string, summary: string): boolean {
  if (isListingSource(sourceId)) return true;
  return !LISTING_SOURCE_IDS.has(sourceId) && summary.trim().length === 0;
}

function daysSince(iso: string, now: Date): number | null {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((now.getTime() - parsed) / 86_400_000);
}

/** L'anno passato più recente citato nel testo: quell'edizione è chiusa. */
function pastYear(text: string, now: Date): number | null {
  const current = now.getUTCFullYear();
  let found: number | null = null;
  YEAR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = YEAR.exec(text)) !== null) {
    const year = Number(match[1]);
    if (year >= current - YEAR_LOOKBACK && year < current && (found === null || year > found)) found = year;
  }
  return found;
}

/**
 * Motivo per cui un item non è un concorso attivo, oppure null se lo è.
 * Il motivo finisce nelle note della raccolta: serve a capire *perché* una fonte
 * ha smesso di portare item, invece di vederla semplicemente vuota.
 */
export function staleReason(item: FreshnessInput, now: Date): string | null {
  // Una scadenza è la prova più forte: il concorso è aperto.
  if (item.deadline !== null) return null;

  const haystack = `${item.title}\n${item.url}\n${item.summary}`;
  const year = pastYear(haystack, now);
  if (year !== null) return `edizione chiusa (${year})`;

  if (CLOSED_TEXT.test(`${item.title} ${item.summary}`)) return "concorso già chiuso";

  if (item.publishedAt !== null) {
    const age = daysSince(item.publishedAt, now);
    if (age !== null && age > STALE_PAGE_DAYS) return `pagina ferma da ${age} giorni`;
  }

  if (item.fromListing && !carriesContestSignal(item)) return "nessun segnale di concorso";

  return null;
}

/**
 * Cartelle che raccolgono catalogo, non concorsi. Servono a non far passare per
 * "concorso" qualsiasi pagina appesa sotto una sezione che nel nome contiene la
 * parola concorso: /carte-e-premi/collezioni-e-concorsi/ merabiglie-disney non
 * è un concorso, /programma-fedelta/concorsi-premi/ vola-a-disneyland-paris sì.
 */
const CATALOG_SEGMENT = /(collezion|catalog|kit|offerte|offerings|prodott|punti|news|blog|eventi|archivio)/i;

/**
 * Un item di elenco si giudica dalle sue parole: prima il nome della pagina
 * (titolo e suo slug), poi la cartella che lo contiene. Se quella cartella è un
 * catalogo, non c'è segnale che tenga: la pagina è una voce di catalogo.
 */
function carriesContestSignal(item: { title: string; url: string }): boolean {
  let segments: string[] = [];
  try {
    segments = new URL(item.url).pathname.split("/").filter((segment) => segment.length > 0);
  } catch {
    return looksLikeListingContest(`${item.title} ${item.url}`);
  }
  const own = segments[segments.length - 1] ?? "";
  const parent = segments[segments.length - 2] ?? "";

  // Tassonomie: sotto /concorsi-a-premi/ una pagina che si chiama
  // "concorsi-fotografici" è una categoria di quella cartella, non un concorso.
  // Si vede dal nome che comincia con la parola della cartella.
  const radice = (parent.split(/[-_]/)[0] ?? "").toLowerCase();
  if (radice.length >= 5 && own.toLowerCase().startsWith(radice)) return false;

  if (looksLikeListingContest(`${item.title} ${own}`)) return true;

  // Il resto del percorso vale solo se è "/concorsi/...": se in mezzo c'è una
  // cartella di catalogo, nessuna parola più in alto può riscattare la pagina
  // ("sotto carte-e-premi" c'è di tutto, non è una prova).
  const ancestors = segments.slice(0, -1);
  if (ancestors.some((segment) => CATALOG_SEGMENT.test(segment))) return false;

  return looksLikeListingContest(ancestors.join("/"));
}

/** Il cancello applicato a un item già in archivio. */
export function staleItemReason(
  row: { sourceId: string; title: string; url: string; summary: string; publishedAt: string | null; deadline: string | null },
  now: Date,
): string | null {
  return staleReason(
    {
      title: row.title,
      url: row.url,
      summary: row.summary,
      publishedAt: row.publishedAt,
      deadline: row.deadline,
      fromListing: isListingItem(row.sourceId, row.summary),
    },
    now,
  );
}

/**
 * Pagine indice: se un URL raccolto è la "cartella" di almeno `minChildren`
 * altri URL raccolti nello stesso giro, quella pagina è un elenco di voci, non un
 * concorso. Con due figli la soglia non scatta per il concorso con una
 * sottopagina (regolamento o form), che è il caso in cui non vogliamo perdere la
 * pagina madre.
 */
export function indexPageUrls(urls: string[], minChildren = 2): Set<string> {
  const directories = urls.map((url) => `${url.replace(/\/+$/, "")}/`);
  const index = new Set<string>();
  for (const [position, url] of urls.entries()) {
    const directory = directories[position];
    let children = 0;
    for (const [otherPosition, other] of directories.entries()) {
      if (otherPosition === position) continue;
      if (other.startsWith(directory)) {
        children++;
        if (children >= minChildren) {
          index.add(url);
          break;
        }
      }
    }
  }
  return index;
}
