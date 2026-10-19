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
  // Premi e Concorsi è SPENTO dal 17/10/2026, non perché il sito sia morto: dal
  // PC risponde 200 con la nostra User-Agent, mentre dal runner GitHub (dove gira
  // la raccolta, vedi .github/workflows/ingest.yml) risponde 403 sia al feed sia
  // alla sitemap. Sembra la protezione bot del sito che tratta gli IP da
  // datacenter come traffico automatizzato; il risultato pratico è una fonte che
  // in produzione non porta un item da un giorno. Al suo posto c'è scontOmaggio ·
  // concorsi con acquisto, stesso tipo di fonte (blog che annuncia i concorsi).
  {
    id: "premieconcorsi",
    name: "Premi e Concorsi",
    kind: "rss",
    url: "https://www.premieconcorsi.com/rss.php",
    category: "online",
    tags: ["aggregatore"],
    cadenceMin: 30,
    enabled: false,
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
  // Soldissimi è SPENTO dal 17/10/2026: otto giri consecutivi di HTTP 403 dal
  // runner GitHub, ultimo OK il 16/10 alle 20:09 — mentre la stessa URL dal PC
  // risponde 200. Come per Premi e Concorsi è il sito a rifiutare gli IP da
  // datacenter, non il nostro parser: tenere accesa la fonte significava solo un
  // fallimento per giro nei log. I suoi 9 concorsi restano in archivio.
  {
    id: "soldissimi",
    name: "Soldissimi · concorsi a premio",
    kind: "rss",
    url: "https://www.soldissimi.it/concorsi-a-premio/feed/",
    category: "giftcard",
    tags: ["giftcard", "buoni_spesa"],
    cadenceMin: 45,
    enabled: false,
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
  // Le tre fonti qui sotto sostituiscono Soldissimi, Premi e Concorsi e la
  // query raccolta punti, tutte spente il 17/10/2026. Provate con i parser veri
  // (`runIngest` completo, non solo un curl): 10 concorsi nuovi a testa in un
  // giro, tutti con marca e premio nel titolo.
  // SPENTA lo stesso giorno, dopo la prova in produzione: dal PC il feed dà 10
  // concorsi, dal runner GitHub risponde **202 con 0 item** — è la pagina di
  // verifica del sito, non il feed. Il 202 passa il controllo HTTP (non è un
  // errore) e la fonte resta verde nei log mentre non porta niente: il caso
  // peggiore, e per questo la spegniamo invece di lasciarla "verde".
  {
    id: "omaggiomania",
    name: "OmaggioMania · concorsi a premi",
    kind: "rss",
    url: "https://www.omaggiomania.com/concorsi-a-premi/feed/",
    category: "online",
    tags: ["aggregatore"],
    cadenceMin: 45,
    enabled: false,
    maxItems: 20,
  },
  // La Pagina degli Sconti: trovata il 19/10/2026 contando le testate che Google
  // News dà sulle ricerche di concorsi e cashback (era fra le prime). Misurata con
  // i parser veri: la sezione concorsi porta 12 concorsi attivi e TUTTI nuovi per
  // l'archivio (Milka Monopoly, Kinder, Rovagnati, NaturelleWIN…); robots.txt
  // lascia passare.
  // SPENTA lo stesso giorno, dopo il primo giro in produzione (10:15 UTC): dal
  // runner GitHub risponde HTTP 403, a questo feed come a quello della spesa,
  // mentre dal PC risponde 200. È la stessa protezione dagli IP da datacenter di
  // Premi e Concorsi e Soldissimi: in produzione non porterebbe un item.
  {
    id: "lapaginadeglisconti",
    name: "La Pagina degli Sconti · concorsi",
    kind: "rss",
    url: "https://www.lapaginadeglisconti.it/category/offerte/concorsi/feed/",
    category: "online",
    tags: ["aggregatore"],
    cadenceMin: 60,
    enabled: false,
    maxItems: 20,
  },
  {
    id: "your-contest",
    name: "Your Contest · concorsi a premi",
    kind: "rss",
    url: "https://www.your-contest.com/feed/",
    category: "online",
    tags: ["aggregatore"],
    // Feed meno frequente degli altri: un giro ogni due ore basta e avanza.
    cadenceMin: 120,
    enabled: true,
    maxItems: 20,
  },
  // La sezione "concorsi con acquisto" di scontOmaggio: è la stessa testata di
  // cui già leggiamo i feed coupon, ma qui pubblica i concorsi delle marche di
  // supermercato — Kinder, Mulino Bianco, Rio Mare, Haribo — cioè la fascia che
  // conta per lo scontrino. Risponde 200 con la nostra User-Agent (verificato il
  // 17/10/2026 dal PC; la conferma dal runner arriva col primo giro).
  // SPENTA dopo la prova in produzione, come OmaggioMania: 202 con 0 item dal
  // runner GitHub (verifica del sito), 10 concorsi dal PC. Lo stesso 202 colpisce
  // anche i feed coupon della testata (vedi scontomaggio-coupon): è il dominio,
  // non il percorso.
  {
    id: "scontomaggio-concorsi",
    name: "scontOmaggio · concorsi con acquisto",
    kind: "rss",
    url: "https://www.scontomaggio.com/concorsi-con-acquisto/feed/",
    category: "scontrino",
    tags: ["acquisto", "punto_vendita"],
    cadenceMin: 45,
    enabled: false,
    maxItems: 20,
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
  // La vecchia query (`"raccolta punti" vincita`) non ha mai prodotto un item:
  // Google News non trova "vincita" accanto a "raccolta punti" nei titoli
  // italiani. Dal 17/10/2026 la query cerca le tre parole con cui le insegne
  // annunciano davvero una raccolta (bollini, collezione punti) accanto a
  // "concorso": 3 item in un giro, tutti del Gioco de L'Eco — pochi ma veri,
  // contro zero di prima. Il trasporto (news.google.com) è uno dei pochi che
  // risponde sempre anche dal runner GitHub.
  {
    id: "news-raccolta-punti",
    name: "Google News · raccolta punti e vincite",
    kind: "news",
    url: googleNews('("raccolta punti" OR bollini OR "collezione punti") concorso when:7d'),
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
    // Trenta minuti come gli aggregatori di concorsi: sono la stessa specie di
    // fonte (un blog che pubblica quando esce una promo), e un coupon ha senso
    // solo finché è fresco. Sessanta minuti erano un residuo del primo taglio.
    cadenceMin: 30,
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
    cadenceMin: 30,
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
    cadenceMin: 30,
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
    cadenceMin: 30,
    enabled: true,
    maxItems: 15,
  },
  // SPENTA dal 17/10/2026: in archivio ha portato UN solo coupon, e il feed non
  // si muove. Il lato rimborsi lo coprono già Scontrino Felice e DimmiCosaCerchi
  // (21 e 14 coupon), più il nuovo CouponVolantini qui sotto.
  {
    id: "scontomaggio-cashback",
    name: "scontOmaggio · operazioni a cashback",
    kind: "rss",
    url: "https://www.scontomaggio.com/cashback/feed/",
    category: "coupon",
    tags: ["coupon", "cashback"],
    cadenceMin: 30,
    enabled: false,
    maxItems: 20,
  },
  // SPENTA dal 17/10/2026: dal runner GitHub risponde 202 con 0 item (pagina di
  // verifica), dopo aver portato un solo coupon in tutta la sua storia. Il lato
  // coupon lo tengono Scontrino Felice (21), DimmiCosaCerchi (14) e il nuovo
  // CouponVolantini (9 in un giro), che dal runner risponde 200.
  {
    id: "scontomaggio-coupon",
    name: "scontOmaggio · buoni sconto",
    kind: "rss",
    url: "https://www.scontomaggio.com/coupon/feed/",
    category: "coupon",
    tags: ["coupon"],
    cadenceMin: 30,
    enabled: false,
    maxItems: 20,
  },
  // Il rinforzo vero del lato 💶 Coupon: 10 rimborsi e cashback nuovi in un
  // giro (Fini, Ambipur, Dove+Mentadent, AIA-Despar, Mastro Lindo, Parodontax),
  // tutti con l'importo nel titolo. Sostituisce scontOmaggio · cashback.
  {
    id: "couponvolantini",
    name: "CouponVolantini · cashback e rimborsi",
    kind: "rss",
    url: "https://www.couponvolantini.it/feed/",
    category: "coupon",
    tags: ["coupon", "cashback"],
    cadenceMin: 45,
    enabled: true,
    maxItems: 25,
  },

  // La sezione "spesa" della stessa testata: Spendi & Riprendi, buoni sconto e
  // premi certi delle insegne. Misurata il 19/10/2026: 5 offerte nuove su 12 (le
  // altre 7 sono oltre i 60 giorni dei coupon, e il cancello le tiene fuori).
  // SPENTA con la sorella: 403 dal runner GitHub al primo giro.
  {
    id: "lapaginadeglisconti-spesa",
    name: "La Pagina degli Sconti · spesa e buoni",
    kind: "rss",
    url: "https://www.lapaginadeglisconti.it/category/offerte/spesa/feed/",
    category: "coupon",
    tags: ["coupon"],
    cadenceMin: 60,
    enabled: false,
    maxItems: 20,
  },

  // ---------- sitemap: intercetta le pagine nuove prima dei feed ----------
  // SPENTA dal 17/10/2026: HTTP 403 dal runner GitHub (stesso host del feed,
  // stessa protezione bot) e, nei pochi giri riusciti, ha prodotto UNA sola news. Il
  // pattern qui sotto non trova concorsi perché la sitemap pubblica solo pagine
  // di tassonomia: era già scritto nel commento, ora c'è anche la misura.
  {
    id: "sitemap-premieconcorsi",
    name: "Sitemap · Premi e Concorsi",
    kind: "sitemap",
    url: "https://www.premieconcorsi.com/sitemap.xml",
    category: "online",
    tags: ["sitemap"],
    cadenceMin: 60,
    enabled: false,
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
  // SPENTA dal 17/10/2026: 5 pagine lette e 5 scartate, zero item in archivio.
  // Il pattern trova solo pagine indice ("/concorsi/" senza figli), che il
  // cancello di freschezza butta. Sostituita dalla sitemap di Eurospin.
  {
    id: "sitemap-payback",
    name: "PAYBACK · regolamenti di concorso",
    kind: "sitemap",
    url: "https://www.payback.it/sitemap.xml",
    category: "giftcard",
    tags: ["brand", "payback", "sitemap", "giftcard"],
    cadenceMin: 60,
    enabled: false,
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
  // ↩️ Le campagne spendi-e-riprendi delle insegne, dalla sitemap ufficiale.
  // Aggiunte il 17/10/2026 e SPENTE, perché accese oggi non porterebbero niente:
  // le pagine ci sono, il pattern le trova e la classificazione le riconosce
  // tutte come coupon (verificato con `ingestSource` sulle sitemap vere), ma il
  // cancello di freschezza scarta il 100% — sono campagne stagionali e l'ultima
  // è finita da mesi. Accenderle adesso vuol dire una fonte "vuota" per mesi,
  // che è il motivo per cui Burger King, PAYBACK, Penny ed Eurospin sono spente.
  //
  // Conad · 12 pagine (11 landing-page-ccn, 1 landing-page-dao): le spendi e
  //   riprendi, le "ti rendiamo la metà" e il cashback. Tutte con lastmod
  //   2025-06-05 tranne cashback-conad (2024-09-03), quindi 12 su 12 scartate
  //   come "offerta vecchia (499 giorni)". Attenzione al costo: sitemap.xml è un
  //   unico urlset da 3443 URL e 442 KB, ~21 ms di parse misurati in Node — da
  //   sola sfonda i 10 ms di CPU del piano Free. Non accenderla senza Workers
  //   Paid (o un file più piccolo: robots.txt non ne annuncia altri).
  // Carrefour · 14 pagine da sitemap_2-content.xml (50 KB, ~1,2 ms di parse),
  //   tutte coupon, tutte scartate: la più recente è del 2026-07-10, 98 giorni,
  //   contro i 60 di COUPON_TTL_DAYS. Costo accettabile, contenuto fermo.
  //
  // Quando accenderle: alla prima campagna nuova (lastmod entro 60 giorni) che
  // compare nel pattern, cioè quando il negozio pubblica la pagina con la soglia
  // di spesa. Il pattern è già quello giusto e non serve toccare il codice. Gli
  // elenchi /promozioni/ e le pagine prodotto restano fuori: il pattern prende
  // solo le landing della campagna. Per Conad, oltre alla campagna, serve il
  // budget CPU di Workers Paid: su Free il file da 442 KB resta troppo caro
  // anche quando la promo è fresca.
  {
    id: "sitemap-conad-spendi",
    name: "Conad · spendi e riprendi",
    kind: "sitemap",
    url: "https://www.conad.it/sitemap.xml",
    category: "coupon",
    tags: ["coupon", "cashback", "sitemap", "conad"],
    cadenceMin: 240,
    enabled: false,
    // Tutti i circuiti (ccn, dao, cia…), non solo quelli che oggi ospitano la
    // promo: "spendi" copre spendi_e_riprendi, Spendieriprendi*, spendieriprendi-
    // giugno; "ti rendiamo la metà" è la stessa famiglia di rimborso.
    includePattern: "landing-page-[a-z0-9]+/(spendi|cashback|tirendiamolameta)",
    maxItems: 20,
  },
  {
    id: "sitemap-carrefour-spendi",
    name: "Carrefour · spendi e riprendi",
    kind: "sitemap",
    url: "https://www.carrefour.it/sitemap_2-content.xml",
    category: "coupon",
    tags: ["coupon", "cashback", "sitemap", "carrefour"],
    cadenceMin: 240,
    enabled: false,
    // Prende "spendi-riprendi-…", "spendi-e-riprendi/…" e le landing
    // "landing/spendi-riprendi-…"; non il catalogo né /promozioni/.
    includePattern: "spendi-?(e-)?riprendi",
    maxItems: 20,
  },
  // SPENTA dal 17/10/2026: zero item in tutta la storia della fonte. La sitemap
  // non espone i regolamenti che il pattern cerca (risponde sempre 304, quindi
  // il file non cambia nemmeno). Sostituita dalla sitemap di Penny.
  {
    id: "sitemap-burgerking",
    name: "Burger King · regolamenti",
    kind: "sitemap",
    url: "https://www.burgerking.it/sitemap.xml",
    category: "punto_vendita",
    tags: ["brand", "burgerking", "sitemap"],
    cadenceMin: 120,
    enabled: false,
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
  // Penny ed Eurospin sono SPENTE dal 17/10/2026, e il motivo non è la sitemap:
  // lette senza `includePattern` (perché il runner eseguiva un commit che non
  // conosceva ancora queste due fonti) prendevano le prime 20 pagine del sito —
  // catalogo e indici — e ne scartavano 20. Dal PC, con il pattern giusto, sono
  // 6 pagine e 2 concorsi attivi a testa. Il pattern ora viaggia in D1 (colonne
  // include_pattern / max_items, vedi src/db/schema.sql): si possono riaccendere
  // quando questa configurazione è arrivata al runner, senza aspettare che il
  // pattern sia nel commit che il runner esegue.
  // Le sitemap di brand che funzionano restano AIA, Pampers, Conad, Ferrero,
  // Lavazza, Eni e Sammontana.
  {
    id: "sitemap-penny",
    name: "Penny · concorsi e collezioni",
    kind: "sitemap",
    url: "https://www.penny.it/sitemap.xml",
    category: "punto_vendita",
    tags: ["brand", "penny", "sitemap", "raccolta_punti"],
    cadenceMin: 120,
    enabled: false,
    // Solo `/concorso-…`: con il pattern largo (che includeva "collezione") le
    // pagine più recenti erano tutte catalogo. Le pagine di concorso vere sono
    // `concorso-paga-penny` e `concorso-prodotto-misterioso-…`; le informative
    // privacy contengono "privacy-concorso", senza `/concorso-`, quindi restano
    // fuori da sole.
    includePattern: "/concorso-",
    maxItems: 20,
  },
  {
    id: "sitemap-eurospin",
    name: "Eurospin · concorsi",
    kind: "sitemap",
    url: "https://www.eurospin.it/page-sitemap.xml",
    category: "punto_vendita",
    tags: ["brand", "eurospin", "sitemap"],
    cadenceMin: 120,
    enabled: false,
    // Stessa lezione di Penny: `vinci-` e `gioca-e-parti` pescavano anche
    // "vinci-leccellenza" e i listini, e con il tetto a 20 le pagine vere non
    // entravano. Le pagine di concorso di Eurospin sono tutte `/concorso-…`
    // (bluey, la-partenza-intelligente, radames, dexal…).
    includePattern: "/concorso-",
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
  {
    url: "https://www.carrefour.it/sitemap_2-content.xml",
    reason:
      "provata il 17/10/2026: 10 pagine lette e 10 scartate (7 ferme, 3 senza segnale di concorso), zero item. Riletta come fonte spendi-e-riprendi: 14 campagne, tutte con lastmod più vecchio di 60 giorni — vedi sitemap-carrefour-spendi (pronta, spenta)",
  },
  {
    url: "https://www.esselunga.it/it-it/promo-e-news/landing/cashback.html",
    reason:
      "provata il 17/10/2026: è l'unica pagina cashback della sitemap (2 URL su 2220), risponde 200 ma è un guscio JavaScript senza testo di campagna; la seconda, cashback-smartphone.html, è 404. Zero offerte, niente da monitorare",
  },
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
