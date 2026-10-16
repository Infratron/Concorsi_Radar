import type { Category, ItemKind, SourceKind } from "../types.ts";

/**
 * Concorso, offerta o articolo?
 *
 * Perché serve: metà delle fonti non sono concorsi. Un feed di Google News porta
 * la notizia *sul* concorso, una sitemap porta la cartella che raccoglie i
 * concorsi, e un aggregatore pubblica la pagina di categoria. Tutto questo, se
 * finisce nella sezione dei concorsi, è rumore: si tocca il titolo, si apre il
 * link e non si partecipa a niente. La regola è quella chiesta dall'utente — la
 * sezione concorsi contiene solo pagine di concorso, i contenitori vanno in news
 * — e la classificazione si fa QUI, in ingresso, così in chat la divisione è già
 * scritta nell'archivio e non dipende da una query furba al momento di disegnare
 * la schermata.
 *
 * Si decide da URL, titolo e tipo di fonte: nessuna lettura di pagina, perché
 * ogni item in più costa CPU sul piano Free. La direzione dell'errore è
 * dichiarata: nel dubbio è un CONCORSO. Un articolo in più nella sezione
 * concorsi è un fastidio, ma scartare come "news" un concorso vero lo nasconde;
 * e i segnali qui sotto non si applicano a caso, ognuno è un caso reale
 * dell'archivio del 16/10/2026.
 */

export interface KindInput {
  url: string;
  title: string;
  /** Tipo della fonte: le fonti `news` sono articoli per costruzione. */
  sourceKind: SourceKind;
  /**
   * Categoria della fonte. Le fonti `coupon` (buoni sconto, rimborsi, cashback)
   * pubblicano offerte invece di concorsi, e lo dichiarano in
   * src/config/sources.ts: è da lì che si sa, senza indovinare da un titolo.
   */
  sourceCategory: Category;
}

/**
 * Ultimo segmento di un URL che è una PAGINA-ELENCO: la categoria dei concorsi,
 * il listino promozioni, la sezione editoriale. Da soli dicono "questa pagina
 * raccoglie altro", non "questo è un concorso".
 * Caso reale: premieconcorsi.com/concorsi-a-premi/a-partecipazione-gratuita e
 * qualunque .../promozioni/ senza figlio, che nel titolo diventa un'etichetta di
 * categoria ("A Partecipazione Gratuita"), non un nome di concorso.
 */
const LISTING_SEGMENTS = new Set([
  "concorsi", "concorsi-a-premi", "concorsi-a-premio", "concorsi-in-scadenza",
  "concorsi-per-tutti", "tutti-i-concorsi", "migliori-concorsi", "elenco-concorsi",
  "lista-concorsi", "archivio-concorsi", "concorsi-archivio",
  "promozioni", "promo", "promozioni-attive", "offerte", "offerings", "iniziative",
  "news", "blog", "articoli", "articolo", "magazine", "rassegna", "rubriche",
  "categoria", "category", "tag", "archivio", "elenco", "eventi",
  // Cartelle di coupon: /buoni-sconto/ e /coupon/ sono la categoria, non un
  // buono sconto. La pagina di un coupon ha un figlio (".../buono-sconto-novi/")
  // e resta un'offerta: è la stessa distinzione che vale per i concorsi.
  "buoni-sconto", "buono-sconto", "coupon", "codici-sconto", "codice-sconto",
]);

/**
 * Preposizioni con cui cominciano i NOMI DI TASSONOMIA di una cartella di
 * concorsi: "/concorsi-a-premi/a-partecipazione-gratuita" è una categoria,
 * "/concorsi-con-acquisto/concorso-lievital" è un concorso. Uno slug di concorso
 * vero non comincia con una preposizione: comincia con la marca o con la parola
 * concorso/vinci.
 */
const TAXONOMY_START = /^(a|ad|al|alla|ai|alle|di|da|dal|dalla|in|con|su|per|senza|tra|fra|oltre|entro|come|dai|dagli)-/;

function words(input: string): string[] {
  return input.split(/[-_]/).filter((word) => word.length > 0);
}

