import type { RunRow } from "./types.ts";
import { localHour } from "./telegram/format.ts";

/**
 * Pianificazione: sta in un modulo separato perché tutto ciò che è esportato
 * dal file di entry (src/index.ts) viene interpretato da workerd come un
 * entry point del Worker — una costante esportata lì fa fallire l'avvio.
 */

/**
 * Cron dei digest, come dichiarati in wrangler.toml. Partono solo se qualche
 * chat ha acceso un'ora: senza, sono due tick in più (vedi jobFor).
 */
export const DIGEST_CRONS = ["5 6 * * *", "5 17 * * *"];
/**
 * Cron dei 15 minuti: avvisi istantanei e pulizia dell'archivio. La raccolta
 * dei feed non è più qui — la fa la raccolta esterna (GitHub Actions, o
 * `npm run ingest` da un PC), dalla cui rete le fonti bloccate verso Cloudflare
 * rispondono 200.
 */
export const NOTIFY_CRON = "*/15 * * * *";

/**
 * Finestra del digest con tolleranza di un'ora: il cron è in UTC, quindi in ora
 * legale italiana cade alle 8/19 e in ora solare alle 7/18.
 */
export function isDigestWindow(now: Date, hours: number[]): boolean {
  const hour = localHour(now);
  return hours.some((candidate) => Math.abs(hour - candidate) <= 1);
}

/**
 * Quale lavoro tocca a questo giro di cron.
 *
 * Con nessuna ora accesa (`digestHours: []`, che è il default) nessun giro è di
 * digest: i cron fissi fanno il tick normale — avvisi per chi li ha accesi,
 * promemoria, pulizia dei scaduti. Il riepilogo è una scelta, non un orologio.
 */
export function jobFor(cron: string, now: Date, digestHours: number[]): "digest" | "notify" {
  if (digestHours.length === 0) return "notify";
  if (DIGEST_CRONS.includes(cron)) return "digest";
  if (cron !== NOTIFY_CRON && isDigestWindow(now, digestHours)) return "digest";
  return "notify";
}

/**
 * La raccolta "esterna" non è il tick del Worker: è la stessa pipeline lanciata
 * dove la rete non è quella di Cloudflare, che diversi siti italiani bloccano
 * con un 403. I due posti in cui gira oggi sono GitHub Actions (`actions`) e il
 * PC di chi lancia `npm run ingest` (`local`); per il resto — ritardi, promemoria,
 * diagnostica — contano allo stesso modo, perché quello che conta è che la
 * raccolta sia VIVA, non da dove arriva.
 */
export const EXTERNAL_TRIGGERS = ["actions", "local"] as const;

/** true se questa riga di `runs` è una raccolta esterna e non un tick del Worker. */
export function isExternalTrigger(trigger: string): boolean {
  return (EXTERNAL_TRIGGERS as readonly string[]).includes(trigger);
}

/**
 * Da dove arriva un'esecuzione, come lo legge chi guarda 🕒 Ultime raccolte.
 * I tick del Worker non sono una raccolta: si distinguono perché il loro trigger
 * è l'espressione cron, non un nome.
 */
export function runOrigin(trigger: string): "GitHub" | "questo PC" | "Worker" {
  if (trigger === "actions") return "GitHub";
  if (trigger === "local") return "questo PC";
  return "Worker";
}

/**
 * La raccolta esterna gira ogni 30 minuti: se tace per più di due ore (secret
 * scaduto, workflow disattivato per inattività, GitHub in tilt, PC spento) il
 * Worker torna a raccogliere quel poco che la sua rete raggiunge, invece di
 * lasciare il radar muto senza che nessuno se ne accorga. È una rete di
 * sicurezza, non la via normale: la rete di Cloudflare è bloccata da diverse
 * fonti, quindi da qui passano poche fonti.
 */
export const FALLBACK_INGEST_AFTER_MS = 2 * 60 * 60 * 1000;

/** true se nessuna esecuzione della raccolta esterna è recente. */
export function shouldFallbackIngest(runs: RunRow[], now: Date): boolean {
  const ultima = runs.find((run) => isExternalTrigger(run.trigger));
  if (!ultima) return true;
  const at = Date.parse(ultima.startedAt);
  return !Number.isFinite(at) || now.getTime() - at > FALLBACK_INGEST_AFTER_MS;
}

