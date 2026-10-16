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
  // Scontrino Felice: il sito divide i concorsi in sezioni, e ogni sezione ha
  // il suo feed. Misurato il 16/10/2026, ogni feed porta 25 item (non 10 come il
  // default di WordPress) e i titoli sono completi, con premio e marca: per
  // questo i maxItems stanno a 25 e non a 15 — tagliare a 15 significava perdere
  // dieci concorsi per giro senza guadagnare niente.
  {
    id: "scontrinofelice-acquisto",
    name: "Scontrino Felice · concorsi con acquisto",
    kind: "rss",
    url: "https://www.scontrinofelice.it/concorsi-con-acquisto/feed/",
    category: "scontrino",
    tags: ["acquisto", "punto_vendita"],
    cadenceMin: 30,
    enabled: true,
    maxItems: 25,
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
    maxItems: 25,
  },
  // "Premio certo": non è un'estrazione, è un premio che arriva a chi partecipa
  // (gift card, gadget, buoni). Verificato il 16/10/2026: feed da 25 item, il più
  // vecchio di maggio 2026 — una sezione che teneva solo questo sito e che noi
  // non leggevamo affatto.
  {
    id: "scontrinofelice-premio-certo",
    name: "Scontrino Felice · premio certo",
    kind: "rss",
    url: "https://www.scontrinofelice.it/premio-certo/feed/",
    category: "punto_vendita",
    tags: ["premio_certo", "acquisto"],
    cadenceMin: 60,
    enabled: true,
    maxItems: 25,
  },
  // Raccolte punti e bollini: è la stessa famiglia dei concorsi dei supermercati
  // che già seguiamo con le sitemap dei brand, e qui arrivano con la data.
  {
    id: "scontrinofelice-raccolte-punti",
    name: "Scontrino Felice · raccolte punti",
    kind: "rss",
    url: "https://www.scontrinofelice.it/raccolte-punti/feed/",
    category: "punto_vendita",
    tags: ["raccolta_punti", "punto_vendita"],
    cadenceMin: 60,
    enabled: true,
    maxItems: 25,
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

  // ---------- coupon e rimborsi (verificati il 16/10/2026) ----------
  //
  // Perché sono qui: un buono sconto o un rimborso non è un concorso — si spende,
  // non si vince — e le due cose si cercano in momenti diversi. Quello che lo
  // dichiara è la categoria `coupon`, che la classificazione legge
  // (src/enrich/kind.ts): gli item di queste fonti finiscono in 💶 Coupon e
  // rimborsi invece che fra i concorsi, senza toccare il resto.
  //
  // Perché proprio queste: sono le uniche che pubblicano un FEED di coupon e
  // rimborsi italiani, provate con i parser veri prima di accenderle (item letti
  // in un giro, fra parentesi). Le altre strade sono state provate e scartate con
  // il motivo: gli aggregatori di codici sconto (Topnegozi, Widilo,
  // CodiceRisparmio, DoveConviene, Tigotà) espongono pagine di negozio, e da lì
  // esce il catalogo dei negozi, non le offerte; le insegne (Conad, Acqua &
  // Sapone, Esselunga) tengono i buoni nell'app o sulla carta fedeltà e non
  // pubblicano nessun elenco — le loro promozioni arrivano da qui, perché queste
  // fonti le raccontano.
  {
    id: "scontrinofelice-cashback",
    name: "Scontrino Felice · spendi e riprendi",
    kind: "rss",
    url: "https://www.scontrinofelice.it/spendi-e-riprendi/feed/",
    category: "coupon",
    tags: ["coupon", "cashback"],
    cadenceMin: 60,
    enabled: true,
    // 20 item e 5 ms di parsing (misurato): il feed è ricco, e tagliare a 15
    // perderebbe le code che invece sono offerte ancora valide.
    maxItems: 25,
  },
  {
    id: "scontrinofelice-coupon",
    name: "Scontrino Felice · buoni sconto",
    kind: "rss",
    url: "https://www.scontrinofelice.it/buoni-sconto/feed/",
    category: "coupon",
    tags: ["coupon"],
    cadenceMin: 60,
    enabled: true,
    maxItems: 25,
  },
  {
    id: "dimmicosacerchi-cashback",
    name: "DimmiCosaCerchi · cashback e rimborsi",
    kind: "rss",
    url: "https://www.dimmicosacerchi.it/cashback/feed",
    category: "coupon",
    tags: ["coupon", "cashback"],
    cadenceMin: 60,
    enabled: true,
    // 15 item (misurato): è il tetto che il feed dà da sé.
    maxItems: 15,
  },
  {
    id: "dimmicosacerchi-coupon",
    name: "DimmiCosaCerchi · buoni sconto",
    kind: "rss",
    url: "https://www.dimmicosacerchi.it/buoni-sconto-da-stampare/feed",
    category: "coupon",
    tags: ["coupon"],
    cadenceMin: 60,
    enabled: true,
    maxItems: 15,
  },
  {
    id: "scontomaggio-cashback",
    name: "scontOmaggio · operazioni a cashback",
    kind: "rss",
    url: "https://www.scontomaggio.com/cashback/feed/",
    category: "coupon",
    tags: ["coupon", "cashback"],
    cadenceMin: 60,
    enabled: true,
    maxItems: 20,
  },
  {
    id: "scontomaggio-coupon",
    name: "scontOmaggio · buoni sconto",
    kind: "rss",
    url: "https://www.scontomaggio.com/coupon/feed/",
    category: "coupon",
    tags: ["coupon"],
    cadenceMin: 60,
    enabled: true,
    maxItems: 20,
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
    // Misurato il 16/10/2026: questa sitemap pubblica SOLO pagine di tassonomia
    // ("Concorsi A Codice", "Concorsi Fotografici", …) e non le singole pagine
    // di concorso, che arrivano dal feed RSS della stessa fonte. Le tassonomie
    // sono elenchi, non concorsi: il pattern le esclude e resta in attesa di
    // eventuali pagine vere.
    includePattern: "concorsi-a-premi/(?!concorsi-|a-partecipazione|operazioni-|raccolte-punti)[a-z0-9-]+/?$",
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

  // ---------- brand: sitemap e pagine promozionali (verificate il 16/10/2026) ----------
  // Sono la risposta ai concorsi che "sfuggono" agli aggregatori: un brand
  // pubblica la promozione sul proprio sito e nessun feed la riprende. Le sitemap
  // costano poco (un file XML) e con un pattern stretto danno solo le pagine di
  // concorso. Ognuna di queste è stata provata con i parser veri prima di
  // accenderla: vedi il conteggio degli item nel README.
  {
    id: "sitemap-ferrero",
    name: "Ferrero · promozioni",
    kind: "sitemap",
    url: "https://www.ferrero.com/it/it/sitemap.xml",
    category: "punto_vendita",
    tags: ["brand", "ferrero", "sitemap"],
    cadenceMin: 60,
    enabled: true,
    includePattern: "/promozioni/[a-z0-9]",
    maxItems: 20,
  },
  {
    id: "sitemap-lavazza",
    name: "Lavazza · concorsi",
    kind: "sitemap",
    url: "https://www.lavazza.it/sitemap.xml",
    category: "punto_vendita",
    tags: ["brand", "lavazza", "sitemap", "raccolta_punti"],
    cadenceMin: 60,
    enabled: true,
    // Senza il filtro sul nome, /promozioni/ è un catalogo di kit e capsule:
    // 20 pagine di prodotto a ogni giro, zero concorsi (misurato il 16/10/2026).
    // Niente "premi" (matcherebbe "premium") né "estrazion" (per Lavazza è
    // l'estrazione del caffè).
    includePattern: "(concors|vinci|palio|gratta)",
    maxItems: 20,
  },
  {
    id: "sitemap-eni",
    name: "Eni Più Insieme · concorsi",
    kind: "sitemap",
    url: "https://piuinsieme.eni.com/sitemap.xml",
    category: "punto_vendita",
    tags: ["brand", "eni", "sitemap", "raccolta_punti"],
    cadenceMin: 60,
    enabled: true,
    includePattern: "concorsi-premi/[a-z0-9]",
    maxItems: 20,
  },
  {
    id: "sitemap-payback",
    name: "PAYBACK · regolamenti di concorso",
    kind: "sitemap",
    url: "https://www.payback.it/sitemap.xml",
    category: "giftcard",
    tags: ["brand", "payback", "sitemap", "giftcard"],
    cadenceMin: 60,
    enabled: true,
    includePattern: "concors",
    maxItems: 20,
  },
  {
    id: "sitemap-conad",
    name: "Conad · carte e premi",
    kind: "sitemap",
    url: "https://www.conad.it/sitemap.xml",
    category: "punto_vendita",
    tags: ["brand", "conad", "sitemap", "raccolta_punti"],
    cadenceMin: 60,
    enabled: true,
    // "concors|collezion" raccoglieva centinaia di pagine di catalogo (tazze,
    // borse, peluche): con un tetto di 20 item il catalogo consumava tutto lo
    // spazio e i concorsi veri non entravano mai. Qui si prendono solo le pagine
    // appese direttamente alla sezione, che sono le promozioni.
    includePattern: "/collezioni-e-concorsi/[a-z0-9-]+/?$",
    maxItems: 20,
  },
  {
    id: "sitemap-burgerking",
    name: "Burger King · regolamenti",
    kind: "sitemap",
    url: "https://www.burgerking.it/sitemap.xml",
    category: "punto_vendita",
    tags: ["brand", "burgerking", "sitemap"],
    cadenceMin: 120,
    enabled: true,
    // "/promo" è il listino offerte dei menu, non concorsi: fuori dal pattern.
    includePattern: "regolament",
    maxItems: 20,
  },
  {
    id: "sitemap-sammontana",
    name: "Sammontana · gusta e vinci",
    kind: "sitemap",
    url: "https://www.sammontana.it/sitemap.xml",
    category: "punto_vendita",
    tags: ["brand", "sammontana", "sitemap"],
    cadenceMin: 120,
    enabled: true,
    includePattern: "concors|vinci|gioca",
    maxItems: 20,
  },
  // Poche marche espongono i concorsi in una sitemap leggibile: il 16/10/2026 ne
  // ho sondate cinquanta (barilla, mulino bianco, nutella, kinder, findus,
  // perugina, san pellegrino, granarolo, bauli, maina, de'longhi, mediaworld,
  // unieuro, decathlon, samsung, coop, eurospin, bennet, lidl, carrefour…) e solo
  // sei avevano URL di concorso nel file XML. Di quelle sei, tre non portavano
  // niente oltre alla pagina della sezione (Galbani, Parmalat, Rio Mare) e una
  // solo pagine di campagna senza segnale di concorso (Nivea). Restano queste,
  // che con i parser veri hanno prodotto concorsi veri.
  {
    id: "sitemap-aia",
    name: "AIA · concorsi",
    kind: "sitemap",
    url: "https://www.aiafood.com/sitemap.xml",
    category: "punto_vendita",
    tags: ["brand", "aia", "sitemap"],
    cadenceMin: 120,
    enabled: true,
    // Solo le pagine figlie: "/it/concorsi/" è la sezione che le raccoglie.
    includePattern: "/concorsi/[a-z0-9]",
    maxItems: 20,
  },
  {
    id: "sitemap-pampers",
    name: "Pampers · concorsi e promozioni",
    kind: "sitemap",
    url: "https://www.pampers.it/sitemap.xml",
    category: "punto_vendita",
    tags: ["brand", "pampers", "sitemap"],
    cadenceMin: 120,
    enabled: true,
    // La sezione ha anche faq, form dei box e le pagine dei vincitori: le prime
    // due non sono concorsi, le terze le scarta il cancello di freschezza.
    includePattern: "concorsi-a-premi-e-promozioni/(?!i-vincitori|faq|box",
    maxItems: 20,
  },
  {
    id: "cocacola-offerte",
    name: "Coca-Cola · offerte e concorsi",
    kind: "html",
    url: "https://www.coca-cola.com/it/it/offerings",
    category: "punto_vendita",
    tags: ["brand", "cocacola", "punto_vendita"],
    cadenceMin: 60,
    enabled: true,
    includePattern: "/offerings/[a-z0-9-]+",
    maxItems: 20,
  },

  // ---------- brand senza pagina propria: li intercettano le news ----------
  {
    id: "news-brand",
    name: "Google News · concorsi dei brand",
    kind: "news",
    url: googleNews('(nutella OR kinder OR "coca-cola" OR "mulino bianco" OR barilla OR esselunga OR conad) (vinci OR "concorso a premi" OR "in palio") when:7d'),
    category: "punto_vendita",
    tags: ["news", "brand"],
    cadenceMin: 30,
    enabled: true,
    maxItems: 25,
  },
  {
    id: "news-instantwin",
    name: "Google News · instant win e codici",
    kind: "news",
    url: googleNews('("instant win" OR "codice sotto il tappo" OR "in palio" OR "mette in palio") concorso when:7d'),
    category: "online",
    tags: ["news"],
    cadenceMin: 30,
    enabled: true,
    maxItems: 25,
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
/**
 * Fonti note ma non utilizzabili: tenute come promemoria nel README.
 *
 * Nota del 16/10/2026: OmaggioMania e scontOmaggio rispondono 200 ai FEED con la
 * nostra User-Agent (provati), anche se le loro pagine di categoria rispondono
 * 403: la voce qui sotto riguarda le pagine, non i feed. I feed di scontOmaggio
 * sono utilizzati come fonti coupon (vedi sopra).
 *
 * Gli aggregatori di codici sconto invece non sono un problema di blocchi: le
 * loro pagine parlano di negozi, non di offerte — cioè non c'è niente da
 * raccogliere con i parser che abbiamo.
 */
export const REJECTED_SOURCES: { url: string; reason: string }[] = [
  { url: "https://www.omaggiomania.com/concorsi-a-premi/", reason: "403 al fetch diretto delle pagine (il feed risponde)" },
  { url: "https://www.scontomaggio.com/concorsi-con-acquisto/", reason: "403 al fetch diretto delle pagine (i feed rispondono)" },
  { url: "https://www.topnegozi.it/sitemap_shops.xml", reason: "403 sull'XML, e le pagine negozio elencano negozi, non coupon" },
  { url: "https://www.widilo.it/codice-sconto", reason: "pagine di negozio: si raccoglie la navigazione, non le offerte" },
  { url: "https://www.doveconviene.it/", reason: "volantini e reparti: nessun elenco di coupon da leggere" },
  { url: "https://www.acquaesapone.it/il-club/", reason: "coupon solo sulla Carta Club: nessun elenco pubblico" },
  { url: "https://www.conad.it/hey-conad/app", reason: "buoni digitali nell'app HeyConad: nessun elenco pubblico" },
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

/**
 * Quanti concorsi nuovi, per giro, possono costare UNA richiesta in più per
 * cercare il regolamento sulla loro pagina (src/enrich/regulation.ts).
 *
 * Il bando è quasi sempre un link dentro la pagina del concorso (misurato il
 * 16/10/2026: 17 bandi veri su 20 pagine lette), e senza questa ricerca il
 * bottone 📄 Regolamento non comparirebbe quasi mai; ma ogni ricerca è una
 * pagina scaricata e scandita, quindi non si fa per tutto l'archivio a ogni giro.
 *
 * Cento coprono un giro normale con abbondanza — in regime le fonti portano
 * pochi concorsi NUOVI per volta — e coprono anche la PRIMA raccolta, dove una
 * fonte nuova scarica tutto il suo arretrato: misurato il 16/10/2026 con sette
 * fonti, 83 concorsi nuovi in un giro, e con un tetto più basso (20, poi 60) la
 * coda del giro restava senza bottone — cioè proprio i concorsi appena arrivati.
 * Il tetto vero resta il tempo: vedi RULES_LOOKUP_BUDGET_MS. I freni veri
 * restano altri e sono
 * dichiarati: una richiesta per concorso nuovo, mai per un coupon, il tempo di
 * parete massimo (`RULES_LOOKUP_BUDGET_MS` nel Worker, `rulesLookupMs` sulla
 * raccolta), il budget di CPU e robots.txt prima di ogni lettura. Quello che
 * resta fuori lo prende `npm run rules -- --apply`, che è anche il comando per
 * l'archivio raccolto prima di questa funzione.
 */
export const MAX_RULES_LOOKUPS_PER_RUN = 100;
