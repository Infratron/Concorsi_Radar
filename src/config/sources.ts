import type { SourceConfig } from "../types.ts";

/**
 * Fonti monitorate.
 *
 * Stato di verifica (ricognizione del 16/10/2026): i feed marcati
 * "VERIFICATO" rispondevano anonimi e senza login. Le fonti `enabled: false`
 * vanno confermate a mano prima di accenderle: i selettori CSS e i pattern
 * sitemap non sono ancora stati validati sul markup reale.
 */

/** Query Google News: la fonte più fresca, batte gli aggregatori di ore. */
function googleNews(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it`;
}

export const SOURCES: SourceConfig[] = [
  // ---------- aggregatori editoriali con feed RSS (tutti VERIFICATI) ----------
  {
    id: "premieconcorsi",
    name: "Premi e Concorsi",
    kind: "rss",
    url: "https://www.premieconcorsi.com/rss.php",
    category: "online",
    tags: ["aggregatore"],
    cadenceMin: 30,
    enabled: true,
    maxItems: 15,
  },
  {
    id: "scontrinofelice-acquisto",
    name: "Scontrino Felice · concorsi con acquisto",
    kind: "rss",
    url: "https://www.scontrinofelice.it/concorsi-con-acquisto/feed/",
    category: "scontrino",
    tags: ["acquisto", "punto_vendita"],
    cadenceMin: 30,
    enabled: true,
    maxItems: 15,
  },
  {
    id: "scontrinofelice-gratuiti",
    name: "Scontrino Felice · concorsi gratuiti",
    kind: "rss",
    url: "https://www.scontrinofelice.it/concorsi-gratuiti/feed/",
    category: "online",
    tags: ["gratis"],
    cadenceMin: 30,
    enabled: true,
    maxItems: 15,
  },
  {
    id: "dimmicosacerchi",
    name: "DimmiCosaCerchi · concorsi a premi",
    kind: "rss",
    url: "https://www.dimmicosacerchi.it/concorsi-a-premi/feed",
    category: "online",
    tags: ["aggregatore"],
    cadenceMin: 30,
    enabled: true,
    maxItems: 15,
  },
  {
    id: "soldissimi",
    name: "Soldissimi · concorsi a premio",
    kind: "rss",
    url: "https://www.soldissimi.it/concorsi-a-premio/feed/",
    category: "giftcard",
    tags: ["giftcard", "buoni_spesa"],
    cadenceMin: 45,
    enabled: true,
    maxItems: 15,
  },
  {
    id: "vincimi",
    name: "Vincimi",
    kind: "rss",
    url: "https://www.vincimi.it/feed/",
    category: "online",
    tags: ["raccolta_punti"],
    cadenceMin: 45,
    enabled: true,
    maxItems: 15,
  },

  // ---------- freschezza: news ----------
  {
    id: "news-concorso-premi",
    name: "Google News · concorso a premi",
    kind: "news",
    url: googleNews('"concorso a premi" when:1d'),
    category: "online",
    tags: ["news"],
    cadenceMin: 15,
    enabled: true,
    maxItems: 25,
  },
  {
    id: "news-giftcard",
    name: "Google News · gift card e buoni",
    kind: "news",
    url: googleNews('"gift card" concorso when:2d'),
    category: "giftcard",
    tags: ["news", "giftcard"],
    cadenceMin: 30,
    enabled: true,
    maxItems: 25,
  },
  {
    id: "news-scontrino",
    name: "Google News · concorso scontrino",
    kind: "news",
    url: googleNews('concorso scontrino premio when:2d'),
    category: "scontrino",
    tags: ["news", "scontrino"],
    cadenceMin: 30,
    enabled: true,
    maxItems: 25,
  },
  {
    id: "news-raccolta-punti",
    name: "Google News · raccolta punti e vincite",
    kind: "news",
    url: googleNews('"raccolta punti" vincita when:2d'),
    category: "punto_vendita",
    tags: ["news", "raccolta_punti"],
    cadenceMin: 60,
    enabled: true,
    maxItems: 25,
  },

  // ---------- sitemap: intercetta le pagine nuove prima dei feed ----------
  {
    id: "sitemap-premieconcorsi",
    name: "Sitemap · Premi e Concorsi",
    kind: "sitemap",
    url: "https://www.premieconcorsi.com/sitemap.xml",
    category: "online",
    tags: ["sitemap"],
    cadenceMin: 60,
    enabled: true,
    includePattern: "/concorsi-a-premi/",
    // 20 item = ~5 ms di CPU: una sitemap da 40 sfonderebbe da sola i 10 ms
    // del piano Free. La coda resta per i giri successivi.
    maxItems: 20,
  },
  {
    id: "sitemap-scontrinofelice",
    name: "Sitemap · Scontrino Felice",
    kind: "sitemap",
    url: "https://www.scontrinofelice.it/sitemap_index.xml",
    category: "scontrino",
    tags: ["sitemap"],
    cadenceMin: 60,
    enabled: true,
    includePattern: "/concorsi-(con-acquisto|gratuiti)/",
    maxItems: 20,
  },

  // ---------- da validare a mano prima di accendere ----------
  {
    id: "premieconcorsi-punto-vendita",
    name: "Premi e Concorsi · concorsi al punto vendita",
    kind: "html",
    url: "https://www.premieconcorsi.com/concorsi-a-premi/concorsi-al-punto-vendita/",
    category: "punto_vendita",
    tags: ["punto_vendita"],
    cadenceMin: 120,
    enabled: false,
    includePattern: "/concorsi-a-premi/[a-z0-9-]+/?$",
    maxItems: 20,
  },
  {
    id: "brand-sitemap-template",
    name: "Template: sitemap di un brand (duplica e compila)",
    kind: "sitemap",
    url: "https://www.esempio-brand.it/sitemap.xml",
    category: "punto_vendita",
    tags: ["brand"],
    cadenceMin: 120,
    enabled: false,
    includePattern: "/(concorsi|promozioni|regolamento|raccolta-punti)",
    maxItems: 20,
  },
];

/** Fonti note ma non utilizzabili: tenute come promemoria nel README. */
export const REJECTED_SOURCES: { url: string; reason: string }[] = [
  { url: "https://www.omaggiomania.com/concorsi-a-premi/", reason: "403 al fetch diretto (blocco anti-bot)" },
  { url: "https://www.scontomaggio.com/concorsi-con-acquisto/", reason: "403 al fetch diretto (blocco anti-bot)" },
  { url: "https://www.mimit.gov.it/.../manifestazioni-a-premio", reason: "nessun elenco pubblico: PREMA richiede SPID/CNS" },
  { url: "https://www.concorsando.it/blog/concorsi-pubblici/", reason: "bandi di lavoro, non concorsi a premi" },
];

export const USER_AGENT = "ConcorsiRadarBot/1.0 (+bot Telegram personale; contatto: proprietario del bot)";

/**
 * Tetto di SICUREZZA sulle fonti per invocazione, non il limitatore vero: quello
 * è CPU_BUDGET_MS. Misurato con npm run bench:cpu e con la rotta /bench dentro
 * workerd, una fonte piena (15-20 item, tutti nuovi da arricchire) costa 4-6 ms
 * di CPU, quindi il freno di budget lascia passare una fonte ricca e rimanda le
 * altre al giro dopo. Un feed invariato invece risponde 304, non produce item e
 * costa ~0,05 ms: così in un tick possono essere controllate più fonti, ed è la
 * CPU spesa, non il numero di fonti, a decidere quanto si fa.
 *
 * Il piano Free dà 10 ms di CPU per invocazione: con questo tetto e il freno a 6
 * ms il caso peggiore misurato resta sotto il limite, e per alzare davvero il
 * lavoro per giro serve Workers Paid (30 s di CPU).
 */
export const MAX_SOURCES_PER_RUN = 4;

/**
 * Budget di CPU per esecuzione: oltre questo la pipeline smette di leggere
 * nuovi item e li lascia al giro successivo. Il conteggio copre parsing,
 * preparazione, decisione sui candidati e arricchimento; NON copre la
 * decodifica del corpo della risposta (dentro fetchText) e l'idratazione delle
 * righe D1, che costano comunque qualcosa. Da qui il margine: 6 ms contati su
 * 10 disponibili invece di 9 e mezzo.
 */
export const CPU_BUDGET_MS = 6;
