import type { SourceRow } from "./types.ts";
import type { SourceStat } from "./db/store.ts";
import { esitoUltimoTentativo } from "./telegram/report.ts";

/**
 * Diagnostica delle fonti: quali valgono e quali no.
 *
 * Perché serve: la schermata 📡 Fonti dice se una fonte risponde ADESSO, e una
 * fonte che risponde benissimo può non aver mai portato un concorso in un mese —
 * un pattern troppo stretto, una pagina che è un catalogo, un feed che ripubblica
 * sempre cose già viste altrove. Sono proprio quelle che conviene togliere per
 * far posto a un'altra, e prima di oggi l'unico modo di accorgersene era contare
 * a mano gli item per fonte.
 *
 * Le regole stanno qui, pure e senza database: prendono la riga di stato della
 * fonte (l'ultimo tentativo, i fallimenti di fila) e il suo contributo
 * all'archivio (SourceStat, src/db/store.ts) e dicono una cosa sola per fonte —
 * che cosa non va e che farne. Le soglie sono costanti esportate, così il
 * perché di un verdetto si legge e si discute senza scavare nel codice.
 */

/** Fallimenti di fila oltre i quali una fonte è rotta, non sfortunata. */
export const ROTTA_DA_FALLIMENTI = 3;
/** Da quanto senza un tentativo la fonte non è più raggiunta dalla rotazione. */
export const NON_PROVATA_DA_MS = 24 * 3_600_000;
/**
 * Da quanto senza portare un concorso nuovo la fonte ha finito il suo lavoro.
 * Trenta giorni, come la finestra del vantaggio di tempistica: abbastanza da
 * coprire una promozione stagionale, corto abbastanza da accorgersene prima
 * dell'anno.
 */
export const ESAURITA_DA_MS = 30 * 86_400_000;

export type EsitoFonte =
  /** Fallisce (o ha appena fallito): il caso più chiaro. */
  | "rotta"
  /** Risponde e non porta concorsi: catalogo, pattern sbagliato, o niente. */
  | "catalogo"
  | "muta"
  | "vuota"
  /** Porta solo concorsi che hanno già trovato gli altri, o non ne porta più. */
  | "ripete"
  | "esaurita"
  /** Mai provata, o non provata da giorni: non è un motivo per toglierla. */
  | "mai-provata"
  | "non-provata"
  /** Fa il suo lavoro. */
  | "utile";

export interface Diagnosi {
  source: SourceRow;
  stat: SourceStat;
  esito: EsitoFonte;
  emoji: string;
  /** 0 = da guardare per primo. Ordina l'elenco. */
  gravita: number;
  /** Il fatto, in una riga. */
  motivo: string;
  /** Che farne, in una riga. Vuoto quando non c'è niente da fare. */
  consiglio: string;
}

/** Contributo di una fonte che non compare nell'archivio: zero, non "non lo so". */
export function fonteStat(stats: Record<string, SourceStat>, id: string): SourceStat {
  return stats[id] ?? { offers: 0, lastOfferAt: null, sightings: 0, discarded: 0 };
}

/**
 * Come si chiama, per QUESTA fonte, quello che porta in archivio: un concorso o
 * un coupon. Le fonti di coupon lo dichiarano nella categoria (src/config/sources.ts),
 * e la diagnostica usa la loro parola: dire "non ha mai portato un concorso" di
 * una fonte che pubblica buoni sconto sarebbe vero e inutile — quella fonte sta
 * facendo il suo lavoro, e il verdetto deve dirlo.
 */
function nomeOfferte(source: SourceRow): { uno: string; molti: string; nudo: string } {
  return source.category === "coupon"
    ? { uno: "un coupon", molti: "coupon", nudo: "coupon" }
    : { uno: "un concorso", molti: "concorsi", nudo: "concorso" };
}

/** Ore intere passate: "3 ore", "2 giorni" si compongono da qui. */
function durataDa(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "data sconosciuta";
  const ore = Math.max(0, Math.round(ms / 3_600_000));
  if (ore < 24) return ore <= 1 ? "un'ora" : `${ore} ore`;
  const giorni = Math.round(ore / 24);
  return giorni === 1 ? "un giorno" : `${giorni} giorni`;
}

/**
 * Com'è andato l'ULTIMO tentativo, in poche parole. Le parole sono quelle di
 * src/telegram/report.ts (`esitoUltimoTentativo`): il vocabolario degli esiti sta
 * in un posto solo, e la diagnostica lo cita invece di riscriverlo — altrimenti
 * la stessa fonte si racconterebbe in due modi in due schermate.
 *
 * L'unica eccezione è un archivio non ancora migrato: là una fonte che ha fallito
 * non ha né codice né errore registrati, e il vocabolario condiviso direbbe "ok"
 * (perché sa leggere solo i dati che ci sono). Per una fonte che ha appena fallito
 * "ok" è falso, quindi si dice che il motivo non è stato registrato.
 */
