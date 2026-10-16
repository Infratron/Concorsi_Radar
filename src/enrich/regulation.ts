import { attrValue, cleanText, resolveUrl } from "../ingest/shared.ts";
import { fetchText } from "../lib/http.ts";
import type { FetchLike } from "../types.ts";

/**
 * Il regolamento (bando) di un concorso.
 *
 * Perché esiste: il bottone 📄 Regolamento nella scheda compariva solo quando
 * l'URL del bando era scritto NEL TESTO dell'item, e i feed portano un riassunto
 * di due righe — quindi nella pratica quasi mai. Il bando però c'è quasi sempre,
 * sulla pagina del concorso: è il link in fondo ("Regolamento completo",
 * "Bando", "Scarica il regolamento in PDF"). Qui si legge quella pagina una volta
 * sola, all'ingestione, e si salva il link sull'item (`items.rules_url`): la chat
 * poi non rilegge niente.
 *
 * Le due strade, in ordine di costo:
 *  1. `regulationUrlFromText` — l'URL è già nel testo dell'item (riassunto o
 *     "come partecipare"): è gratis, e copre i feed che lo citano;
 *  2. `bestRegulationLink` — fra i link della pagina del concorso (una richiesta
 *     in più, vedi `MAX_RULES_LOOKUPS_PER_RUN` in src/config/sources.ts).
 *
 * La direzione dell'errore è dichiarata: meglio NESSUN bottone che un bottone
 * sbagliato. Un link alla privacy o alla pagina di assistenza non è il
 * regolamento, e chi ci finisce ha perso il viaggio.
 */

/**
 * Le parole che nominano il regolamento, in URL, slug o testo dell'ancora.
 *
 * Sono volutamente poche: "regolamento" e "bando" sono il nome vero, "rules" e
 * "regulation" arrivano dai concorsi internazionali, e le formule lunghe
 * ("modalità di partecipazione", "condizioni di partecipazione", "termini del
 * concorso") sono lo stesso documento chiamato in un altro modo. Fra le due
 * parole ci sta qualunque cosa (`[^"<>]{0,24}`) perché nell'URL diventa un
 * trattino e nel titolo un "di": conta che stiano vicine.
 */
const REGULATION_HINT =
  /(regolament|regulation|\bband[io]\b|\brules?\b|modalit[aà][^"<>]{0,24}partecip|modulo[^"<>]{0,24}partecip|condizioni[^"<>]{0,24}partecip|termini[^"<>]{0,24}(concors|partecip|iniziativa|promozione))/i;