/**
 * Il figlio che ripete per intero il nome della cartella è una PAGINA della
 * cartella, non una categoria che le somiglia. Caso reale: Scontrino Felice
 * pubblica /premio-certo/premio-certo-apropos, che ripete la cartella e poi dice
 * la marca — è una promo vera, e senza questo controllo tutto il settore finiva
 * in news (misurato il 16/10/2026: 21 item su 24).
 */
function repeatsFolder(parent: string, name: string): boolean {
  const cartella = words(parent.toLowerCase());
  const figlio = words(name.toLowerCase());
  if (cartella.length === 0 || figlio.length <= cartella.length) return false;
  return cartella.every((word, index) => figlio[index] === word);
}

/**
 * "concorsi-a-premi" + "concorsi-fotografici" → prima parola della cartella:
 * "concorsi". Un figlio che comincia così E prende un'altra strada è una
 * categoria di quella cartella; uno che la ripete parola per parola è una sua
 * pagina.
 */
function isTaxonomyName(parent: string, name: string): boolean {
  const root = (parent.split(/[-_]/)[0] ?? "").toLowerCase();
  if (root.length >= 5 && name.startsWith(root) && !repeatsFolder(parent, name)) return true;
  return TAXONOMY_START.test(name);
}

/** Cartelle che raccolgono concorsi o promozioni: lì dentro la tassonomia ha senso. */
const CONTEST_FOLDER = /(concors|premi|promo|offer|iniziativ|operazion|raccolt)/i;

/**
 * Rassegne: titoli che promettono un elenco.
 *
 * Sono divisi in due gruppi, perché "tutti i premi" vale solo come apertura.
 * Il 16/10/2026 la prova dal vivo su Scontrino Felice ha mostrato il costo
 * dell'altra lettura: "Raccolta bollini Bennet Guzzini: scopri tutti i premi"
 * finiva in news — sono i premi da richiedere di una raccolta punti vera, cioè
 * esattamente il contrario di una rassegna. Le formule ambigue quindi contano
 * solo in testa al titolo ("Tutti i concorsi a premi di ottobre"), dove dicono
 * che la pagina È l'elenco.
 */
const LIST_TITLE_START =
  /^(tutti i concorsi|tutti i premi|i migliori concorsi|migliori concorsi|nuovi concorsi|concorsi del mese|concorsi della settimana|concorsi in scadenza|concorsi a premi 20\d{2})\b/i;

/**
 * Parole che un elenco lo dicono e basta, in qualunque punto del titolo: dentro
 * una pagina di concorso non compaiono. L'unico caso reale in archivio è la
 * pagina che raccoglie le iniziative con rimborso, "elenco completo delle
 * iniziative con rimborso attive".
 */
const LIST_TITLE =
  /\b(elenco (?:completo )?(?:dei |delle |di )?(concorsi|premi|iniziative|promozioni|offerte|raccolte)|lista (?:completa )?(?:dei |delle |di )?(concorsi|premi|iniziative|promozioni|offerte|raccolte)|rassegna (?:dei |delle |di )?(concorsi|premi|iniziative)|guida ai concorsi|calendario dei concorsi)\b/i;

/** Quanti concorsi promette il titolo: "12 concorsi a premi da provare". */
const LIST_TITLE_COUNT = /\b\d{1,3}\s+concorsi\b/i;

/** Permalink editoriale: /2026/05/19/titolo-articolo/. */
const DATE_PERMALINK = /\/\d{4}\/\d{1,2}(\/\d{1,2})?\//;

function segmentsOf(url: string): string[] {
  try {
    return new URL(url)
      .pathname.split("/")
      .map((segment) => segment.trim().toLowerCase())
      .filter((segment) => segment.length > 0);
  } catch {
    return [];
  }
}

/** Il segmento "significativo" di un URL: l'ultimo, scartando una coda .html/.php. */
function lastSegment(segments: string[]): string {
  const last = segments[segments.length - 1] ?? "";
  return last.replace(/\.(html?|php|aspx?)$/, "");
}