function ultimoTentativo(source: SourceRow): string {
  if (source.lastRunAt === null) return "mai provata";
  const fallito = source.lastOkAt !== source.lastRunAt;
  const senzaMotivo =
    fallito && (source.lastStatus === null || source.lastStatus === 304) && source.lastError === null;
  // Non "fallito, motivo non registrato": il fallimento lo dice già il testo che
  // viene prima ("3 giri di fila a vuoto", "l'ultimo giro è fallito").
  return senzaMotivo ? "motivo non registrato" : esitoUltimoTentativo(source).motivo;
}

/**
 * Le viste in cui la fonte ha portato un concorso che passa il cancello, cioè
 * quelle non scartate: `sightings` le conta tutte, `discarded` è il sottoinsieme
 * che non è passato.
 */
function visteUtili(stat: SourceStat): number {
  return Math.max(0, stat.sightings - stat.discarded);
}

/**
 * "3 giri", "un giro": il numero con il nome giusto. Il singolare arriva già
 * con il suo articolo ("una pagina", non "un pagina"), perché in italiano non
 * si ricava dal nome.
 */
function conteggio(quanti: number, singolare: string, plurale: string): string {
  return quanti === 1 ? singolare : `${quanti} ${plurale}`;
}

/**
 * Il verdetto su UNA fonte. L'ordine delle regole è la parte che conta: prima i
 * fallimenti (un guasto spiegherebbe tutto il resto), poi il contributo
 * all'archivio, e in fondo le due cose che NON sono un motivo per togliere una
 * fonte — non essere mai stata provata o non esserlo stata da un po'.
 */
export function diagnosiFonte(source: SourceRow, stat: SourceStat, now: Date): Diagnosi {
  const base = { source, stat };
  const nomi = nomeOfferte(source);

  if (source.failStreak >= ROTTA_DA_FALLIMENTI) {
    return {
      ...base,
      esito: "rotta",
      emoji: "🔴",
      gravita: 0,
      motivo: `${conteggio(source.failStreak, "un giro", "giri")} di fila a vuoto · ${ultimoTentativo(source)}`,
      consiglio: "Toglierla o cambiarle indirizzo in src/config/sources.ts, poi npm run db:seed.",
    };
  }
  if (source.failStreak > 0) {
    return {
      ...base,
      esito: "rotta",
      emoji: "🟠",
      gravita: 1,
      motivo: `l'ultimo giro è fallito · ${ultimoTentativo(source)}`,
      consiglio: `Se fallisce ancora una volta (${ROTTA_DA_FALLIMENTI} di fila) è rotta: toglierla o cambiarle indirizzo.`,
    };
  }
  if (source.lastRunAt === null) {
    return {
      ...base,
      esito: "mai-provata",
      emoji: "⚪️",
      gravita: 5,
      motivo: "mai provata: la rotazione non l'ha ancora toccata",
      consiglio: "Aspetta un giro prima di giudicarla.",
    };
  }
  // Le viste SCARTATE non contano come "concorsi visti": sono pagine che il
  // cancello di freschezza ha buttato, e una fonte piena di quelle è un catalogo,
  // non una che ripete gli altri (la regola sotto).
  if (stat.offers === 0 && visteUtili(stat) > 0) {
    return {
      ...base,
      esito: "ripete",
      emoji: "🟡",
      gravita: 2,
      motivo: `ha visto ${conteggio(visteUtili(stat), "un concorso", "concorsi")} ma in archivio li hanno fatti entrare gli altri`,
      consiglio: "Vale solo come conferma: se non ti serve un secondo parere, toglila.",
    };
  }
  if (stat.offers === 0 && stat.discarded > 0) {
    return {
      ...base,
      esito: "catalogo",
      emoji: "🟠",
      gravita: 2,
      motivo: `${conteggio(stat.discarded, "una pagina scartata", "pagine scartate")} e nessun concorso: porta catalogo, non concorsi`,
      consiglio: "Stringi includePattern su questa fonte, o toglila.",
    };
  }
  if (stat.offers === 0 && source.lastItems > 0) {
    return {
      ...base,
      esito: "muta",
      emoji: "🟠",
      gravita: 2,
      motivo: `ha letto ${conteggio(source.lastItems, "un item", "item")} e nessuno è diventato ${nomi.uno}`,
      consiglio: "Il pattern è troppo stretto (o la pagina non è un elenco): se non esce niente, toglila.",
    };
  }
  if (stat.offers === 0) {
    return {
      ...base,
      esito: "vuota",
      emoji: "🟡",
      gravita: 3,
      motivo: `risponde (${ultimoTentativo(source)}) e non ha mai portato ${nomi.uno}`,
      consiglio: "Se il prossimo giro non porta niente, al suo posto ci sta un'altra fonte.",
    };
  }
  if (stat.lastOfferAt !== null && now.getTime() - Date.parse(stat.lastOfferAt) > ESAURITA_DA_MS) {
    return {
      ...base,
      esito: "esaurita",
      emoji: "🟡",
      gravita: 3,
      motivo: `nessun ${nomi.nudo} nuovo da ${durataDa(stat.lastOfferAt, now)} (${conteggio(stat.offers, nomi.uno, nomi.molti)} in tutto)`,
      consiglio: "La pagina potrebbe essere cambiata: controllala, o sostituisci la fonte.",
    };
  }
  if (source.lastRunAt !== null && now.getTime() - Date.parse(source.lastRunAt) > NON_PROVATA_DA_MS) {
    return {
      ...base,
      esito: "non-provata",
      emoji: "⚪️",
      gravita: 4,
      motivo: `non viene provata da ${durataDa(source.lastRunAt, now)}: la rotazione non la raggiunge`,
      consiglio:
        "Non è un motivo per toglierla: con la raccolta su GitHub tutte le fonti si provano a ogni giro, qui invece il Worker ne tocca poche per volta.",
    };
  }

  const ultimo = stat.lastOfferAt === null ? "" : `, l'ultimo ${durataDa(stat.lastOfferAt, now)} fa`;
  return {
    ...base,
    esito: "utile",
    emoji: "✅",
    gravita: 6,
    motivo: `${conteggio(stat.offers, nomi.uno, nomi.molti)} in archivio${ultimo}`,
    consiglio: "",
  };
}

