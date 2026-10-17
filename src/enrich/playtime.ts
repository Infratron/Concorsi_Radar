import { normalizeForExtraction } from "./rules.ts";

/**
 * Quando si gioca: la finestra oraria e la cadenza dei premi, lette dal bando.
 *
 * Perché esiste: un premio certo si ritira a orari che il bando dichiara
 * ("dalle 9:00 alle 20:00", "un premio ogni 15 minuti"), e chi apre la scheda
 * alle 22:30 deve sapere subito che adesso non c'è niente da fare. La scheda
 * sapeva dire cosa conservare e quando richiedere il premio, ma non quando
 * giocare.
 *
 * Vincolo di progetto, lo stesso di src/enrich/proof.ts: non si inventa niente.
 * Se il testo non dichiara un orario, la riga non c'è; se dichiara l'orario ma
 * non la cadenza, si mostra solo l'orario. Uno stato "adesso si gioca" senza
 * un orario dichiarato sarebbe una promessa che nessuno ha fatto.
 *
 * Si calcola al momento della scheda, non all'ingestione: la scheda mostra UN
 * item per volta e la finestra dipende dall'ora in cui la si guarda, quindi una
 * colonna salvata all'ingestione sarebbe sbagliata già il giorno dopo.
 */

export interface PlayWindow {
  /** Minuti dalla mezzanotte, 0..1440 (1440 = mezzanotte piena). */
  from: number;
  to: number;
  /** Etichetta pronta: "09:00–20:00". */
  label: string;
}

export interface PlayTime {
  window: PlayWindow | null;
  /** "un premio ogni 15 minuti", "un premio al giorno". */
  every: string | null;
  /** Restrizione di giorni dichiarata dal bando: "solo dal lunedì al venerdì". */
  days: string | null;
  status: "inside" | "outside" | "unknown";
  /** Perché si è fuori: l'orario o il giorno. */
  reason: "time" | "day" | null;
  /** "riapre alle 09:00" oppure "riapre domani alle 09:00". */
  opensAt: string | null;
}

interface DayRestriction {
  /** Giorni della settimana ammessi, 0 = domenica. */
  allowed: Set<number>;
  label: string;
}

const GIORNI: Record<string, number> = {
  domenica: 0,
  lunedi: 1,
  lunedì: 1,
  martedi: 2,
  martedì: 2,
  mercoledi: 3,
  mercoledì: 3,
  giovedi: 4,
  giovedì: 4,
  venerdi: 5,
  venerdì: 5,
  sabato: 6,
};

const NOMI_GIORNI = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

/** Il formattatore si costruisce una volta per isolate: la scheda si disegna a ogni tocco. */
const ROME_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Rome",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hour12: false,
});

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface RomeClock {
  /** Minuti dalla mezzanotte a Roma. */
  minutes: number;
  /** 0 = domenica. */
  weekday: number;
}

