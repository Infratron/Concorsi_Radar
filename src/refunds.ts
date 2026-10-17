import type { RefundRow, RefundTotals } from "./types.ts";
import { normalizeTitle } from "./lib/text.ts";

/**
 * I rimborsi e i cashback: quanto torna indietro, e quanto è già tornato.
 *
 * Un coupon non ha un premio (src/types.ts: `prize` resta null) e non ha un
 * punteggio: quello che conta è una cifra. Questa è la parte pura del conteggio
 * — quanto dichiara il bando, come si legge un importo scritto in chat, come si
 * sommano le righe — così la chat e il database non tengono due conti diversi.
 *
 * L'importo dichiarato dal bando è quasi sempre nel TITOLO del coupon
 * ("Rimborso di 5 € su Nutella"), perché è quello che la fonte mette in vetrina;
 * il riassunto e il premio si guardano solo se il titolo non lo dice.
 */

export interface RefundAmount {
  /**
   * L'importo in centesimi, oppure null se il bando non ne dichiara uno fisso:
   * "rimborso del 50%" e "1+1" dipendono da quanto si spende, e inventare una
   * cifra sarebbe peggio che chiederla.
   */
  cents: number | null;
  /** true se la cifra è un tetto ("fino a 100 €"), non l'importo esatto. */
  cap: boolean;
}

/** Un importo seguito dal simbolo o dalla parola: "5,00 €", "5 euro", "35€". */
const AMOUNT_AFTER = /(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:€|euro|eur)/gi;
/** Il simbolo prima della cifra: "€ 5,00". */
const AMOUNT_BEFORE = /(?:€|eur)\s*(\d{1,6}(?:[.,]\d{1,2})?)/gi;

/**
 * Le parole che dicono che quella cifra è il rimborso e non la spesa richiesta.
 * In "10 € di rimborso con 20 € di acquisti" le due cifre sono vicine, e senza
 * questo indizio si rischia di registrare la spesa al posto del rimborso.
 */
const REFUND_WORDS =
  /(rimbors|cashback|ricevi|riceverai|ritorn|torna|indietro|restitu|risparmi|accreditat|bonus|coupon|buono|sconto|gratis)/;

/**
 * "fino a 100 €": la cifra è un massimo, non quello che si riceve davvero.
 *
 * Fra la parola e la cifra possono stare altre parole — "fino a un massimo di
 * 7,50 euro", "fino a un valore massimo di 3 Euro" — ed erano proprio quelle
 * a far leggere un tetto come cifra esatta. Misurato sull'archivio del
 * 17/10/2026: due cashback Henkel e Infasil dichiarati "7,50 €" e "3 €" invece
 * di "fino a …", e quindi sommati al centesimo in 💰 Rimborsi.
 */
const CAP_BEFORE = /(?:fino\s+a|non\s+oltre|massim[oa]|max\.?)(?:[^\d.;]{0,24})$/;

/** Quello che segue la cifra e la trasforma in una spesa: "20 € di acquisti". */
const SPEND_AFTER = /^\s*(?:di\s+|in\s+)?(?:acquist|spes|spend|prodott|ordini|scontrin)/;

/**
 * Quello che precede la cifra e la trasforma in una spesa: "spendi 20 €",
 * "spesa minima di 30 €", "acquisti di almeno 15 €", "spendendone 10".
 *
 * `spendendone` e `spendo` mancavano, e sono la forma con cui i titoli dei
 * cashback dicono la stessa cosa: "ricevi 5 € di rimborso spendendone 10".
 */
const SPEND_BEFORE =
  /(?:(?:spendi|spendere|spendendo|spendendone|speso|spesi|spesa|spese|acquista|acquistare|acquistando|costo|almeno|ordine\s+minimo)\s*(?:minima\s+|minimo\s+)?(?:di\s+)?|(?:acquisti|acquisto)\s+(?:di\s+|per\s+)?)$/;