/**
 * Il promemoria quando la raccolta non gira: tre ore di silenzio e nessuno se ne
 * accorge, perché il radar continua a consegnare quello che ha già in archivio.
 * È il guasto più insidioso dei due: una fonte rotta si vede in /fonti, la
 * raccolta esterna ferma no (vale per il job di GitHub come per il PC) — l'unico
 * segnale era la raccolta di riserva che partiva in silenzio.
 */
export const COLLECTION_SILENCE_MS = 3 * 60 * 60 * 1000;
/**
 * Distanza minima fra due promemoria. Un guasto che dura giorni non deve suonare
 * ogni quarto d'ora: quattro volte al giorno basta per non perderlo di vista, e
 * chi vuole sapere lo stato lo trova in 📡 Fonti.
 */
export const COLLECTION_REMINDER_GAP_MS = 6 * 60 * 60 * 1000;
/**
 * Il segno che il promemoria lascia nella nota dell'esecuzione, e il suo
 * contrario. Due stringhe diverse di proposito: il tick scrive una nota a ogni
 * giro, quindi un segno sempre presente falserebbe il controllo — il promemoria
 * risulterebbe "già inviato" per sempre. Si cerca solo `... inviato`.
 */
export const COLLECTION_REMINDER_MARK = "promemoria raccolta: inviato";
export const COLLECTION_REMINDER_SKIP = "promemoria raccolta: no";

export interface CollectionCheck {
  /** Ore dall'ultima raccolta esterna; null se non compare nella finestra. */
  oreDaRaccolta: number | null;
  /** Ore dall'ultima esecuzione in assoluto: il tick del Worker più recente. */
  oreDalTick: number | null;
  /** Quante ore copre la finestra di esecuzioni esaminate. */
  finestraOre: number | null;
  /** true = la raccolta su GitHub tace da più di COLLECTION_SILENCE_MS. */
  ferma: boolean;
  /** true = un promemoria è già partito da meno di COLLECTION_REMINDER_GAP_MS. */
  ripetuto: boolean;
  /** true = va mandato adesso: la raccolta è ferma e non l'abbiamo già detto. */
  avvisare: boolean;
}

/**
 * Decide se vale la pena avvisare che la raccolta non gira.
 *
 * Perché guarda una FINESTRA di esecuzioni e non una query mirata: i tick da 15
 * minuti riempiono `runs` in fretta, quindi una raccolta di dieci ore fa non è
 * nella finestra di 50 righe (circa dodici ore di tick). In quel caso il dato
 * esatto non c'è e il codice lo dice (`oreDaRaccolta: null`) invece di inventare
 * "mai girata": si riporta da quante ore copre la finestra, che è il massimo che
 * si può affermare, ed è già più che sufficiente per far scattare l'allarme.
 */
export function collectionCheck(runs: RunRow[], now: Date): CollectionCheck {
  const ore = (iso: string | null): number | null => {
    if (iso === null) return null;
    const at = Date.parse(iso);
    return Number.isFinite(at) ? (now.getTime() - at) / 3_600_000 : null;
  };

  const raccolta = runs.find((run) => isExternalTrigger(run.trigger)) ?? null;
  const tick = runs[0] ?? null;
  const ultima = runs[runs.length - 1] ?? null;
  const oreDaRaccolta = raccolta ? ore(raccolta.startedAt) : null;
  const oreDalTick = tick ? ore(tick.startedAt) : null;
  const finestraOre = ultima ? ore(ultima.startedAt) : null;
  const promemoria = runs.find((run) => (run.note ?? "").includes(COLLECTION_REMINDER_MARK)) ?? null;
  const oreDalPromemoria = promemoria ? ore(promemoria.startedAt) : null;

  const ferma = oreDaRaccolta === null || oreDaRaccolta * 3_600_000 > COLLECTION_SILENCE_MS;
  const ripetuto = oreDalPromemoria !== null && oreDalPromemoria * 3_600_000 < COLLECTION_REMINDER_GAP_MS;

  return {
    oreDaRaccolta,
    oreDalTick,
    finestraOre,
    ferma,
    ripetuto,
    avvisare: ferma && !ripetuto,
  };
}