function romeClock(now: Date): RomeClock {
  const parts = ROME_CLOCK.formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  // Alcune implementazioni di ICU scrivono "24" per la mezzanotte.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    minutes: Number(hour) * 60 + Number(get("minute") || 0),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function clockLabel(minutes: number): string {
  // 1440 = fine giornata: si scrive "24:00", non "00:00", perché "09:00–00:00"
  // sembrerebbe una finestra che torna indietro.
  if (minutes === 1440) return "24:00";
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Un'ora valida come minuti dalla mezzanotte; null se il numero non è un'ora. */
function toMinutes(hour: string, minute: string | undefined): number | null {
  const h = Number(hour);
  const m = minute === undefined ? 0 : Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h === 24 && m === 0) return 1440;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/**
 * La finestra oraria del bando.
 *
 * Solo forme in cui il testo dice chiaramente "da un'ora a un'ora": "dalle 9
 * alle 20", "dalle ore 9:00 alle ore 20:00", "tra le 9 e le 21". La forma "dal
 * 1 al 5" è un intervallo di giorni, non di ore, e resta fuori perché il
 * connettivo richiesto è "alle/alla", non "al".
 */
export function playWindowFrom(text: string): PlayWindow | null {
  const lower = normalizeForExtraction(text).lower;
  const match =
    /\b(?:dalle|dalla|da)\s+(?:ore\s+)?(\d{1,2})(?:[:.,](\d{2}))?\s+(?:alle|alla|fino\s+alle|fino\s+alla)\s+(?:ore\s+)?(\d{1,2})(?:[:.,](\d{2}))?\b/.exec(
      lower,
    ) ??
    /\btra\s+le\s+(\d{1,2})(?:[:.,](\d{2}))?\s+e\s+le\s+(\d{1,2})(?:[:.,](\d{2}))?\b/.exec(lower);
  if (!match) return null;
  const from = toMinutes(match[1]!, match[2]);
  const to = toMinutes(match[3]!, match[4]);
  if (from === null || to === null) return null;
  // Una finestra di zero minuti non è una finestra: è un testo che parlava
  // d'altro ("dalle 9 alle 9" capita nelle date, non negli orari).
  if (from === to) return null;
  return { from, to, label: `${clockLabel(from)}–${clockLabel(to)}` };
}

/**
 * La cadenza dei premi: "un premio ogni 15 minuti", "un premio all'ora".
 *
 * Si cattura solo quando il testo dice che cosa si ripete (premio, vincitore,
 * estrazione, buono). "Puoi partecipare ogni 24 ore" è un limite di
 * partecipazione, non la frequenza dei premi, e non deve diventare "un premio
 * ogni 24 ore".
 */
export function prizeCadenceFrom(text: string): string | null {
  const lower = normalizeForExtraction(text).lower;
  const testa =
    "(?:un\\s+|una\\s+)?(?:premi[oi]|vincitor[ei]|vincitric[ei]|estrazion[ei]|vincit[ae]|buon[oi]|voucher|gift ?card)";
  const minuti = new RegExp(`\\b${testa}\\b[^.]{0,24}?\\bogni\\s+(\\d{1,3})\\s+minut[oi]\\b`).exec(lower);
  if (minuti) {
    const n = Number(minuti[1]);
    if (n >= 1 && n <= 1440) return `un premio ogni ${n} ${n === 1 ? "minuto" : "minuti"}`;
  }
  const ore = new RegExp(`\\b${testa}\\b[^.]{0,24}?\\bogni\\s+(\\d{1,2})\\s+or[ae]\\b`).exec(lower);
  if (ore) {
    const n = Number(ore[1]);
    if (n >= 1 && n <= 168) return `un premio ogni ${n} ${n === 1 ? "ora" : "ore"}`;
  }
  const mezz = new RegExp(`\\b${testa}\\b[^.]{0,24}?\\bogni\\s+mezz['’]?\\s*ora\\b`).exec(lower);
  if (mezz) return "un premio ogni mezz'ora";
  const ora = new RegExp(`\\b${testa}\\b[^.]{0,24}?\\b(?:ogni\\s+ora|all['’]\\s*ora|nell['’]\\s*ora)\\b`).exec(lower);
  if (ora) return "un premio all'ora";
  const giorno = new RegExp(`\\b${testa}\\b[^.]{0,24}?\\bogni\\s+giorno\\b`).exec(lower);
  if (giorno) return "un premio al giorno";
  return null;
}

/** La restrizione di giorni, quando il bando la dichiara. */
export function playDaysFrom(text: string): DayRestriction | null {
  const lower = normalizeForExtraction(text).lower;
  const intervallo =
    /\b(?:dal\s+)?(luned[ìi]|marted[ìi]|mercoled[ìi]|gioved[ìi]|venerd[ìi]|sabato|domenica)\s+(?:al|a)\s+(luned[ìi]|marted[ìi]|mercoled[ìi]|gioved[ìi]|venerd[ìi]|sabato|domenica)(?=\s|$|[.,;:])/.exec(
      lower,
    );
  if (intervallo) {
    const start = GIORNI[intervallo[1]!];
    const end = GIORNI[intervallo[2]!];
    if (start === undefined || end === undefined) return null;
    const allowed = new Set<number>();
    // Giro in avanti, così "dal sabato alla domenica" e "dalla domenica al
    // sabato" restano due intervalli diversi e nessuno esce dall'insieme.
    for (let day = start, guard = 0; guard < 7; day = (day + 1) % 7, guard++) {
      allowed.add(day);
      if (day === end) break;
    }
    if (allowed.size === 7) return null;
    return { allowed, label: `dal ${NOMI_GIORNI[start]} al ${NOMI_GIORNI[end]}` };
  }
  if (/\b(?:sabato\s+e\s+(?:la\s+)?domenica|nel\s+weekend|weekend|fine\s+settimana)\b/.test(lower)) {
    return { allowed: new Set([0, 6]), label: "sabato e domenica" };
  }
  const singolo =
    /\bsolo\s+(?:il\s+|la\s+)?(luned[ìi]|marted[ìi]|mercoled[ìi]|gioved[ìi]|venerd[ìi]|sabato|domenica)(?=\s|$|[.,;:])/.exec(
      lower,
    );
  if (singolo) {
    const day = GIORNI[singolo[1]!];
    if (day !== undefined) return { allowed: new Set([day]), label: `solo il ${NOMI_GIORNI[day]}` };
  }
  return null;
}

/**
 * La finestra e la cadenza insieme, più lo stato di adesso.
 *
 * `now` è l'istante in cui si disegna la scheda: lo stesso item può dire
 * "adesso si gioca" alle 10:00 e "riapre domani alle 09:00" alle 22:00.
 */
export function playTimeFor(input: { title: string; summary: string }, now: Date): PlayTime {
  const text = `${input.title}\n${input.summary}`;
  const window = playWindowFrom(text);
  const every = prizeCadenceFrom(text);
  const days = playDaysFrom(text);
  const base: PlayTime = {
    window,
    every,
    days: days?.label ?? null,
    status: "unknown",
    reason: null,
    opensAt: null,
  };
  if (!window) return base;

  const clock = romeClock(now);
  const dayAllowed = days === null || days.allowed.has(clock.weekday);
  const inTime =
    window.from < window.to
      ? clock.minutes >= window.from && clock.minutes < window.to
      : clock.minutes >= window.from || clock.minutes < window.to;

  if (!dayAllowed) return { ...base, status: "outside", reason: "day" };
  if (inTime) return { ...base, status: "inside" };

  // Fuori orario: dire anche quando riapre, perché è la sola cosa che manca
  // per decidere se aspettare o tornare domani.
  const afterClose = window.from < window.to && clock.minutes >= window.to;
  const opensAt =
    afterClose || window.from > window.to
      ? `riapre domani alle ${clockLabel(window.from)}`
      : `riapre alle ${clockLabel(window.from)}`;
  return { ...base, status: "outside", reason: "time", opensAt };
}