function centsFrom(raw: string): number | null {
  const normalized = raw.replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

/** "ricevi 20" senza simbolo: la valuta manca, il verbo c'è. */
const BARE_REFUND =
  /\b(?:ricevi|riceverai|riprendi|tornano|torna\s+indietro|ti\s+tornano)\s+(?:circa\s+|fino\s+a\s+)?(\d{1,6})(?:[.,](\d{1,2}))?(?!\d)(?!\s*(?:%|punt|bollin|scontrin|prodott))/i;

function bareRefundFrom(text: string): number | null {
  const match = BARE_REFUND.exec(text);
  if (!match) return null;
  return centsFrom(`${match[1]}${match[2] ? `.${match[2]}` : ""}`);
}

interface Candidate {
  cents: number;
  cap: boolean;
  keyworded: boolean;
}

/**
 * L'importo del rimborso dichiarato in un testo, o null.
 *
 * Le percentuali non sono importi: "rimborso del 50%" senza una cifra è
 * `{ cents: null, cap: false }`, e la chat chiederà quanto è tornato indietro.
 */
export function refundAmountFrom(text: string, options: { requireKeyword?: boolean } = {}): RefundAmount {
  const candidates: Candidate[] = [];
  const push = (match: RegExpExecArray, start: number, end: number): void => {
    const cents = centsFrom(match[1] ?? "");
    if (cents === null) return;
    // Ottanta caratteri e non quaranta: nei riassunti la parola "rimborso" sta
    // all'inizio della frase e la cifra arriva dopo "di quanto speso, fino a un
    // massimo di…" — con la finestra corta la cifra restava senza parola
    // chiave e veniva scartata (o, peggio, letta come importo esatto).
    const before = text.slice(Math.max(0, start - 80), start).toLowerCase();
    const after = text.slice(end, end + 24).toLowerCase();
    // La spesa richiesta non è il rimborso: "spendi 20 € e ricevi 5 €" ha una
    // sola cifra che torna indietro, ed è la seconda.
    if (SPEND_AFTER.test(after) || SPEND_BEFORE.test(before)) return;
    candidates.push({
      cents,
      cap: CAP_BEFORE.test(before),
      keyworded: REFUND_WORDS.test(before) || REFUND_WORDS.test(after),
    });
  };

  for (const match of text.matchAll(AMOUNT_AFTER)) {
    const start = match.index ?? 0;
    push(match, start, start + match[0].length);
  }
  for (const match of text.matchAll(AMOUNT_BEFORE)) {
    const start = match.index ?? 0;
    push(match, start, start + match[0].length);
  }

  if (candidates.length === 0) {
    // Ultima spiaggia: la cifra senza valuta dopo un verbo che dice che torna
    // indietro. "Spendi 100, ricevi 20" è la forma più comune nei titoli, e
    // senza questa riga il coupon avrebbe la spesa ma non il rimborso.
    const nudo = bareRefundFrom(text);
    return { cents: nudo, cap: false };
  }
  // Se il testo nomina il rimborso, quella è la cifra giusta; altrimenti la
  // prima, che è l'ordine in cui il titolo la racconta.
  const keyworded = candidates.find((candidate) => candidate.keyworded);
  if (keyworded) return { cents: keyworded.cents, cap: keyworded.cap };
  // In un testo lungo (il riassunto) una cifra senza la parola "rimborso" è
  // quasi sempre un prezzo: "McDonald's Discovery Days … patatine a 2,90€" non
  // è un rimborso da 2,90 €. Nel titolo e nel premio, invece, la cifra è lì
  // apposta e la prima va bene.
  if (options.requireKeyword === true) return { cents: null, cap: false };
  const chosen = candidates[0]!;
  return { cents: chosen.cents, cap: chosen.cap };
}

/**
 * L'importo del coupon: titolo, poi riassunto, poi premio.
 *
 * Il riassunto è l'unico dei tre che chiede la parola del rimborso accanto alla
 * cifra: è un testo lungo, dove i prezzi dei prodotti sono la norma e il
 * rimborso l'eccezione.
 */
export function refundAmountFor(item: {
  title: string;
  summary: string | null;
  prize: string | null;
}): RefundAmount {
  for (const [text, requireKeyword] of [
    [item.title, false],
    [item.summary, true],
    [item.prize, false],
  ] as const) {
    if (!text) continue;
    const amount = refundAmountFrom(text, { requireKeyword });
    if (amount.cents !== null) return amount;
  }
  return { cents: null, cap: false };
}

/**
 * La soglia di spesa dichiarata da un coupon: "spendi 100, ricevi 20" → 10000.
 *
 * Perché serve: il rimborso da solo non dice quanto conviene. "20 € indietro"
 * è un'offerta diversa se bastano 25 € di spesa o se ne servono 200, e finora
 * la seconda cifra veniva solo scartata come "non è il rimborso".
 *
 * Si cercano prima le cifre con euro (o "euro"), poi — solo per le forme
 * esplicite "spendi N" / "spendendone N" — anche i numeri nudi: "Spendi 100,
 * ricevi 20" è la scrittura più comune nei titoli, e la valuta lì non c'è.
 * Restano fuori i numeri seguiti da punti, bollini o percentuali: non sono
 * euro.
 */
export function spendFrom(text: string): number | null {
  const lower = text.toLowerCase();
  let trovata: number | null = null;
  const consider = (raw: string, start: number, end: number): void => {
    if (trovata !== null) return;
    const cents = centsFrom(raw);
    if (cents === null) return;
    const before = lower.slice(Math.max(0, start - 40), start);
    const after = lower.slice(end, end + 28);
    if (SPEND_BEFORE.test(before) || SPEND_AFTER.test(after)) trovata = cents;
  };

  for (const match of text.matchAll(AMOUNT_AFTER)) {
    const start = match.index ?? 0;
    consider(match[1] ?? "", start, start + match[0].length);
  }
  for (const match of text.matchAll(AMOUNT_BEFORE)) {
    const start = match.index ?? 0;
    consider(match[1] ?? "", start, start + match[0].length);
  }
  if (trovata !== null) return trovata;

  // Senza valuta, ma con il verbo davanti: "spendi 100", "spendendone 10".
  const nudo =
    /\b(?:spendi|spendere|spendendo|spendendone|speso|spesi)\s+(?:circa\s+|almeno\s+)?(\d{1,6})(?:[.,](\d{1,2}))?(?!\d)(?!\s*(?:%|punt|bollin|scontrin|prodott))/i.exec(
      text,
    );
  if (!nudo) return null;
  return centsFrom(`${nudo[1]}${nudo[2] ? `.${nudo[2]}` : ""}`);
}

/** La spesa e il rimborso dichiarati insieme: la base della convenienza. */
export interface SpendRefund {
  /** Soglia di spesa in centesimi; null se il bando non la dichiara. */
  spendCents: number | null;
  refund: RefundAmount;
}

/**
 * Spesa e rimborso di un coupon: ogni testo può dire una delle due cose, e
 * l'ordine in cui si guardano è lo stesso di refundAmountFor (titolo, poi
 * riassunto, poi premio).
 */
export function spendRefundFor(item: {
  title: string;
  summary: string | null;
  prize: string | null;
}): SpendRefund {
  const refund = refundAmountFor(item);
  let spendCents: number | null = null;
  for (const text of [item.title, item.summary, item.prize]) {
    if (!text) continue;
    spendCents = spendFrom(text);
    if (spendCents !== null) break;
  }
  return { spendCents, refund };
}

/**
 * Quanto torna per ogni euro speso: 0,20 = il 20%. null se una delle due cifre
 * manca — e in quel caso l'offerta non si può confrontare con le altre.
 *
 * Un tetto ("fino a 20 € su 100 €") resta un tetto: il rapporto è il massimo
 * recuperabile, non una promessa, e chi lo mostra lo dice.
 *
 * Sopra il 100% non è un rimborso su spesa: è un bonus di benvenuto o una
 * cifra letta dal posto sbagliato. Il caso misurato il 17/10/2026 è Satispay
 * ("ti regala 35€ alla prima ricarica da 5€"): 700% in cima alla classifica
 * della convenienza sarebbe stato il numero più sbagliato della schermata.
 * Quelle offerte restano in elenco, ma senza rapporto.
 */
export function convenienceOf(value: SpendRefund): number | null {
  if (value.spendCents === null || value.spendCents <= 0) return null;
  if (value.refund.cents === null || value.refund.cents <= 0) return null;
  const rapporto = value.refund.cents / value.spendCents;
  return rapporto <= 1 ? rapporto : null;
}

/**
 * Dal più conveniente al meno: chi rende di più per ogni euro speso sta in
 * cima. Le offerte senza una delle due cifre vanno in fondo, ordinate per
 * rimborso assoluto: non si possono confrontare, ma restano nell'elenco.
 *
 * L'ordinamento è stabile a parità di rapporto (Array.prototype.sort è stabile
 * dal 2019): due offerte identiche tengono l'ordine di arrivo dello store.
 */
export function sortByConvenience<T extends { title: string; summary: string | null; prize: string | null }>(
  items: readonly T[],
  /** Cifre già lette (vedi rankByConvenience): evita di ripetere le stesse regex. */
  valori: ReadonlyMap<T, SpendRefund> = valuesOf(items),
): T[] {
  return [...items].sort((a, b) => {
    const va = valori.get(a)!;
    const vb = valori.get(b)!;
    const ca = convenienceOf(va);
    const cb = convenienceOf(vb);
    if (ca !== null && cb !== null && ca !== cb) return cb - ca;
    if (ca !== null && cb === null) return -1;
    if (ca === null && cb !== null) return 1;
    return (vb.refund.cents ?? 0) - (va.refund.cents ?? 0);
  });
}

/** Spesa e rimborso di ogni riga, calcolati una volta sola. */
function valuesOf<T extends { title: string; summary: string | null; prize: string | null }>(
  items: readonly T[],
): Map<T, SpendRefund> {
  const valori = new Map<T, SpendRefund>();
  for (const item of items) valori.set(item, spendRefundFor(item));
  return valori;
}

/**
 * Parole che in un coupon non identificano l'offerta: dicono il MESTIERE della
 * pagina (rimborso, cashback, buono) o la meccanica (spendi, ricevi, scontrino).
 * Da sole non provano che due righe siano la stessa offerta — "Rimborso di 5 €"
 * su un prodotto e su un altro si somigliano in tutto tranne che nel prodotto —
 * quindi servono a togliere rumore, non a decidere.
 */
const OFFER_GENERIC = new Set([
  "rimborso", "rimborsi", "rimborsa", "rimborsano", "rimborsare", "rimborsato", "cashback",
  "buono", "buoni", "sconto", "sconti", "coupon", "offerta", "offerte", "promo",
  "promozione", "promozioni", "iniziativa", "iniziative", "operazione", "spesa", "spese",
  "spendi", "spendo", "spendere", "spendendo", "spendendone", "speso", "spesi", "ricevi",
  "riceverai", "ricevere", "ricevuto", "ricevuti", "riprendi", "richiedi", "richiesta",
  "richiedere", "torna", "tornano", "indietro", "restituisce", "risparmia", "risparmio",
  "risparmi", "risparmiare", "prodotto", "prodotti", "confezione", "confezioni", "euro",
  "gratis", "gratuito", "gratuita", "acquisto", "acquisti", "acquista", "acquistare",
  "acquistando", "scontrino", "scontrini", "farmacia", "supermercato", "negozio", "punti",
  "bollini", "codice", "stampare", "scaricare", "scarica", "come", "quando", "dove", "fino",
  "massimo", "max", "valido", "valida", "scadenza", "importo", "cifra", "totale", "secondo",
  "seconda", "meno", "caro", "cara", "più", "sul", "sulla", "sui", "della", "delle", "dei",
  "degli", "dal", "dalla", "nelle", "nella", "tuo", "tua",
]);

/** Quello che si sa di un'offerta per riconoscerla in un altro elenco. */
interface OfferIdentity {
  /** La spesa dichiarata, se c'è: due spese diverse sono due offerte. */
  spendCents: number | null;
  /** Marca riconosciuta (src/config/brands.ts), se c'è. */
  brand: string | null;
  /** Titolo normalizzato: l'uguaglianza esatta vale come prova. */
  title: string;
  /** Marche e prodotti: l'unica parte che identifica davvero il coupon. */
  specific: Set<string>;
}

function identityOf(item: { title: string; brand?: string | null }, spendCents: number | null): OfferIdentity {
  const normalized = normalizeTitle(item.title);
  const specific = new Set(
    normalized
      .split(" ")
      .filter((token) => token.length >= 4 && !OFFER_GENERIC.has(token) && !/^\d+$/.test(token)),
  );
  return {
    spendCents,
    brand: item.brand ? item.brand.toLowerCase() : null,
    title: normalized,
    specific,
  };
}

/**
 * Due righe sono la stessa offerta?
 *
 * Serve che il bando dichiari lo STESSO rimborso (la firma è già il secchio in
 * cui si confrontano), che le spese non si contraddicano, e almeno una prova in
 * più: una parola specifica in comune (il prodotto: Novi, Nutella, Ymea…). La
 * marca riconosciuta è solo un vincolo, non una prova. L'uguaglianza del titolo
 * normalizzato basta da sola.
 *
 * La parola in comune deve avere almeno quattro lettere: con tre, "usa" (come in
 * "Gillette usa e getta") univa due campagne di marche diverse nella prova con i
 * feed veri del 17/10/2026 — Parodontax e Gillette finirono nello stesso gruppo.
 *
 * La spesa può mancare in una delle due copie — un blog la scrive nel titolo, un
 * altro solo nel corpo — quindi una spesa presente solo da una parte non è una
 * contraddizione; lo è se c'è in entrambe ed è diversa.
 *
 * Se una delle due non ha nessuna parola specifica — "Rimborso di 5 €" — non si
 * unisce: uguale importo non è uguale offerta, e nasconderne una sarebbe peggio
 * che mostrarne due.
 */
function sameOffer(a: OfferIdentity, b: OfferIdentity): boolean {
  if (a.spendCents !== null && b.spendCents !== null && a.spendCents !== b.spendCents) return false;
  if (a.brand !== null && b.brand !== null && a.brand !== b.brand) return false;
  if (a.title.length > 0 && a.title === b.title) return true;
  // La marca uguale NON basta da sola: due buoni diversi della stessa marca
  // dichiarano spesso lo stesso importo ("Aia Durango 0,50 €" e "Aia Spinacine
  // 0,50 €") e unirli nasconderebbe un'offerta. Serve sempre una parola in
  // comune che non sia il mestiere della pagina.
  for (const token of a.specific) {
    if (b.specific.has(token)) return true;
  }
  return false;
}

/** Il rappresentante di un gruppo: quello che racconta di più, non il primo. */
function richer<T extends { summary: string | null; brand?: string | null; firstSeenAt?: string }>(
  candidate: T,
  current: T,
): boolean {
  const lunghezza = (candidate.summary?.length ?? 0) - (current.summary?.length ?? 0);
  if (lunghezza !== 0) return lunghezza > 0;
  const marca = (candidate.brand ? 1 : 0) - (current.brand ? 1 : 0);
  if (marca !== 0) return marca > 0;
  if (candidate.firstSeenAt && current.firstSeenAt) return candidate.firstSeenAt < current.firstSeenAt;
  return false;
}

/**
 * Le stesse offerte ripubblicate da fonti diverse diventano UNA riga.
 *
 * Perché serve: la deduplica dell'ingestione (src/dedupe.ts) lavora sui titoli e
 * un coupon raccontato da tre blog con tre frasi diverse le sfugge — "Rimborso
 * di 5 € su Nutella" e "Cashback Nutella: 5 € di rimborso" hanno abbastanza
 * parole in comune per essere la stessa offerta, ma non abbastanza per
 * isDuplicateTitle. In 💶 Coupon e rimborsi quelle tre righe finivano una sotto
 * l'altra con lo stesso rapporto di convenienza, cioè la classifica mostrava tre
 * volte la stessa offerta.
 *
 * Qui l'unione è di VISUALIZZAZIONE, non di archivio: le righe restano tutte,
 * perché ognuna è la vista di una fonte (e le viste si contano in 📈 Vantaggio).
 * Si uniscono solo le offerte che dichiarano il rimborso: è quella la cifra che
 * le rende confrontabili, e senza non c'è niente di verificabile in comune.
 *
 * L'ordine di arrivo si conserva: il rappresentante prende il posto della prima
 * copia incontrata, così chi era in cima resta in cima.
 */
export function mergeIdenticalOffers<
  T extends {
    title: string;
    summary: string | null;
    prize: string | null;
    brand?: string | null;
    firstSeenAt?: string;
  },
>(
  items: readonly T[],
  /** Cifre già lette (vedi rankByConvenience): evita di ripetere le stesse regex. */
  valori: ReadonlyMap<T, SpendRefund> = valuesOf(items),
): T[] {
  const tenuti: T[] = [];
  const identita = new Map<number, OfferIdentity>();
  const perFirma = new Map<string, number[]>();

  for (const item of items) {
    const { spendCents, refund } = valori.get(item) ?? spendRefundFor(item);
    if (refund.cents === null) {
      tenuti.push(item);
      continue;
    }
    const signature = `${refund.cents}/${refund.cap ? "cap" : "exact"}`;
    const propria = identityOf(item, spendCents);
    const candidati = perFirma.get(signature) ?? [];
    const unito = candidati.find((index) => sameOffer(identita.get(index)!, propria));
    if (unito !== undefined) {
      if (richer(item, tenuti[unito]!)) {
        tenuti[unito] = item;
        identita.set(unito, propria);
      }
      continue;
    }
    const index = tenuti.length;
    tenuti.push(item);
    identita.set(index, propria);
    perFirma.set(signature, [...candidati, index]);
  }

  return tenuti;
}

/**
 * La classifica di 💶 Coupon · ↩️ Rimborsi e cashback: prima i doppioni uniti,
 * poi l'ordine dal più conveniente.
 *
 * Le due cose stanno insieme perché leggono le STESSE due cifre dal testo: in
 * due passate separate ogni riga pagava due volte le regex di refundAmountFor e
 * spendFrom. A 200 righe la differenza si misura in millisecondi, e su Workers
 * Free la CPU di un'invocazione è 10 ms.
 */
export function rankByConvenience<
  T extends {
    title: string;
    summary: string | null;
    prize: string | null;
    brand?: string | null;
    firstSeenAt?: string;
  },
>(items: readonly T[]): T[] {
  const valori = valuesOf(items);
  return sortByConvenience(mergeIdenticalOffers(items, valori), valori);
}

/**
 * Un importo scritto a mano in chat: "7,50", "7.50", "€ 7,50", "7 euro".
 * Tutto il resto è null, e la chat resta sulla domanda invece di registrare
 * una cifra letta male.
 */
export function parseEuroInput(text: string): number | null {
  const match = /^\s*(?:€\s*)?(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|euro|eur)?\s*$/i.exec(text);
  if (!match) return null;
  const cents = centsFrom(match[1] ?? "");
  // Un tetto: 5.000 € in un rimborso è quasi certamente un refuso (o un prezzo
  // incollato), e accettarlo gonfierebbe il totale senza che nessuno se ne accorga.
  if (cents === null || cents >= 500_000) return null;
  return cents;
}

/** "5 €", "1,50 €", "1.234,56 €": l'importo come si scrive in italiano. */
export function formatEuro(cents: number): string {
  const safe = Math.max(0, Math.round(cents));
  const euro = Math.floor(safe / 100);
  const resto = safe % 100;
  // Il separatore delle migliaia si mette a mano: `toLocaleString` dipende
  // dall'ICU della piattaforma (in un runtime ridotto raggruppa diversamente),
  // e un totale che cambia formato fra Worker e test non è accettabile.
  const interi = String(euro).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return resto === 0 ? `${interi} €` : `${interi},${String(resto).padStart(2, "0")} €`;
}

/**
 * L'etichetta del bottone 💰: il numero sono le richieste ancora in attesa, e
 * quando c'è denaro da riavere lo dice. "3" da solo farebbe pensare a tre
 * rimborsi già ricevuti, che è l'altra metà della schermata.
 */
export function refundMenuLabel(attesa: number, cents: number, cap = false): string {
  if (attesa === 0) return "💰 Rimborsi";
  if (cents === 0) return `💰 Rimborsi (${attesa})`;
  return `💰 Rimborsi (${attesa}) · ${cap ? "fino a " : ""}${formatEuro(cents)}`;
}

/** L'importo DICHIARATO dal bando, in parole (prima che sia una richiesta). */
export function refundDeclaredLabel(amount: RefundAmount): string {
  if (amount.cents === null) return "importo variabile";
  return amount.cap ? `fino a ${formatEuro(amount.cents)}` : formatEuro(amount.cents);
}

/** L'importo di un rimborso in parole: la cifra, il tetto, o "variabile". */
export function refundAmountLabel(refund: { amountCents: number; cap: boolean }): string {
  if (refund.amountCents <= 0) return "importo variabile";
  return refund.cap ? `fino a ${formatEuro(refund.amountCents)}` : formatEuro(refund.amountCents);
}

/** I totali di un elenco di rimborsi (lo usano lo store in memoria e i test). */
export function totalsOfRefunds(rows: Pick<RefundRow, "amountCents" | "receivedAt" | "cap">[]): RefundTotals {
  const totals: RefundTotals = {
    pendingCents: 0,
    receivedCents: 0,
    pending: 0,
    received: 0,
    unknownPending: 0,
    unknownReceived: 0,
    capPending: 0,
    capReceived: 0,
  };
  for (const row of rows) {
    const cap = row.cap === true;
    if (row.receivedAt === null) {
      totals.pending += 1;
      totals.pendingCents += row.amountCents;
      if (row.amountCents <= 0) totals.unknownPending += 1;
      if (cap) totals.capPending += 1;
    } else {
      totals.received += 1;
      totals.receivedCents += row.amountCents;
      if (row.amountCents <= 0) totals.unknownReceived += 1;
      if (cap) totals.capReceived += 1;
    }
  }
  return totals;
}