/**
 * Un buono sconto, un codice sconto, un coupon. Sono formule che dicono "paghi
 * meno": in qualunque posto compaiano, quella pagina non è un concorso.
 *
 * Sono volutamente poche e strette. La parola "buono" da sola non basta ("buono
 * spesa da 500 €" è il premio di un concorso: vedi BONUS_PATTERN in
 * src/enrich/score.ts), e nemmeno "voucher". Il segnale deve dire lo SCONTO.
 *
 * Lo spazio può essere un trattino, perché lo stesso testo in un URL diventa uno
 * slug: "buoni-sconto" è la cartella di Scontrino Felice e "buoni sconto" è il
 * titolo della pagina.
 */
const COUPON_SIGNAL =
  /\b(buon[oi][\s-]sconto|codici?[\s-]sconto|coupon|sconto[\s-]da[\s-]stampare)\b/i;

/**
 * Una promozione che annuncia un premio è un concorso, anche se il coupon è il
 * modo per partecipare. Il caso reale del 16/10/2026: "Cashback Fabuloso, Ajax,
 * Soflan: ricevi un rimborso di 5 euro e vinci lavatrice Samsung" — è un rimborso
 * E un'estrazione, e la metà da concorso non si può nascondere dalla sezione
 * concorsi (è la stessa direzione d'errore dichiarata in testa a questo file).
 */
const PRIZE_SIGNAL = /\b(vinci|vincere|vincita|in palio|concors[oi]|estrazion[ei]|gratta e vinci)\b/i;

/**
 * Il tipo di un item, dai soli dati che la pipeline ha in mano prima di leggere
 * la pagina. Mai un errore in eccesso verso "news": nel dubbio, concorso; e un
 * premio annunciato vince sempre sullo sconto, perché un concorso nascosto costa
 * più di un coupon di troppo.
 */
export function classifyKind(input: KindInput): ItemKind {
  // 1. Le fonti news sono articoli per costruzione: il feed di Google News porta
  //    la notizia, e il link è la pagina del giornale, non il concorso.
  if (input.sourceKind === "news") return "news";

  const segments = segmentsOf(input.url);
  const last = lastSegment(segments);
  const offerta =
    !PRIZE_SIGNAL.test(`${input.title} ${input.url}`) &&
    (input.sourceCategory === "coupon" || COUPON_SIGNAL.test(`${input.title} ${input.url}`));

  // 2. L'URL È la pagina-elenco (la categoria, il listino, la sezione).
  if (last.length > 0 && LISTING_SEGMENTS.has(last)) return "news";

  // 3. Tassonomia dentro una cartella di concorsi: "/concorsi-a-premi/a-partecipazione-gratuita"
  //    oppure "/concorsi-a-premi/concorsi-fotografici". Il nome della categoria
  //    comincia con la parola della cartella, o con una preposizione; lo slug di
  //    un concorso vero comincia con la marca o con "concorso"/"vinci".
  const parent = segments[segments.length - 2] ?? "";
  if (parent.length > 0 && CONTEST_FOLDER.test(parent) && isTaxonomyName(parent, last)) return "news";

  // 4. Permalink con la data: è la forma di un articolo, non di una pagina di concorso.
  if (DATE_PERMALINK.test(input.url)) return "news";

  // 5. Il titolo promette un elenco di concorsi: o lo dice con una formula che
  //    apre il titolo, o con una parola da elenco, o contando i concorsi.
  if (LIST_TITLE_START.test(input.title) || LIST_TITLE.test(input.title) || LIST_TITLE_COUNT.test(input.title)) {
    return "news";
  }

  // 6. Le offerte: un buono sconto o un rimborso non è un concorso. Lo dicono la
  //    fonte (le fonti coupon lo dichiarano) o le parole della pagina — perché un
  //    buono sconto resta un buono sconto anche quando arriva da un aggregatore
  //    di concorsi, ed è lì che l'utente va a cercarlo.
  //
  //    Il controllo viene DOPO le regole degli elenchi di proposito: la pagina
  //    che raccoglie i buoni sconto è un contenitore, non un'offerta.
  if (offerta) return "coupon";

  return "contest";
}
