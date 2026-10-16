import type { SourceAttempt, SourceRow } from "../types.ts";
import { ROBOTS_DENIED_REASON } from "../lib/robots.ts";
import { truncate } from "../lib/text.ts";
import { escapeHtml, localTimeShort } from "./format.ts";

/**
 * Il racconto di un giro di raccolta, fonte per fonte: chi ha risposto, con che
 * codice HTTP, a che ora, e quanti item ha portato.
 *
 * Dove si legge: nel log dell'esecuzione (`runs.log`), che in chat apre 🧾 Log
 * delle raccolte — la schermata che vede solo l'admin. Non è più un messaggio
 * mandato a ogni raccolta: un riepilogo che arriva da solo 48 volte al giorno si
 * smette di leggerlo, mentre un log che sta lì e si apre quando serve no. Il
 * testo è lo stesso che il job su GitHub scrive nella pagina di riepilogo, così
 * chat e runner non possono raccontare due cose diverse.
 *
 * Le STESSE parole valgono per la schermata 📡 Fonti, che legge lo stato salvato
 * dell'ultimo tentativo: un vocabolario solo (esitoFonte), due sorgenti di dati —
 * l'esito di adesso (in memoria, per il report) e l'ultimo tentativo in archivio
 * (per la schermata). Se le due divergessero, la chat racconterebbe due cose
 * diverse dello stesso fatto.
 */

/** I fatti che bastano a dire com'è andata una fonte, da qualunque parte arrivino. */
export interface FonteFatti {
  httpStatus: number | null;
  items: number;
  notModified: boolean;
  robotsDenied: boolean;
  error: string | null;
}

export interface EsitoFonte {
  emoji: string;
  /** Il motivo, in una riga: "HTTP 403", "HTTP 200 · 25 item", "non è cambiata". */
  motivo: string;
  /** true se la fonte ha risposto (304 compreso: è una risposta). */
  risposta: boolean;
}

function itemLabel(quanti: number): string {
  return quanti === 1 ? "1 item" : `${quanti} item`;
}

/** Il vocabolario degli esiti: emoji, motivo e se la fonte ha risposto. */
export function esitoFonte(fatti: FonteFatti): EsitoFonte {
  if (fatti.robotsDenied) return { emoji: "🚫", motivo: ROBOTS_DENIED_REASON, risposta: false };
  const codice = fatti.httpStatus === null ? null : `HTTP ${fatti.httpStatus}`;
  if (fatti.error !== null) {
    // Per un errore HTTP il messaggio È il codice: ripeterlo due volte in una
    // riga sola ("HTTP 403 · HTTP 403") sarebbe rumore.
    const motivo = /^HTTP \d+$/.test(fatti.error)
      ? fatti.error
      : codice === null ? fatti.error : `${codice} · ${fatti.error}`;
    return { emoji: "🔴", motivo, risposta: false };
  }
  if (fatti.notModified) return { emoji: "⚪️", motivo: `${codice ?? "HTTP 304"} · non è cambiata`, risposta: true };
  // Archivio migrato: la fonte ha risposto (l'ultimo tentativo è anche l'ultimo
  // successo) ma il codice non fu registrato. Non si scrive "· 0 item": quello
  // sembrerebbe una misura, e un dato che non c'è non è uno zero.
  if (fatti.httpStatus === null) return { emoji: "🟢", motivo: "ok, codice non registrato", risposta: true };
  // Il numero di item è il punto: "ha risposto ed è vuota" (0 item) e "non ha
  // risposto" sono due cose diverse, e a occhio sembrano la stessa.
  return { emoji: "🟢", motivo: `${codice} · ${itemLabel(fatti.items)}`, risposta: true };
}

/** Com'è andata una fonte in QUESTO giro. */
export function esitoTentativo(attempt: SourceAttempt): EsitoFonte {
  return esitoFonte(attempt);
}

/**
 * Com'è andato l'ULTIMO tentativo su quella fonte, letto dall'archivio: è quello
 * che mostra 📡 Fonti. Riuscito o no si capisce dal confronto fra l'ultimo giro e
 * l'ultimo successo — sono due colonne diverse di proposito, perché "quando ho
 * provato" e "quando è andata bene" non coincidono quasi mai.
 */
