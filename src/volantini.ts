import type { FetchLike } from "./types.ts";
import type { Store } from "./db/store.ts";
import { MONTHS, isoDate } from "./enrich/rules.ts";
import { fetchText } from "./lib/http.ts";
import { robotsAllows } from "./ingest/index.ts";
import { decodeEntities } from "./lib/text.ts";
import { localDateString } from "./telegram/format.ts";

/**
 * 📰 Volantini delle insegne della provincia di Lecce.
 *
 * Cosa fa: per ogni catena tiene il link al volantino UFFICIALE, le date di
 * validità quando la pagina le scrive e la copertina quando c'è. Cosa non fa:
 * leggere i prezzi o i 2x1 dentro il volantino — le catene li pubblicano come
 * immagini, e senza un modello che legge le immagini il testo non c'è. Il
 * progetto è a costo zero, quindi il bot porta al volantino e dice se è quello
 * in corso; le offerte si sfogliano sul sito della catena.
 *
 * Le pagine sono quelle misurate il 19/10/2026 sui siti veri, solo pagine
 * pubbliche (niente endpoint interni delle app) e solo dove robots.txt lo
 * permette. Le catene sono quelle con punti vendita in provincia di Lecce
 * secondo OpenStreetMap (474 negozi contati, Conad ed Eurospin in testa).
 */

export interface FlyerSource {
  /** Id dell'insegna (src/config/brands.ts). */
  id: string;
  /** La pagina pubblica da leggere. */
  page: string;
  /**
   * Il link al volantino vero, se nella pagina ce n'è uno più preciso della
   * pagina stessa (Lidl: la pagina del volantino in corso; Eurospin: lo
   * sfogliatore nazionale). Senza, il link è la pagina.
   */
  linkPattern?: RegExp;
  /** L'immagine di copertina, quando la catena la mette nella pagina. */
  coverPattern?: RegExp;
  /**
   * Cosa trova chi apre il link: il volantino della catena, oppure la ricerca
   * del negozio (Conad, Crai, Carrefour: il volantino cambia da negozio a
   * negozio, e si sceglie lì).
   */
  scelta: "volantino" | "negozio";
}

