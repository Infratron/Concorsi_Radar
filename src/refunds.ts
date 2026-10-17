import type { RefundRow, RefundTotals } from "./types.ts";

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
): T[] {
  const valori = new Map<T, SpendRefund>();
  for (const item of items) valori.set(item, spendRefundFor(item));
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