/**
 * Le fonti accese, con il verdetto, dalla più problematica. Le spente restano
 * fuori: sono già state tolte, e qui si sta decidendo cosa togliere.
 *
 * A parità di gravità viene prima chi ha reso di meno (e poi l'ordine
 * alfabetico), così dentro un gruppo l'elenco si legge dall'alto verso il basso
 * come una lista di candidati alla sostituzione.
 */
export function diagnosiFonti(
  sources: SourceRow[],
  stats: Record<string, SourceStat>,
  now: Date,
): Diagnosi[] {
  return sources
    .filter((source) => source.enabled)
    .map((source) => diagnosiFonte(source, fonteStat(stats, source.id), now))
    .sort(
      (a, b) =>
        a.gravita - b.gravita ||
        a.stat.offers - b.stat.offers ||
        a.source.name.localeCompare(b.source.name, "it"),
    );
}

/**
 * I gruppi con cui la schermata racconta i verdetti. Stanno qui e non in
 * screens.ts perché sono la stessa cosa delle regole: se un esito nuovo non
 * entrasse in un gruppo, non si vedrebbe in chat.
 */
export const GRUPPI_DIAGNOSI: { esiti: EsitoFonte[]; titolo: string }[] = [
  { esiti: ["rotta"], titolo: "Falliscono" },
  { esiti: ["catalogo", "muta", "vuota"], titolo: "Rispondono ma non portano concorsi" },
  { esiti: ["ripete", "esaurita"], titolo: "Non portano più niente di nuovo" },
  { esiti: ["mai-provata", "non-provata"], titolo: "Da controllare a parte" },
];

export interface RiepilogoDiagnosi {
  /** Fonti accese passate in rassegna. */
  accese: number;
  utili: number;
  rotte: number;
  /** Fonti da guardare davvero: rotte, mute o esaurite. */
  daGuardare: number;
}

/** I numeri della testata: quante fonti vanno guardate, e quante fanno il loro lavoro. */
export function riepilogoDiagnosi(diagnosi: Diagnosi[]): RiepilogoDiagnosi {
  const utili = diagnosi.filter((voce) => voce.esito === "utile").length;
  const rotte = diagnosi.filter((voce) => voce.esito === "rotta").length;
  const informative = diagnosi.filter(
    (voce) => voce.esito === "mai-provata" || voce.esito === "non-provata",
  ).length;
  return {
    accese: diagnosi.length,
    utili,
    rotte,
    daGuardare: diagnosi.length - utili - informative,
  };
}