export function esitoUltimoTentativo(source: SourceRow): EsitoFonte {
  const fallito = source.lastRunAt !== null && source.lastOkAt !== source.lastRunAt;
  return esitoFonte({
    httpStatus: source.lastStatus,
    items: source.lastItems,
    notModified: source.lastStatus === 304,
    // In archivio il motivo di robots.txt è una stringa come le altre: si
    // riconosce da lì, perché il tentativo è tecnicamente riuscito.
    robotsDenied: source.lastError === ROBOTS_DENIED_REASON,
    error: fallito ? source.lastError : null,
  });
}

export interface IngestReport {
  attempts: SourceAttempt[];
  itemsSeen: number;
  itemsNew: number;
  /** Fonti rimandate per budget di CPU: non sono state provate. */
  deferred: number;
  /** Riga di testa: "Prima raccolta su GitHub", "Raccolta su GitHub n.2", "Raccolta a mano". */
  titolo: string;
}

/**
 * Il log della raccolta, in HTML. Raggruppato per esito — prima chi NON ha
 * risposto — perché è quello che si sta cercando quando lo si legge: le fonti che
 * funzionano non hanno bisogno di attenzione, le altre sì.
 */
export function formatIngestReport(report: IngestReport): string | null {
  const primo = report.attempts[0];
  if (!primo) return null;

  const esiti = report.attempts.map((attempt) => ({ attempt, esito: esitoTentativo(attempt) }));
  const muti = esiti.filter((entry) => !entry.esito.risposta);
  const risposte = esiti.filter((entry) => entry.esito.risposta);

  const righe = [
    `🧪 <b>${escapeHtml(report.titolo)}</b> · ${localTimeShort(new Date(primo.at))}`,
    `${report.attempts.length} fonti provate, <b>${risposte.length} hanno risposto</b>, ${muti.length} no` +
      ` · ${report.itemsSeen} item letti, ${report.itemsNew} nuovi`,
  ];

  const elenco = (voci: typeof esiti): string[] =>
    voci.map(
      ({ attempt, esito }) =>
        `${esito.emoji} ${escapeHtml(attempt.name)} · ${escapeHtml(truncate(esito.motivo, 60))}`,
    );

  if (muti.length > 0) righe.push("", "<b>Non hanno risposto</b>", ...elenco(muti));
  if (risposte.length > 0) righe.push("", "<b>Hanno risposto</b>", ...elenco(risposte));
  if (report.deferred > 0) {
    righe.push("", `${report.deferred} fonti rimandate al giro successivo (budget di CPU esaurito).`);
  }
  return righe.join("\n");
}

/** Le stesse righe in testo semplice: vanno nella pagina del job su GitHub. */
export function plainIngestLines(report: IngestReport): string[] {
  return report.attempts.map((attempt) => {
    const esito = esitoTentativo(attempt);
    return `- ${esito.emoji} **${attempt.name}** · ${truncate(esito.motivo, 80)}`;
  });
}

/**
 * Il log da salvare con l'esecuzione: il racconto delle fonti (chi ha risposto,
 * con che codice, quanti item) più le note della pipeline — una fonte che ha
 * fallito tre volte di fila, un tetto raggiunto, quel che è girato storto.
 *
 * Le note stanno QUI e non nella nota dell'esecuzione (`runs.note`, che è una
 * riga sola di conteggi) perché sono la spiegazione di quello che si sta
 * leggendo: nel log arriva tutto quello che serve a capire un giro, in un posto
 * solo. `null` se non c'è nessuna fonte da raccontare.
 */
export function ingestLog(report: IngestReport, notes: string[] = []): string | null {
  const testo = formatIngestReport(report);
  if (testo === null) return null;
  const righe = [testo];
  const vere = notes.filter((nota) => nota.trim().length > 0);
  if (vere.length > 0) {
    righe.push("", "⚠️ <b>Note del giro</b>", ...vere.map((nota) => `• ${escapeHtml(nota)}`));
  }
  return righe.join("\n");
}