export const FLYER_SOURCES: FlyerSource[] = [
  { id: "conad", page: "https://www.conad.it/ricerca-negozi", scelta: "negozio" },
  {
    id: "eurospin",
    page: "https://www.eurospin.com/it-it/volantino/",
    // Lo sfogliatore del volantino NAZIONALE: quello dei singoli negozi sta in un
    // JSON che robots.txt lascia passare solo per lettera, e qui non si usa.
    linkPattern: /https:\/\/www\.eurospin\.com\/it-it\/volantino-store-eurospin\/\?url=[^"'\s<>]*eurospin-italia[^"'\s<>]*/,
    coverPattern: /https:\/\/digitalflyer\.eurospin\.it\/files\/[^"'\s<>]+\.jpg/,
    scelta: "volantino",
  },
  { id: "coop", page: "https://coop.it/le-nostre-promozioni", scelta: "volantino" },
  { id: "dok", page: "https://www.supermercatidok.it/volantini/", scelta: "volantino" },
  { id: "md", page: "https://www.mdspa.it/volantino/", scelta: "volantino" },
  { id: "despar", page: "https://www.despar.it/it/offerte-per-te/", scelta: "volantino" },
  { id: "acquaesapone", page: "https://www.acquaesapone.it/promozioni/", scelta: "volantino" },
  { id: "carrefour", page: "https://www.carrefour.it/volantino", scelta: "negozio" },
  { id: "crai", page: "https://crai.it/negozi-e-volantini", scelta: "negozio" },
  {
    id: "lidl",
    page: "https://www.lidl.it/c/volantino-lidl/s10018048",
    // Il volantino in corso ha le date nell'indirizzo: "offerte-valide-dall1-10-al-31-10".
    linkPattern: /https:\/\/www\.lidl\.it\/l\/it\/volantini\/offerte-valide[^"'\s<>]+/,
    scelta: "volantino",
  },
  { id: "todis", page: "https://www.todis.it/volantini/volantino-todis-san-cesario-di-lecce/", scelta: "volantino" },
  { id: "penny", page: "https://www.penny.it/sfoglia-il-volantino-mobile", scelta: "volantino" },
  { id: "tigota", page: "https://volantino.tigota.it/volantino/index.html", scelta: "volantino" },
];

/** Quanto spesso si rilegge una pagina: i volantini cambiano a settimane, non a ore. */
export const FLYER_REFRESH_MS = 12 * 60 * 60 * 1000;

export interface Flyer {
  chain: string;
  url: string;
  validFrom: string | null;
  validTo: string | null;
  coverUrl: string | null;
  /** Quando la pagina è stata letta l'ultima volta (ISO). */
  checkedAt: string;
  /**
   * Quando link o date sono cambiati: è il "nuovo volantino". null = non è mai
   * cambiato da quando il bot lo legge — la prima lettura non è una novità, e
   * segnarla 🆕 metterebbe il segno su tutte le insegne il primo giorno.
   */
  changedAt: string | null;
  /** Codice HTTP dell'ultima lettura (null = errore di rete o robots). */
  status: number | null;
}

/**
 * Le date "dal 6 al 18 ottobre 2026", "dal 22 ottobre al 1 novembre 2026",
 * "Dal 19 ottobre al 16 novembre" e quelle nell'indirizzo di Lidl
 * ("dall1-10-al-31-10"). Senza anno vale quello di `now`, e una fine prima
 * dell'inizio passa all'anno dopo (il volantino di fine dicembre).
 */
export function flyerDates(text: string, now: Date): { from: string; to: string } | null {
  const anno = Number(localDateString(now).slice(0, 4));
  const parole = Object.keys(MONTHS).filter((mese) => mese.length > 3).join("|");
  const conMesi = new RegExp(
    `\\bdal?l?'?\\s*(\\d{1,2})(?:\\s+(${parole}))?(?:\\s+(\\d{4}))?\\s+al\\s+(\\d{1,2})\\s+(${parole})(?:\\s+(\\d{4}))?`,
    "i",
  ).exec(text);
  // Lidl scrive le date nell'indirizzo in due modi: "dall1-10-al-31-10" (il
  // mensile) e "dal-15-10-al-21-10" (il settimanale).
  const numeriche = /\bdal(?:l|-)?(\d{1,2})-(\d{1,2})-al-(\d{1,2})-(\d{1,2})(?:-(\d{4}))?/i.exec(text);

  let inizio: [number, number, number] | null = null;
  let fine: [number, number, number] | null = null;
  if (conMesi) {
    const meseFine = MONTHS[conMesi[5].toLowerCase()];
    const meseInizio = conMesi[2] ? MONTHS[conMesi[2].toLowerCase()] : meseFine;
    const annoFine = conMesi[6] ? Number(conMesi[6]) : anno;
    const annoInizio = conMesi[3] ? Number(conMesi[3]) : annoFine;
    inizio = [annoInizio, meseInizio, Number(conMesi[1])];
    fine = [annoFine, meseFine, Number(conMesi[4])];
  } else if (numeriche) {
    const annoFine = numeriche[5] ? Number(numeriche[5]) : anno;
    inizio = [annoFine, Number(numeriche[2]), Number(numeriche[1])];
    fine = [annoFine, Number(numeriche[4]), Number(numeriche[3])];
  }
  if (!inizio || !fine) return null;
  // "dal 28 dicembre al 6 gennaio": la fine è dell'anno dopo.
  if (fine[1] < inizio[1] && !conMesi?.[6] && !numeriche?.[5]) fine = [fine[0] + 1, fine[1], fine[2]];
  const from = isoDate(...inizio);
  const to = isoDate(...fine);
  return from && to && from <= to ? { from, to } : null;
}

/** Il testo di una pagina, per cercarci le date: tag e spazi via, entità decodificate. */
function testoDi(html: string): string {
  return decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ");
}

/** L'immagine Open Graph della pagina, se c'è: è la copertina più comune. */
function ogImage(html: string): string | null {
  const meta = /<meta[^>]+property=["']og:image["'][^>]*>/i.exec(html)?.[0];
  const url = meta ? /content=["']([^"']+)["']/i.exec(meta)?.[1] : null;
  return url && /^https:\/\//.test(url) ? decodeEntities(url) : null;
}

/**
 * Fra i link che somigliano al volantino, quello da dare: in corso oggi prima di
 * quello in arrivo, e a parità il più corto (il settimanale prima del mensile).
 * Misurato il 19/10/2026: la pagina Lidl ne porta due, e l'ordine cambia da una
 * lettura all'altra — prendere il primo dava ogni volta un volantino diverso.
 */
function bestLink(pattern: RegExp, html: string, now: Date): string | null {
  const tutti = [...new Set([...html.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))].map((m) => decodeEntities(m[0])))];
  if (tutti.length === 0) return null;
  const oggi = localDateString(now);
  const rango = (url: string): [number, number] => {
    const date = flyerDates(url, now);
    if (date === null) return [3, 0];
    const durata = Date.parse(date.to) - Date.parse(date.from);
    if (date.from <= oggi && date.to >= oggi) return [0, durata];
    return date.from > oggi ? [1, durata] : [2, durata];
  };
  return tutti.sort((a, b) => {
    const [ra, da] = rango(a);
    const [rb, db] = rango(b);
    return ra - rb || da - db;
  })[0];
}

/** Cosa si legge da una pagina: link, date e copertina. Pura, per i test. */
export function parseFlyerPage(
  source: FlyerSource,
  html: string,
  pageUrl: string,
  now: Date,
): { url: string; validFrom: string | null; validTo: string | null; coverUrl: string | null } {
  const url = source.linkPattern ? (bestLink(source.linkPattern, html, now) ?? pageUrl) : pageUrl;
  // Prima le date dell'indirizzo del volantino (Lidl), poi quelle della pagina.
  const date = flyerDates(url, now) ?? flyerDates(testoDi(html), now);
  const copertina = source.coverPattern ? (source.coverPattern.exec(html)?.[0] ?? null) : null;
  return { url, validFrom: date?.from ?? null, validTo: date?.to ?? null, coverUrl: copertina ?? ogImage(html) };
}

export interface FlyerRefreshResult {
  checked: number;
  changed: number;
  failed: string[];
}

/**
 * Rilegge le pagine dei volantini più vecchie di FLYER_REFRESH_MS. Gira nella
 * raccolta su GitHub (scripts/ingest.ts), che raggiunge i siti; dopo il primo
 * giro sono una decina di richieste ogni dodici ore. Una pagina che non risponde
 * lascia il volantino di prima com'era: meglio un link di ieri che nessun link.
 */
export async function refreshFlyers(
  deps: { store: Store; fetcher: FetchLike; userAgent: string },
  now: Date,
  sources: FlyerSource[] = FLYER_SOURCES,
): Promise<FlyerRefreshResult> {
  const salvati = new Map((await deps.store.listFlyers()).map((flyer) => [flyer.chain, flyer]));
  const ctx = { fetcher: deps.fetcher, userAgent: deps.userAgent, now };
  const nowIso = now.toISOString();
  const result: FlyerRefreshResult = { checked: 0, changed: 0, failed: [] };

  for (const source of sources) {
    const prima = salvati.get(source.id);
    if (prima && now.getTime() - Date.parse(prima.checkedAt) < FLYER_REFRESH_MS) continue;
    result.checked++;

    const permesso = await robotsAllows(source.page, { store: deps.store, fetcher: deps.fetcher, userAgent: deps.userAgent }, ctx, now);
    const risposta = permesso ? await fetchText(source.page, ctx, { accept: "text/html,*/*;q=0.5", maxRetries: 0 }) : null;
    if (!risposta || !risposta.ok) {
      result.failed.push(source.id);
      if (prima) await deps.store.saveFlyer({ ...prima, checkedAt: nowIso, status: risposta?.status ?? null });
      continue;
    }

    const letto = parseFlyerPage(source, risposta.body, source.page, now);
    const cambiato = prima !== undefined && (prima.url !== letto.url || prima.validTo !== letto.validTo || prima.validFrom !== letto.validFrom);
    if (cambiato) result.changed++;
    await deps.store.saveFlyer({
      chain: source.id,
      ...letto,
      checkedAt: nowIso,
      // La prima lettura non è un cambio: niente 🆕 su tutte le insegne il primo giorno.
      changedAt: prima === undefined ? null : cambiato ? nowIso : prima.changedAt,
      status: risposta.status,
    });
  }
  return result;
}

/**
 * Come si legge la validità in chat. Le date le scrive la catena; quando non
 * le scrive il bot non le inventa, e dice soltanto quando ha controllato.
 */
export function flyerValidity(flyer: Pick<Flyer, "validFrom" | "validTo">, now: Date): "in-corso" | "in-arrivo" | "scaduto" | "senza-date" {
  if (flyer.validTo === null) return "senza-date";
  const oggi = localDateString(now);
  if (flyer.validTo < oggi) return "scaduto";
  if (flyer.validFrom !== null && flyer.validFrom > oggi) return "in-arrivo";
  return "in-corso";
}

/** Un volantino cambiato da meno di tre giorni è "nuovo". */
export function isNewFlyer(flyer: Pick<Flyer, "changedAt">, now: Date): boolean {
  return flyer.changedAt !== null && now.getTime() - Date.parse(flyer.changedAt) < 3 * 86_400_000;
}
