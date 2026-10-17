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
const SPEND_AFTER = /^\s*(?:di\s+|in\s+)?(?:acquist|spes|spend|ordini|scontrin)/;

/** Quello che precede la cifra e la trasforma in una spesa: "spendi 20 €". */
const SPEND_BEFORE = /(?:spendi|spendere|spesa|spese|acquista|acquistare|costo|almeno|ordine\s+minimo)\s*(?:di\s+)?$/;

function centsFrom(raw: string): number | null {
  const normalized = raw.replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
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

  if (candidates.length === 0) return { cents: null, cap: false };
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