/** Un PDF è la forma tipica del bando, quindi vale un punto in più. */
const PDF_HINT = /\.pdf(\?|#|$)/i;

/**
 * Link che non sono mai il regolamento. Il confronto è sull'URL: la pagina di
 * assistenza di un concorso si chiama "contatti", quella dei social è su un
 * altro dominio, e "privacy" e "cookie" stanno nella stessa cartella del bando —
 * senza questa lista il link sbagliato vinceva per vicinanza.
 */
const NOT_REGULATION =
  /(facebook|instagram|whatsapp|telegram|linkedin|pinterest|youtube|tiktok|twitter|x\.com|mailto:|privacy|cookie|informativa|newsletter|unsubscribe|disiscriv|assistenza|contatti|login|signin|registrati|account|carrello)/i;

/**
 * Quanti `<a>` guardare al massimo. Una pagina di concorso ne ha centinaia (menù,
 * footer, widget social) e ognuno costa una regex: la CPU nel Worker è contata,
 * e il bando sta comunque nella parte alta o nel corpo della pagina.
 */
const MAX_ANCHORS = 600;

/** Forma confrontabile di un URL: host senza `www`, percorso senza barra finale. */
function comparable(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./i, "").toLowerCase();
    return `${host}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * true se i due URL sono la stessa pagina. Serve a non mettere il regolamento
 * puntato sulla pagina che l'utente sta già aprendo con 🔗 Apri: un bottone che
 * ripete il link di prima non è un'informazione, è un doppione.
 */
export function isSamePage(a: string, b: string): boolean {
  if (a === b) return true;
  const left = comparable(a);
  const right = comparable(b);
  return left !== null && left === right;
}

/**
 * Gli URL assoluti dentro un testo libero. Si fermano a spazio, virgolette e
 * parentesi, e perdono la punteggiatura finale: in un riassunto il link è
 * seguito dal punto, e un URL con il punto attaccato è un URL sbagliato.
 */
function urlsInText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>()[\]]+/gi) ?? [];
  return matches.map((raw) => raw.replace(/[.,;:]+$/, ""));
}

/**
 * Il regolamento quando è già scritto nel testo dell'item. `pageUrl` è la pagina
 * del concorso: se il link trovato È quella pagina, non è un regolamento in più.
 * A parità, vince il PDF (è la forma tipica del bando).
 */
export function regulationUrlFromText(text: string, pageUrl: string | null): string | null {
  let best: string | null = null;
  for (const url of urlsInText(text)) {
    if (!REGULATION_HINT.test(url)) continue;
    if (pageUrl !== null && isSamePage(url, pageUrl)) continue;
    if (best === null || (PDF_HINT.test(url) && !PDF_HINT.test(best))) best = url;
  }
  return best;
}

/**
 * Quanto un link somiglia al regolamento. Zero = non lo è.
 *
 * L'ancora dice più dell'URL (3 punti contro 2) perché è il testo che l'utente
 * legge: "Regolamento completo" su una pagina di file è comunque il bando.
 *
 * Il NOME è però obbligatorio: senza "regolamento", "bando" o una delle altre
 * formule il punteggio resta zero e il link non è un candidato, qualunque cosa
 * sia. Gli altri punti (PDF, "scarica", stessa origine) servono solo a scegliere
 * fra candidati veri — il bando sta quasi sempre sul sito del brand, ma capita
 * che sia su un dominio di piattaforma. Senza questa regola vinceva il primo
 * link del menù: stessa origine, fine della storia (misurato il 16/10/2026: su
 * una pagina di prova il bottone puntava a "Chi siamo").
 */
function scoreLink(url: string, anchorText: string, pageUrl: string): number {
  const nome = (REGULATION_HINT.test(url) ? 2 : 0) + (REGULATION_HINT.test(anchorText) ? 3 : 0);
  if (nome === 0) return 0;

  let score = nome;
  if (PDF_HINT.test(url)) score += 1;
  if (/(scaric|apri|leggi|consulta|testo integrale|pdf)/i.test(anchorText)) score += 1;
  try {
    if (new URL(url).host.replace(/^www\./i, "") === new URL(pageUrl).host.replace(/^www\./i, "")) score += 1;
  } catch {
    // Un URL non interpretabile non porta punti: non è una prova di niente.
  }
  return score;
}

/**
 * Il regolamento fra i link di una pagina. Il testo dell'ancora conta più
 * dell'URL, quindi `cleanText` — che toglie tag ed entità — è obbligatorio:
 * l'ancora tipica è `<a href="/bando.pdf"><strong>Regolamento</strong> completo</a>`.
 */
export function bestRegulationLink(html: string, pageUrl: string): string | null {
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let best: { url: string; score: number } | null = null;
  let match: RegExpExecArray | null;
  let guard = 0;

  while ((match = anchor.exec(html)) !== null && guard < MAX_ANCHORS) {
    guard++;
    const url = resolveUrl(attrValue(match[1], "href"), pageUrl);
    if (url === null) continue;
    if (NOT_REGULATION.test(url)) continue;
    if (isSamePage(url, pageUrl)) continue;

    const score = scoreLink(url, cleanText(match[2]), pageUrl);
    if (score <= 0) continue;
    if (best === null || score > best.score) best = { url, score };
  }

  return best?.url ?? null;
}

export interface RegulationPageDeps {
  fetcher: FetchLike;
  userAgent: string;
  /**
   * Chi decide se quella pagina si può leggere: in produzione è robots.txt
   * (src/ingest/index.ts, `robotsAllows`), nei test una funzione che dice sempre
   * di sì. Passarla da fuori tiene questa funzione pura rispetto alla policy.
   */
  allows: (url: string) => Promise<boolean>;
  now: Date;
}

/**
 * Il bando cercato NELLA pagina del concorso: una richiesta, una scansione.
 *
 * Restituisce null per ogni esito che non sia "trovato": robots che vieta la
 * lettura, HTTP non 200, pagina senza nessun link che somigli al bando. Non
 * solleva mai: un regolamento mancato non deve costare un concorso.
 *
 * È usata da entrambi i posti che cercano un bando — la raccolta
 * (src/pipeline.ts) e il riempimento dell'archivio (scripts/backfill-rules.ts) —
 * così il modo di cercarlo è uno solo.
 */
export async function regulationUrlFromPage(url: string, deps: RegulationPageDeps): Promise<string | null> {
  try {
    if (!(await deps.allows(url))) return null;
    const response = await fetchText(
      url,
      { fetcher: deps.fetcher, userAgent: deps.userAgent, now: deps.now },
      // Nessun secondo tentativo: una pagina di concorso non deve rallentare la
      // raccolta, e chi resta senza bando lo riprende il riempimento.
      { accept: "text/html,application/xhtml+xml,*/*;q=0.1", maxRetries: 0 },
    );
    if (!response.ok) return null;
    return bestRegulationLink(response.body, url);
  } catch {
    return null;
  }
}
