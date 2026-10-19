import type { ChatFilters, ItemKind, ItemQuery, ItemRow, Prefs, ReceiptRow, SourceRow, UiState } from "../types.ts";
import { truncate } from "../lib/text.ts";
import {
  CATEGORY_ORDER,
  PRIZE_QUICK_FILTERS,
  TAG_FILTERS,
  activeFilterCount,
  archivioKindFor,
  defaultFilters,
  filterChangeLabel,
  filterableSources,
  filtersFor,
  prizeFilterFor,
  withFilterChange,
  type FilterChange,
} from "../filters.ts";
import { INSEGNE, brandChoices, brandLabel, isBrandId } from "../config/brands.ts";
import { DAILY_PLAY_TAG } from "../enrich/rules.ts";
import { giroItems, giroOrder, isGiroHour, streakFrom, streakWindowStart } from "../giro.ts";
import { accoppiate, contaPerInsegna, ovunque, soloQui } from "../negozi.ts";
import { diagnosiFonti, riepilogoDiagnosi } from "../sources-health.ts";
import { rescoreRow } from "../enrich/score.ts";
import { mergedBrands, mergedWeights } from "../pipeline.ts";
import { EXTERNAL_TRIGGERS } from "../schedule.ts";
import { HELP_PAGES } from "./help.ts";
import type { TelegramMessage, TelegramUpdate } from "./api.ts";
import type { NotifyDeps } from "./digest.ts";
import { regolamentoUrl } from "./digest.ts";
import { localDateString, sourceLabel, startOfLocalDay } from "./format.ts";
import { parseEuroInput, rankByConvenience, refundAmountFor } from "../refunds.ts";
import { leadHours, summarizeLead } from "../enrich/lead.ts";
import { ACCOPPIATE_PAGE_SIZE, BRANDS_PAGE_SIZE, PAGE_SIZE, SHARE_BASE_DEFAULT } from "./keyboard.ts";
import { SCORE_MAX, SCORE_MIN, hourLabel, parseQuietRange, toggleDigestHour } from "./prefs-config.ts";
import {
  applyIntent,
  parseCallback,
  renderScreen,
  type ConfigKey,
  type Intent,
  type Screen,
  type ScreenCounts,
  type ScreenData,
} from "./screens.ts";

export type { NotifyDeps };

/**
 * Interfaccia del bot: menù a pulsanti su UN solo messaggio per chat.
 *
 * Come funziona: ogni tocco o comando diventa un Intent (src/telegram/screens.ts),
 * l'intento aggiorna lo stato della chat (`ui` in D1) e la schermata che ne
 * risulta viene *modificata* nel messaggio già presente — non ne viene mandato uno
 * nuovo. Il comando scritto dall'utente viene cancellato subito, così in chat
 * resta solo la schermata viva. Le notifiche (avvisi immediati) restano finché non
 * le usi: appena tocchi un bottone, il bot le toglie di mezzo.
 *
 * È privato: risponde solo ai chat id in ALLOWED_CHAT_IDS. Ogni update_id è
 * registrato, quindi i retry di Telegram non duplicano nulla.
 */

export interface BotDeps extends NotifyDeps {
  /** Chi riceve gli avvisi di sistema. */
  adminChatId: number;
  /** Chat autorizzati; se assente vale solo adminChatId. */
  allowedChatIds?: number[];
  /**
   * Origine pubblica del Worker (es. https://bot.example). Serve al bottone 📤
   * Condividi per puntare alla pagina `/share` (src/share.ts): lì il telefono
   * apre il suo pannello di condivisione, che è l'unico modo per arrivare a
   * WhatsApp e alle altre app. Assente = la costante di produzione.
   */
  shareBase?: string;
}

const WEEK_MS = 7 * 86_400_000;
/** Righe rilette per pagina nel ricalcolo dei punteggi di una marca. */
const RESCORE_PAGE = 200;
/**
 * Finestra della misura del vantaggio: 30 giorni. Abbastanza da avere casi, corta
 * abbastanza da non raccontare una velocità che nel frattempo è cambiata (le fonti
 * si accendono e si spengono, e l'anticipo di un mese fa non è quello di oggi).
 */
const VANTAGGIO_MS = 30 * 86_400_000;
/**
 * Quanti log si tengono a portata di mano in 🧾 Log delle raccolte.
 *
 * Venti raccolte: con la raccolta su GitHub ogni mezz'ora sono circa dieci ore
 * di storia — un guasto di stamattina c'è ancora, uno della settimana scorsa no.
 * La storia lunga non si perde, sta nella pagina dei job su GitHub; quello che
 * serve qui è leggere l'ultimo giro senza aprire un browser, e poter tornare
 * indietro di qualche lancio quando un guasto è appena passato.
 */
const LOGS_SHOWN = 20;

/**
 * Le preferenze di una chat che non ha mai toccato ⚙️ Impostazioni.
 *
 * Nessuna notifica non richiesta: il digest nasce spento (`digestHours: []`) e
 * anche gli avvisi per punteggio (`instantAlerts: false`). Quello che arriva
 * senza che nessuno l'abbia acceso è solo ciò che l'utente ha chiesto con un
 * gesto: un concorso in watchlist, una marca seguita.
 */
export function defaultPrefs(chatId: number): Prefs {
  return {
    chatId,
    active: true,
    weights: {},
    minScoreInstant: 80,
    quietHours: "23-7",
    digestHours: [],
    instantAlerts: false,
    filters: defaultFilters(),
  };
}

function weightsFor(tags: string[], delta: number): Record<string, number> {
  return Object.fromEntries(tags.map((tag) => [tag, delta]));
}

function shiftDate(dateString: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) return dateString;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function emptyState(chatId: number): UiState {
  return {
    chatId,
    messageId: null,
    section: "menu",
    page: 0,
    openItemId: null,
    lastCheckAt: null,
    updatedAt: null,
  };
}

/**
 * Dopo quante ore di silenzio il messaggio salvato non è più quello che l'utente
 * ha davanti.
 *
 * Perché non basta fidarsi dell'esito della modifica: dopo "Elimina
 * conversazione" Telegram accetta la modifica di un messaggio che l'utente non
 * vede più e risponde `ok`. Non c'è modo di distinguerlo da una modifica vera,
 * quindi l'unica difesa è non provarci con un messaggio vecchio — un tocco su un
 * avviso ricevuto la sera prima, con la chat svuotata nel frattempo, finiva in un
 * messaggio invisibile e la chat restava muta finché non si scriveva /start.
 *
 * Sei ore: copre la notte e tutte e due le finestre del digest (8 e 19), mentre
 * una conversazione vera — tocco dopo tocco, nella stessa sera — continua a
 * modificare lo stesso messaggio, che è il punto dell'interfaccia. Non è una
 * soglia di inattività dell'utente: è il tempo oltre il quale non si può più
 * dare per scontato che quel messaggio esista ancora.
 */
export const STALE_CHAT_MS = 6 * 60 * 60 * 1000;

/**
 * true se lo stato salvato è troppo vecchio per essere modificato: meglio aprire
 * un messaggio nuovo. Senza data ("non lo so": database scritto prima che il
 * campo esistesse) la risposta è sì — un messaggio in più è un fastidio, uno
 * schermo muto è un guasto.
 */
export function isStaleChat(updatedAt: string | null, now: Date): boolean {
  if (updatedAt === null) return true;
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return true;
  // Un'ora nel futuro (orologi diversi fra Worker e richiesta) non rende la chat
  // "fresca da sempre": si guarda solo il passato.
  return now.getTime() - at > STALE_CHAT_MS;
}

/**
 * Comandi → intenti. Sono una scorciatoia, non il modo normale di usare il bot:
 * il menù fa tutto. Restano perché sono comodi da tastiera e perché Telegram li
 * mostra nel menù "/".
 */
function intentForCommand(command: string, args: string): Intent | null {
  switch (command) {
    case "/start":
    case "/menu":
      return { kind: "home" };
    case "/giro":
      return { kind: "section", section: "giro" };
    case "/supermercato":
    case "/negozi":
      return { kind: "section", section: "negozi" };
    case "/scontrini":
      return { kind: "section", section: "scontrini" };
    case "/volantini":
    case "/volantino":
      return { kind: "section", section: "volantini" };
    case "/nuovi":
      return { kind: "section", section: "nuovi" };
    case "/oggi":
      return { kind: "section", section: "oggi" };
    case "/settimana":
      return { kind: "section", section: "settimana" };
    case "/scadenze":
      return { kind: "section", section: "scadenze" };
    case "/salvati":
    case "/watchlist":
      return { kind: "section", section: "salvati" };
    case "/storico":
      return { kind: "section", section: "storico" };
    case "/numeri":
      return { kind: "section", section: "numeri" };
    case "/coupon":
    case "/offerte":
      return { kind: "section", section: "coupon" };
    // /rimborsi è il SEGUITO del coupon, non la sua vetrina: qui ci sono le
    // richieste fatte da questa chat e quanto denaro deve ancora tornare.
    case "/rimborsi":
    case "/cashback":
      return { kind: "section", section: "rimborsi" };
    case "/gratis":
    case "/gratuiti":
      return { kind: "section", section: "gratis" };
    // La gemella di /gratis: i concorsi dove una spesa serve. Le due sezioni sono
    // le due metà dell'archivio, e si apre allo stesso modo, con un comando.
    case "/spesa":
    case "/acquisto":
    case "/acquisti":
      return { kind: "section", section: "spesa" };
    // Le due classi di contenuto nuove: un premio certo e un omaggio che si
    // riceve comprando. Sono porte di 🎁 Tipi di premio, quindi la scorciatoia
    // apre la stessa sezione del bottone (una query sola, un conteggio solo).
    case "/premio-certo":
    case "/premicerti":
      return { kind: "section", section: "premi:premio_certo" };
    case "/omaggi":
    case "/omaggio":
      return { kind: "section", section: "premi:omaggio_con_acquisto" };
    // L'archivio completo: tutto quello che è passato dal bot, chiusi compresi.
    case "/archivio":
    case "/passati":
      return { kind: "section", section: "archivio" };
    // La wiki: la stessa cosa del bottone ❓, anche scritta a mano.
    case "/aiuto":
    case "/help":
      return { kind: "section", section: "aiuto" };
    case "/vinti":
      return { kind: "section", section: "vinti" };
    case "/scaduti":
      return { kind: "section", section: "scaduti" };
    case "/ignorati":
      return { kind: "section", section: "ignorati" };
    case "/news":
    case "/articoli":
      return { kind: "section", section: "news" };
    case "/cerca":
      return { kind: "section", section: "cerca" };
    case "/fonti":
    case "/health":
      return { kind: "section", section: "fonti" };
    case "/vantaggio":
    case "/anticipo":
      return { kind: "section", section: "vantaggio" };
    case "/diagnostica":
    case "/utili":
      return { kind: "section", section: "diagnostica" };
    // Il log delle raccolte è una scorciatoia per l'admin: per gli altri la
    // sezione non si apre (vedi handleUpdate).
    case "/log":
    case "/raccolte":
      return { kind: "section", section: "log" };
    case "/impostazioni":
      return { kind: "section", section: "impostazioni" };
    case "/stop":
      return { kind: "config", key: "notify", value: "off" };
    case "/salva":
    case "/vinto":
    case "/ignora": {
      const itemId = Number.parseInt(args.split(/\s+/)[0] ?? "", 10);
      if (!Number.isFinite(itemId)) return { kind: "home" };
      const action = command === "/salva" ? "save" : command === "/vinto" ? "won" : "ign";
      return { kind: "decision", action, itemId };
    }
    default:
      return null;
  }
}

/**
 * Traduce un tocco sui filtri in un cambiamento, controllando che il valore
 * esista davvero: il `callback_data` arriva dal client, quindi un id inventato
 * non deve poter entrare in una preferenza.
 */
function filterChangeFor(key: ConfigKey, value: string): FilterChange | null {
  if (key === "cat") {
    return CATEGORY_ORDER.includes(value as (typeof CATEGORY_ORDER)[number])
      ? { kind: "category", value: value as (typeof CATEGORY_ORDER)[number] }
      : null;
  }
  if (key === "tag") {
    return TAG_FILTERS.some((entry) => entry.tag === value) ? { kind: "tag", value } : null;
  }
  if (key === "src") {
    return filterableSources().some((source) => source.id === value) ? { kind: "source", value } : null;
  }
  if (key === "free") return { kind: "free", value: value === "on" };
  if (key === "star") {
    const soglia = Number.parseInt(value, 10);
    return Number.isFinite(soglia) ? { kind: "star", value: soglia } : null;
  }
  if (key === "brand") {
    return isBrandId(value) ? { kind: "brand", value } : null;
  }
  if (key === "brands") {
    if (value === "reset") return { kind: "brandsReset" };
    if (value === "on" || value === "off") return { kind: "brandsOnly", value: value === "on" };
    return null;
  }
  if (key === "reset") return { kind: "reset" };
  return null;
}

/** Applica una preferenza scelta dalle impostazioni. Valori fuori elenco: ignorati. */
function withConfig(prefs: Prefs, key: ConfigKey, value: string): Prefs {
  if (
    key === "cat" || key === "tag" || key === "src" || key === "free" || key === "star" ||
    key === "brand" || key === "brands" || key === "reset"
  ) {
    const change = filterChangeFor(key, value);
    return change === null ? prefs : { ...prefs, filters: withFilterChange(prefs.filters, change) };
  }
  switch (key) {
    case "score": {
      const score = Number.parseInt(value, 10);
      return Number.isFinite(score) && score >= SCORE_MIN && score <= SCORE_MAX
        ? { ...prefs, minScoreInstant: score }
        : prefs;
    }
    // Un tocco sulla griglia del digest accende o spegne QUELLA ora: il valore
    // dice quale, non l'elenco che ne risulta (in un callback_data da 64 byte
    // ventiquattro ore non ci starebbero).
    case "hour": {
      if (!/^\d{1,2}$/.test(value)) return prefs;
      const hour = Number(value);
      return hour >= 0 && hour <= 23 ? { ...prefs, digestHours: toggleDigestHour(prefs.digestHours, hour) } : prefs;
    }
    case "quiet": {
      if (value === "off") return { ...prefs, quietHours: "" };
      const fascia = parseQuietRange(value);
      // Ore reali, non solo cifre: "99-99" non è una fascia di silenzio. La
      // fascia si riscrive dalle due ore invece di salvare il testo arrivato,
      // così "23 - 07" e "23-7" restano la stessa preferenza.
      return fascia === null ? prefs : { ...prefs, quietHours: `${fascia.start}-${fascia.end}` };
    }
    case "alerts":
      return { ...prefs, instantAlerts: value === "on" };
    case "digest": {
      if (value === "off") return { ...prefs, digestHours: [] };
      const hours = value
        .split(",")
        .map((chunk) => Number.parseInt(chunk, 10))
        .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
      return hours.length > 0 ? { ...prefs, digestHours: hours } : prefs;
    }
    case "notify":
      return { ...prefs, active: value === "on" };
    // L'ora del promemoria del giro: solo quelle offerte dai bottoni, o spento.
    case "giro": {
      if (value === "off") return { ...prefs, giroHour: null };
      const ora = Number.parseInt(value, 10);
      return isGiroHour(ora) ? { ...prefs, giroHour: ora } : prefs;
    }
    default:
      return prefs;
  }
}

/** Il messaggio in sovraimpressione: conferma l'effetto di ciò che hai toccato. */
function toastFor(intent: Intent, prefs: Prefs): string | null {
  if (intent.kind === "config") {
    const change = filterChangeFor(intent.key, intent.value);
    if (change !== null) return filterChangeLabel(prefs.filters, change, sourceLabel);
  }
  switch (intent.kind) {
    case "decision":
      return intent.action === "save"
        ? "⭐ In watchlist"
        : intent.action === "unsave"
          ? "☆ Fuori dalla watchlist"
          : intent.action === "ign"
            ? "🚫 Ignorato: i filtri si adattano"
            : "🏆 Complimenti!";
    case "refresh":
      return "🔄 Aggiornato";
    case "refund":
      return intent.action === "receive"
        ? "✅ Rimborso ricevuto"
        : intent.action === "undo"
          ? "↩️ Rimborso annullato"
          : intent.action === "ask"
            ? null
            : "💰 Rimborso registrato";
    case "refundAmount":
      return intent.cents === null ? "Scrivi un importo, es. 7,50" : "💰 Rimborso registrato";
    case "receiptDelete":
      return "🗑 Scontrino eliminato";
    case "mutedBrand":
      if (!isBrandId(intent.value)) return null;
      return filterChangeLabel(prefs.filters, { kind: intent.muted ? "muteBrand" : "unmuteBrand", value: intent.value }, brandLabel);
    case "config":
      if (intent.key === "score") return `🔔 Avvisi sopra ${prefs.minScoreInstant}/100`;
      if (intent.key === "quiet") {
        return prefs.quietHours ? `🌙 Silenzio ${prefs.quietHours.replace("-", "–")}` : "🌙 Silenzio disattivato";
      }
      if (intent.key === "alerts") {
        return prefs.instantAlerts ? "🔔 Avvisi per punteggio accesi" : "🔕 Avvisi per punteggio spenti";
      }
      if (intent.key === "digest") {
        return prefs.digestHours.length > 0 ? `📬 Digest alle ${prefs.digestHours.join(" e ")}` : "📬 Digest spenti";
      }
      if (intent.key === "giro") {
        return typeof prefs.giroHour === "number" ? `⏰ Promemoria alle ${prefs.giroHour}:00` : "🔕 Promemoria del giro spento";
      }
      if (intent.key === "hour") {
        const hour = Number.parseInt(intent.value, 10);
        // Spegnendo l'ultima ora il digest si ferma del tutto: va detto, perché
        // dalla griglia non si vede che quella era l'ultima accesa.
        if (prefs.digestHours.length === 0) return "📬 Digest spenti";
        return prefs.digestHours.includes(hour) ? `📬 Accesa ${hourLabel(hour)}` : `📬 Spenta ${hourLabel(hour)}`;
      }
      return prefs.active ? "▶️ Notifiche attive" : "⏸ Notifiche sospese";
    default:
      return null;
  }
}

/**
 * Query della sezione corrente, senza limit: il totale lo conta countItems.
 * Gli elenchi mostrano solo concorsi ancora in gioco: `expired` è lo stato che
 * il sistema dà a chi ha chiuso, e in chat non serve più (resta in archivio, e
 * il conteggio in testa dice quanti concorsi ci sono in tutto).
 */
const ATTIVI: ItemQuery["statuses"] = ["new", "sent"];
/**
 * La separazione che conta per l'utente: le sezioni dei concorsi mostrano SOLO
 * le pagine su cui si partecipa, gli articoli che ne parlano stanno in news.
 * Un aggregatore nella sezione concorsi vuol dire toccare un link e non
 * partecipare a niente: è lo spam che si vuole evitare.
 */
const CONCORSI: ItemKind[] = ["contest"];
const ARTICOLI: ItemKind[] = ["news"];
/**
 * Buoni sconto e rimborsi: la terza cosa che l'archivio contiene. Non stanno
 * nelle sezioni dei concorsi — non c'è niente da vincere, e chi guarda i concorsi
 * non sta cercando un coupon — né negli avvisi (vedi src/telegram/digest.ts).
 */
const COUPON: ItemKind[] = ["coupon"];

function baseSectionQuery(section: string, now: Date, lastCheckAt: string | null): ItemQuery {
  if (section === "news") return { kinds: ARTICOLI, statuses: ATTIVI };
  // 🆓 Gratis: i concorsi dove non si compra niente. È un vincolo sull'ARCHIVIO
  // (`withoutPurchase`), non sui tag: il tag "gratis" lo assegna l'arricchimento
  // leggendo le parole della pagina, e un concorso senza acquisto che non scrive
  // "gratis" da nessuna parte è uguale a tutti gli altri. L'ordine è per
  // punteggio, come le altre sezioni che suggeriscono: chi ha davanti a sé "solo
  // quelli che non costano" sta chiedendo quali vale la pena fare.
  //
  // Non è lo stesso filtro di 🎁 Solo senza acquisto (filtri personali): quello
  // cambia TUTTE le sezioni filtrate e resta acceso; questa è una domanda secca
  // che non tocca le preferenze.
  if (section === "gratis") {
    return { kinds: CONCORSI, statuses: ATTIVI, withoutPurchase: true, orderBy: "score" };
  }
  // 💸 Con acquisto: la gemella di 🆓 Gratis, e l'unica altra sezione che divide
  // l'archivio per quello che costa partecipare. Stesso vincolo sull'ARCHIVIO
  // (`withPurchase`), non sul tag "acquisto": quel tag lo assegna l'arricchimento
  // e può mancare. Insieme, le due sezioni coprono tutto: ogni concorso o chiede
  // una spesa o non la chiede, e adesso c'è un posto per ciascuna metà.
  if (section === "spesa") {
    return { kinds: CONCORSI, statuses: ATTIVI, withPurchase: true, orderBy: "score" };
  }
  // 🎁 Tipi di premio: `premi:<tag>` è "solo i concorsi con questo premio", in
  // INCLUSIONE (`tags`) — il contrario dei filtri personali, che sono esclusioni.
  // La visita d'ingresso alla schermata delle porte ha tag null e non passa da
  // qui. Il tag è uno di quelli offerti (vedi isKnownSection): una sezione
  // inventata non legge niente, invece di leggere tutto per sbaglio.
  const premio = prizeFilterFor(section);
  if (premio?.tag) {
    return { kinds: CONCORSI, statuses: ATTIVI, tags: [premio.tag], orderBy: "score" };
  }
  // 💶 Coupon: la sezione ha gli stessi tagli dei concorsi — tutti, oggi, ultimi
  // 7 giorni, in scadenza — più la fetta dei rimborsi. La regola di fondo è una
  // sola e vale per tutte: fuori i buoni la cui validità dichiarata è passata
  // (`deadlineNotBefore`), perché al negozio il codice non passa più. Chi non
  // dichiara una validità resta in tutte le viste: "non lo so" non è una prova,
  // e la vita corta dei coupon la misura comunque la pulizia periodica
  // (COUPON_TTL_DAYS in src/enrich/freshness.ts).
  //
  // L'ordine è quello di arrivo (il default dello store), non il punteggio: fra
  // buoni sconto "quale vale la pena" non vuol dire niente, mentre "quale è
  // arrivato adesso" sì — un coupon vecchio è un coupon scaduto. Solo ⏳ In
  // scadenza cambia criterio, e allora è la data a comandare.
  if (section === "coupon" || section.startsWith("coupon-")) {
    const base = { kinds: COUPON, statuses: ATTIVI, deadlineNotBefore: localDateString(now) };
    // 📋 Oggi e 📅 7 giorni guardano quando il coupon È ARRIVATO (first_seen_at),
    // come le omonime sezioni dei concorsi: sono le novità, non le scadenze.
    if (section === "coupon-oggi") return { ...base, since: startOfLocalDay(now) };
    if (section === "coupon-settimana") {
      return { ...base, since: new Date(now.getTime() - WEEK_MS).toISOString() };
    }
    // ⏳ In scadenza è l'altra domanda: quali buoni finiscono entro 7 giorni.
    // Qui serve una data dichiarata, quindi `deadlineBefore` (che esclude i null)
    // e non `deadlineNotBefore`; l'ordine è per data, chi chiude prima in cima.
    if (section === "coupon-scadenze") {
      return { ...base, deadlineBefore: shiftDate(localDateString(now), 7), orderBy: "deadline" };
    }
    // ↩️ Rimborsi e cashback: le offerte in cui si compra e tornano soldi
    // ("spendi e riprendi", rimborsi, cashback). Il tag lo mettono le fonti che
    // le pubblicano, quindi è una fetta dichiarata e non una deduzione dal
    // titolo; i buoni da ritagliare restano in 🗂 Tutti.
    if (section === "coupon-rimborsi") return { ...base, tags: ["cashback"] };
    return base;
  }
  // I concorsi delle marche seguite: stessa forma delle altre sezioni di
  // suggerimento (attivi, solo concorsi, dal punteggio più alto), il filtro sulle
  // marche lo mette sectionQuery.
  if (section === "preferiti-lista") {
    return { statuses: ATTIVI, kinds: CONCORSI, orderBy: "score" };
  }
  // Le tre sezioni dei concorsi si leggono dal punteggio più alto: la prima cosa
  // che si vede è quella che vale di più, e la riga delle stelle in fondo serve
  // proprio a tenere la testa della classifica. L'ordine per data di arrivo
  // (il default dello store) resta per 📰 News, dove "l'ultimo articolo" è
  // l'informazione giusta.
  if (section === "nuovi") {
    return {
      since: lastCheckAt ?? new Date(now.getTime() - WEEK_MS).toISOString(),
      statuses: ATTIVI,
      kinds: CONCORSI,
      orderBy: "score",
    };
  }
  // 📋 Oggi è il giorno di CALENDARIO, non le ultime 24 ore: alle 01:00 deve
  // mostrare quello che è arrivato da mezzanotte, non tutta la giornata di ieri.
  // La finestra che scorreva teneva in elenco il giorno prima fino a sera
  // inoltrata, e il nome della sezione prometteva un'altra cosa — chi vuole i due
  // giorni li ha in 📅 7 giorni.
  if (section === "oggi") {
    return {
      since: startOfLocalDay(now),
      statuses: ATTIVI,
      kinds: CONCORSI,
      orderBy: "score",
    };
  }
  if (section === "settimana") {
    return {
      since: new Date(now.getTime() - WEEK_MS).toISOString(),
      statuses: ATTIVI,
      kinds: CONCORSI,
      orderBy: "score",
    };
  }
  if (section === "scadenze") {
    // Solo scadenze future: un concorso già chiuso non serve in questa sezione.
    return {
      statuses: ["new", "sent"],
      kinds: CONCORSI,
      deadlineAfter: localDateString(now),
      deadlineBefore: shiftDate(localDateString(now), 7),
      orderBy: "deadline",
    };
  }
  if (section === "scaduti") {
    // Tutto quello che HA GIÀ CHIUSO, chi ha chiuso per ultimo in cima. Il limite
    // è IERI: un concorso che scade oggi è ancora aperto. Non si filtra sullo
    // stato: `expired` arriva tre giorni dopo la scadenza, e un concorso chiuso
    // ieri deve essere già consultabile nello storico.
    return { kinds: CONCORSI, deadlineBefore: shiftDate(localDateString(now), -1), orderBy: "deadline_desc" };
  }
  // 📚 Archivio: TUTTO quello che è passato dal bot, di qualunque tipo e in
  // qualunque stato — compresi i concorsi chiusi e i coupon scaduti, che dalle
  // altre sezioni escono (giustamente: lì si sta scegliendo cosa fare adesso) ma
  // restano la memoria del radar. "L'abbiamo mai visto?" è una domanda sul
  // passato, quindi l'ordine è quello di arrivo, dal più recente.
  //
  // I filtri della chat NON valgono qui, come in 🔍 Cerca: un coupon che non
  // trovi più perché hai spento la sua fonte sarebbe la sorpresa peggiore di
  // questa schermata (vedi SEZIONI_FILTRATE).
  if (section === "archivio") return {};
  const tipoArchivio = archivioKindFor(section);
  if (tipoArchivio !== null) return { kinds: [tipoArchivio] };

  // La ricerca guarda tutto — anche gli articoli, marcati 📰 nell'elenco — e
  // adesso anche il passato: "cerca nutella" deve trovare il concorso, il pezzo
  // che ne parla e quello che è già chiuso (marcato ⛔), perché "l'avevamo
  // visto?" si chiede quasi sempre di qualcosa che non c'è più in elenco.
  // Senza `statuses` la query non filtra sullo stato: è l'archivio intero.
  return { keyword: section.slice("cerca:".length), orderBy: "score" };
}

/**
 * Le sezioni che rispettano i filtri della chat. Sono quelle che *suggeriscono*
 * cosa guardare: è lì che un filtro serve, ed è lì che l'utente si aspetta che
 * valga. Restano fuori ⭐ Watchlist, 🗂 Storico, 🔍 Cerca e 📚 Archivio, che sono
 * scelte esplicite: un concorso salvato non deve sparire perché hai spento la
 * sua fonte, e "l'abbiamo mai visto?" è una domanda a cui i filtri non devono
 * rispondere al posto tuo.
 */
const SEZIONI_FILTRATE = new Set([
  "nuovi", "oggi", "settimana", "scadenze", "news", "scaduti", "preferiti-lista", "coupon", "gratis",
]);

/**
 * Se la sezione rispetta i filtri della chat. Sono i nomi dell'insieme più le
 * sezioni per tipo di premio, che sono un prefisso (`premi:giftcard`): anche lì
 * un filtro vale, perché anche lì il bot sta suggerendo cosa guardare.
 */
function isFilteredSection(section: string): boolean {
  // Anche le viste dei coupon (`coupon-oggi`, `coupon-scadenze`…) sono sezioni
  // che suggeriscono cosa guardare, quindi i filtri della chat valgono lì come
  // nella sezione intera.
  return SEZIONI_FILTRATE.has(section) || section.startsWith("premi:") || section.startsWith("coupon-");
}

function sectionQuery(section: string, now: Date, lastCheckAt: string | null, filters: ChatFilters): ItemQuery {
  const base = baseSectionQuery(section, now, lastCheckAt);
  // 💸 Con acquisto scavalca UNO solo dei filtri: "solo senza acquisto". Quello
  // acceso dice l'esatto contrario della porta, e lasciarlo agire darebbe un
  // elenco vuoto per costruzione (requires_purchase = 0 e = 1 insieme). Le altre
  // preferenze — fonti, tag, stelle, marche — valgono come in ogni sezione.
  if (section === "spesa") return filtersFor({ ...filters, freeOnly: false }, base);
  // La sezione dei preferiti è filtrata sulle marche seguite per definizione,
  // acceso o no il filtro "solo le marche seguite": quella è la sua ragione
  // d'essere, non una preferenza da accendere ogni volta.
  if (section === "preferiti-lista" && filters.favoriteBrands.length > 0) {
    return filtersFor(filters, { ...base, brands: [...filters.favoriteBrands] });
  }
  return isFilteredSection(section) ? filtersFor(filters, base) : base;
}

/** Sezioni il cui contenuto viene dalle decisioni di QUESTA chat, non da una query. */
const SEZIONI_CONSEGNA = new Set(["salvati", "vinti", "ignorati"]);

function isListSection(section: string): boolean {
  return (
    section === "nuovi" ||
    section === "oggi" ||
    section === "settimana" ||
    section === "scadenze" ||
    section === "news" ||
    section === "scaduti" ||
    section === "salvati" ||
    section === "vinti" ||
    section === "ignorati" ||
    section === "preferiti-lista" ||
    section === "scontrini" ||
    section === "coupon" ||
    section.startsWith("coupon-") ||
    section === "gratis" ||
    section === "spesa" ||
    section.startsWith("premi:") ||
    section.startsWith("cerca:") ||
    section.startsWith("archivio")
  );
}

/**
 * Watchlist in ordine di scadenza: chi chiude prima sta in cima, e chi non ha una
 * scadenza nota va in fondo. Senza questo ordine i salvati uscivano dal più
 * recente, cioè il contrario di quello che serve per non perdere un concorso.
 */
export function sortByDeadline(items: ItemRow[]): ItemRow[] {
  return [...items].sort((a, b) => {
    const left = a.deadline ?? "9999-12-31";
    const right = b.deadline ?? "9999-12-31";
    return left.localeCompare(right) || b.score - a.score || a.id - b.id;
  });
}

async function decisionFor(deps: BotDeps, chatId: number, itemId: number): Promise<string | null> {
  for (const kind of ["won", "ignored", "saved"] as const) {
    if (await deps.store.isDelivered(chatId, itemId, kind)) return kind;
  }
  for (const kind of ["instant", "digest"] as const) {
    if (await deps.store.isDelivered(chatId, itemId, kind)) return "sent";
  }
  return null;
}

/** Tutto ciò che serve a disegnare la schermata corrente. */
async function loadScreenData(
  deps: BotDeps,
  chatId: number,
  state: UiState,
  prefs: Prefs,
  now: Date,
): Promise<ScreenData> {
  const { store } = deps;
  const settimanaFa = new Date(now.getTime() - WEEK_MS).toISOString();
  const sinceNuovi = state.lastCheckAt ?? settimanaFa;
  const { filters } = prefs;
  const scadenza = sectionQuery("scadenze", now, null, filters);
  const scaduti = sectionQuery("scaduti", now, null, filters);
  // La watchlist è ordinata per scadenza: è la sua ragione d'essere.
  const salvati = sortByDeadline(await store.listDeliveredItems(chatId, "saved", 200));
  const oggi = localDateString(now);
  // 🎯 Il giro: il numero sta sul bottone della prima schermata, l'elenco nella
  // sua sezione, e la scheda di un concorso del giro ha ✅. Una ventina di righe.
  const servoGiro = state.section === "menu" || state.section === "giro" || state.openItemId !== null;
  const giro = servoGiro ? await giroItems(store, chatId, filters, now) : [];
  const giocati = servoGiro ? new Set(await store.playedOn(chatId, oggi)) : new Set<number>();
  const giroFatti = giro.filter((item) => giocati.has(item.id)).length;
  // 🧾 I concorsi con uno scontrino: il numero di ⭐ Le mie cose e il suo elenco.
  const conScontrino =
    state.section === "miei" || state.section === "scontrini" ? await store.receiptItems(chatId) : [];
  // 🛒 La spesa: concorsi attivi e coupon spendibili, una volta sola, poi divisi per
  // insegna in memoria — chi nomina un'insegna nel testo non si trova con una query.
  const sezioneNegozi = state.section === "negozi" || state.section.startsWith("negozio:");
  const perLaSpesa = sezioneNegozi ? await negozioCandidates(deps, filters, now) : [];
  const negozi = sezioneNegozi ? contaPerInsegna(perLaSpesa, INSEGNE) : {};
  const tuttoOvunque = sezioneNegozi ? ovunque(perLaSpesa) : [];
  // 📰 I volantini: nella loro sezione, nella scelta del negozio e in ogni insegna.
  const flyers = sezioneNegozi || state.section === "volantini" ? await store.listFlyers() : [];
  // 🤝 Le accoppiate di un'insegna: quello che si compra lì, cioè le sue
  // iniziative più quelle che valgono ovunque.
  const insegnaAperta = state.section.startsWith("negozio:") ? state.section.slice("negozio:".length).replace(/:coppie$/, "") : null;
  const tutteLeCoppie =
    insegnaAperta === null
      ? []
      : accoppiate(insegnaAperta === "ovunque" ? tuttoOvunque : [...soloQui(perLaSpesa, insegnaAperta), ...tuttoOvunque]);
  // Gli elenchi dello storico si leggono solo quando servono: nel menù di tutti i
  // giorni sarebbero due query in più per niente.
  // 📊 I tuoi numeri conta le stesse decisioni dello storico, quindi le legge
  // nello stesso posto: senza questa riga direbbe zero vinti a chi ne ha vinti.
  const storico =
    state.section === "storico" || state.section === "numeri" || SEZIONI_CONSEGNA.has(state.section);
  const vinti = storico ? await store.listDeliveredItems(chatId, "won", 200) : [];
  const ignorati = storico ? await store.listDeliveredItems(chatId, "ignored", 200) : [];
  // 💰 Rimborsi: i totali servono a ⭐ Le mie cose (il numero sul bottone) e alla
  // sua schermata; la lista si carica solo aprendola. Una scheda di coupon porta
  // la SUA richiesta, per mostrare se il denaro è tornato.
  const rimborsiNecessari =
    state.section === "miei" || state.section === "rimborsi" ||
    state.section === "numeri" || state.openItemId !== null;
  const refundTotals = rimborsiNecessari
    ? await store.refundTotals(chatId)
    : { pendingCents: 0, receivedCents: 0, pending: 0, received: 0, unknownPending: 0, unknownReceived: 0, capPending: 0, capReceived: 0 };
  const allRefunds =
    state.section === "rimborsi" && state.openItemId === null ? await store.listRefunds(chatId, 200) : [];

  // I conteggi sono query SQL di conteggio: non caricano righe, quindi il menù
  // resta leggero anche con un archivio grande.
  // I conteggi sono quelli che la chat VEDE (filtri compresi): un numero nel
  // menù che non corrisponde all'elenco è peggio di nessun numero. I totali
  // senza filtri si contano solo per poter dire "vedi 12 di 40".
  const [
    archiveTotal, contest, news, coupon, contestTotal, newsTotal, couponTotal,
    nuovi, quantiOggi, settimana, scadenze, quantiScaduti,
  ] = await Promise.all([
      store.countItems({}),
      store.countItems(filtersFor(filters, { kinds: CONCORSI })),
      store.countItems(filtersFor(filters, { kinds: ARTICOLI })),
      store.countItems(filtersFor(filters, { kinds: COUPON })),
      store.countItems({ kinds: CONCORSI }),
      store.countItems({ kinds: ARTICOLI }),
      store.countItems({ kinds: COUPON }),
      store.countItems(sectionQuery("nuovi", now, sinceNuovi, filters)),
      store.countItems(sectionQuery("oggi", now, null, filters)),
      store.countItems(sectionQuery("settimana", now, null, filters)),
      store.countItems(scadenza),
      // Il conteggio dei chiusi serve solo allo storico: fuori da lì resta a zero.
      state.section === "storico" ? store.countItems(scaduti) : Promise.resolve(0),
    ]);
  // Le porte di 🎁 Tipi di premio si contano solo quando si apre quella
  // schermata: sei query per un menù che non mostra quei numeri sarebbero lavoro
  // per niente, a ogni schermata. Anche le due metà dell'archivio (🆓 Gratis e
  // 💸 Con acquisto) stanno qui: il numero sul bottone nasce dalla STESSA query
  // della sezione, così il conto non può dire una cosa e l'elenco un'altra (è la
  // regola delle caselle finali del README).
  const premi: Record<string, number> = {};
  if (state.section === "premi") {
    for (const voce of PRIZE_QUICK_FILTERS) {
      premi[voce.section] = await store.countItems(sectionQuery(voce.section, now, null, filters));
    }
  }

  // I concorsi delle marche seguite si contano solo aprendo 🏷 Marche seguite:
  // è l'unico posto dove quel numero si legge, e nel menù il numero sul bottone
  // sono le marche, non i loro concorsi. Senza marche da seguire la sezione è
  // vuota per costruzione, e una query non filtrata conterebbe tutto l'archivio.
  const concorsiMarche =
    state.section === "preferiti" && filters.favoriteBrands.length > 0
      ? await store.countItems(sectionQuery("preferiti-lista", now, null, filters))
      : 0;

  const counts: ScreenCounts = {
    giroTotale: giro.length,
    giroFatti,
    scontrini: conScontrino.length,
    nuovi, oggi: quantiOggi, settimana, scadenze, news, contest, coupon, contestTotal, newsTotal, couponTotal,
    seguite: filters.favoriteBrands.length,
    concorsiMarche,
    premi,
    filtri: activeFilterCount(filters),
    salvati: salvati.length, vinti: vinti.length, ignorati: ignorati.length, scaduti: quantiScaduti,
    rimborsi: refundTotals.pending, rimborsiCents: refundTotals.pendingCents,
    rimborsiCap: refundTotals.capPending > 0,
  };

  const wantsList = state.openItemId === null && isListSection(state.section);
  let items: ItemRow[] = [];
  let total = 0;
  // Nessuna marca seguita = nessun concorso da leggere: è vuota per costruzione,
  // non per filtri, e interrogare l'archivio per saperlo sarebbe una query per
  // niente (e senza il filtro sulle marche leggerebbe tutto).
  const senzaMarche = state.section === "preferiti-lista" && filters.favoriteBrands.length === 0;
  if (wantsList && !senzaMarche) {
    // Le sezioni basate sulle consegne (watchlist, vinti, ignorati) sono liste
    // corte e già in memoria; le altre si pagano con LIMIT/OFFSET, quindi anche
    // un archivio grande si sfoglia tutto invece di fermarsi al primo carico.
    const daConsegne = state.section === "scontrini"
      ? conScontrino
      : SEZIONI_CONSEGNA.has(state.section)
        ? state.section === "salvati"
          ? salvati
          : state.section === "vinti"
            ? vinti
            : ignorati
        : null;
    const query = sectionQuery(state.section, now, state.lastCheckAt, filters);
    // ↩️ Rimborsi su spesa: la convenienza è un RAPPORTO fra due cifre lette dal
    // testo, non una colonna del database. Si carica tutto il mazzetto (i coupon
    // sono qualche decina), si ordina per "quanto torna per euro speso" e solo
    // dopo si ritaglia la pagina: ordinare la pagina già tagliata metterebbe in
    // cima il migliore dei sei arrivati, non il migliore in assoluto.
    if (state.section === "coupon-rimborsi") {
      const tutti = await store.queryItems({ ...query, limit: 200 });
      // La stessa offerta ripubblicata da più fonti è una riga sola: senza
      // questo passaggio la classifica della convenienza mostrava lo stesso
      // rimborso tre volte, con lo stesso rapporto. L'unione è di
      // visualizzazione — le righe restano in archivio, una per fonte.
      const ordinati = rankByConvenience(tutti);
      total = ordinati.length;
      const pagine = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const pagina = Math.min(Math.max(state.page, 0), pagine - 1);
      items = ordinati.slice(pagina * PAGE_SIZE, pagina * PAGE_SIZE + PAGE_SIZE);
    } else {
      total = daConsegne ? daConsegne.length : await store.countItems(query);
      const pagine = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const pagina = Math.min(Math.max(state.page, 0), pagine - 1);
      items = daConsegne
        ? daConsegne.slice(pagina * PAGE_SIZE, pagina * PAGE_SIZE + PAGE_SIZE)
        : await store.queryItems({ ...query, limit: PAGE_SIZE, offset: pagina * PAGE_SIZE });
    }
  }

  // 🎯 Il giro e 🛒 la spesa si ordinano in memoria (da fare prima, solo qui o
  // ovunque) e si ritagliano dopo, come i rimborsi su spesa.
  const ritaglia = (elenco: ItemRow[]): void => {
    total = elenco.length;
    const pagine = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pagina = Math.min(Math.max(state.page, 0), pagine - 1);
    items = elenco.slice(pagina * PAGE_SIZE, pagina * PAGE_SIZE + PAGE_SIZE);
  };
  if (state.openItemId === null && state.section === "giro") ritaglia(giroOrder(giro, giocati));
  if (state.openItemId === null && state.section.startsWith("negozio:") && !state.section.endsWith(":coppie")) {
    const insegna = state.section.slice("negozio:".length);
    ritaglia(insegna === "ovunque" ? tuttoOvunque : soloQui(perLaSpesa, insegna));
  }

  // 💰 Rimborsi non è un elenco di item: il totale da paginare è quello delle
  // richieste, e la pagina si ritaglia in fondo (dopo che è stata riportata
  // dentro l'intervallo valido).
  if (state.section === "rimborsi" && state.openItemId === null) total = allRefunds.length;

  // La domanda sull'importo (`importo:<id>`) non apre la scheda, ma ha bisogno
  // del titolo dell'offerta: l'item si legge lo stesso, una volta sola.
  // Lo scontrino che si guarda (`scontrini:<id>`) porta il titolo del suo concorso.
  const idAperto =
    state.openItemId ??
    (state.section.startsWith("importo:") ? Number.parseInt(state.section.slice("importo:".length), 10) : null) ??
    (state.section.startsWith("scontrini:") ? Number.parseInt(state.section.slice("scontrini:".length), 10) : null);
  const openItem = idAperto !== null && Number.isFinite(idAperto) ? await store.getItem(idAperto) : null;
  // La richiesta di rimborso si legge solo sulla scheda di un coupon: sugli altri
  // item non esiste, e una query per niente a ogni scheda sarebbe lavoro sprecato.
  const refund =
    state.openItemId !== null && openItem?.kind === "coupon"
      ? await store.getRefund(chatId, state.openItemId)
      : null;
  const decision = state.openItemId !== null ? await decisionFor(deps, chatId, state.openItemId) : null;
  // Gli scontrini: sulla scheda (quanti sono) e nella schermata dello scontrino.
  const receipts: ReceiptRow[] =
    openItem !== null && (state.openItemId !== null || state.section.startsWith("scontrini:"))
      ? await store.listReceipts(chatId, openItem.id)
      : [];
  const dailyOpen =
    state.openItemId !== null && openItem !== null && openItem.kind === "contest" && openItem.tags.includes(DAILY_PLAY_TAG)
      ? { played: giocati.has(openItem.id) }
      : null;
  // La serie di giorni si legge solo nella schermata del giro.
  const streak =
    state.section === "giro" && state.openItemId === null
      ? streakFrom(await store.playDays(chatId, streakWindowStart(oggi)), oggi)
      : 0;
  // Il vantaggio di tempistica si legge solo dove serve: una query sulle viste a
  // ogni menù sarebbe sprecata. La scheda invece porta l'anticipo del SUO
  // concorso — è il "per ogni concorso" della misura.
  const lead =
    state.section === "vantaggio"
      ? summarizeLead(await store.listSightings(new Date(now.getTime() - VANTAGGIO_MS).toISOString()), now)
      : null;
  const leadDelConcorso =
    state.openItemId !== null ? leadHours(await store.listItemSightings(state.openItemId)) : null;
  // 📡 Scegli le fonti: la lista delle fonti spegnibili (dalla configurazione,
  // che è dove vivono le categorie) si pagina come gli elenchi.
  // Le fonti si leggono in tre schermate (📡 Fonti, vantaggio, diagnostica): una
  // lettura sola, e la diagnostica aggiunge il contributo di ognuna — due query
  // (items e viste) che fuori da lì sarebbero sprecate.
  const sezioneFonti =
    state.section === "fonti" || state.section === "vantaggio" || state.section === "diagnostica";
  const fonti = sezioneFonti ? await store.getSources() : ([] as SourceRow[]);
  const diagnosi = state.section === "diagnostica" ? diagnosiFonti(fonti, await store.sourceStats(), now) : [];

  // 🧾 Log delle raccolte: è dell'admin, e i log si leggono solo aprendo quella
  // schermata (sono kilobyte di dettaglio: leggerli a ogni menù sarebbe lavoro
  // per niente). Venti raccolte all'indietro, una per schermata.
  const isAdmin = chatId === deps.adminChatId;
  const logs = isAdmin && state.section === "log" ? await store.recentLogs(LOGS_SHOWN) : [];

  const tutteLeFonti = state.section === "filtri-fonti" ? filterableSources() : [];
  const pagineFonti = Math.max(1, Math.ceil(tutteLeFonti.length / PAGE_SIZE));
  const paginaFonti = Math.min(Math.max(state.page, 0), pagineFonti - 1);

  // Le marche da seguire, ordinate da chi ha più concorsi in archivio: il
  // registro è lungo e mostrarlo tutto in tre pagine serve solo a chi lo scorre.
  const marche =
    state.section === "preferiti" ? brandChoices(await store.brandCounts(), filters.favoriteBrands) : [];

  // La paginazione vale anche per le sezioni che non sono elenchi di item: il
  // totale su cui si contano le pagine è il loro, altrimenti lo stato della
  // pagina verrebbe riportato a 0 a ogni tocco. Il passo cambia con la
  // schermata — le marche stanno due per riga, con i log è una raccolta per
  // schermata — e il conto deve usare lo stesso passo della tastiera: se il passo
  // fosse quello degli elenchi (6), due log farebbero UNA pagina e la freccia
  // «Più vecchio» riporterebbe alla stessa raccolta.
  const unoAllaVolta = state.section === "log" || state.section === "aiuto" || state.section.startsWith("scontrini:");
  const coppie = state.section.endsWith(":coppie");
  const passo = unoAllaVolta ? 1 : state.section === "preferiti" ? BRANDS_PAGE_SIZE : coppie ? ACCOPPIATE_PAGE_SIZE : PAGE_SIZE;
  const totalePagine =
    coppie
      ? tutteLeCoppie.length
      : state.section.startsWith("scontrini:")
      ? receipts.length
      : state.section === "filtri-fonti"
      ? tutteLeFonti.length
      : state.section === "preferiti"
        ? marche.length
        : state.section === "log"
          ? logs.length
          : state.section === "aiuto"
            // Una pagina di wiki alla volta: le frecce sono le voci del catalogo,
            // non i concorsi. È anche il motivo per cui `page` qui è l'indice.
            ? HELP_PAGES.length
            : total;
  const pagine = Math.max(1, Math.ceil(totalePagine / passo));
  // A scheda aperta nessun elenco è caricato (`total` vale 0), quindi il limite
  // delle pagine sarebbe 1 e la pagina tornerebbe a zero: è il motivo per cui,
  // uscendo dall'ennesimo concorso aperto da pagina 5 di 6, ci si ritrovava a
  // pagina 1. La pagina dell'elenco resta quella che era.
  // `aiuto` tiene `page: -1` per l'INDICE degli argomenti: è un valore legittimo,
  // non una pagina fuori intervallo, e il clamp a zero lo riporterebbe alla prima
  // pagina — cioè l'indice non esisterebbe mai.
  const page =
    state.openItemId !== null
      ? state.page
      : state.section === "aiuto"
        ? Math.min(state.page, pagine - 1)
        : Math.min(Math.max(state.page, 0), pagine - 1);

  return {
    counts,
    page,
    items,
    total,
    logs,
    isAdmin,
    openItem,
    decision,
    refund,
    refunds: allRefunds.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    refundTotals,
    regolamentoUrl: openItem ? regolamentoUrl(openItem) : null,
    sources: fonti,
    runs: state.section === "fonti" ? await store.recentRuns(4) : [],
    // La testata del menù dice quando ha raccolto il bot, non quando hai guardato
    // tu: è una riga sola e una query sola, e serve solo dove la testata si legge.
    ultimaRaccolta: state.section === "menu" ? await store.lastRunAt(EXTERNAL_TRIGGERS) : null,
    lead,
    leadDelConcorso,
    diagnosi,
    diagnosiRiepilogo: diagnosi.length > 0 ? riepilogoDiagnosi(diagnosi) : null,
    prefs,
    archiveTotal,
    filterSources: tutteLeFonti.slice(paginaFonti * PAGE_SIZE, paginaFonti * PAGE_SIZE + PAGE_SIZE),
    filterSourcesTotal: tutteLeFonti.length,
    brandChoices: marche.slice(page * BRANDS_PAGE_SIZE, page * BRANDS_PAGE_SIZE + BRANDS_PAGE_SIZE),
    brandChoicesTotal: marche.length,
    shareBase: deps.shareBase ?? SHARE_BASE_DEFAULT,
    giroPlayed: [...giocati],
    streak,
    negozi,
    negoziOvunque: tuttoOvunque.length,
    flyers,
    accoppiate: tutteLeCoppie.slice(page * ACCOPPIATE_PAGE_SIZE, page * ACCOPPIATE_PAGE_SIZE + ACCOPPIATE_PAGE_SIZE),
    accoppiateTotal: tutteLeCoppie.length,
    receipts,
    dailyOpen,
    avviso: null,
  };
}

/**
 * Quello che si può comprare adesso: concorsi attivi e coupon ancora spendibili,
 * con i filtri della chat (fonti e marche spente restano spente). Due filtri non
 * valgono qui, come in 💸 Con acquisto: "solo senza acquisto" svuoterebbe per
 * costruzione la lista della spesa, e le stelle tagliano una classifica, non una
 * lista di cose da comprare.
 */
async function negozioCandidates(deps: BotDeps, filters: ChatFilters, now: Date): Promise<ItemRow[]> {
  const larghi = { ...filters, freeOnly: false, minScore: 0 };
  const tutti: ItemRow[] = [];
  const query = [
    filtersFor(larghi, { kinds: CONCORSI, statuses: ATTIVI, deadlineNotBefore: localDateString(now), orderBy: "score" }),
    filtersFor(larghi, { kinds: COUPON, statuses: ATTIVI, deadlineNotBefore: localDateString(now), orderBy: "score" }),
  ];
  for (const base of query) {
    // ponytail: pagine da 200 fino a 1000 righe; oltre servirebbe una colonna per insegna.
    for (let offset = 0; offset < 1000; offset += 200) {
      const pagina = await deps.store.queryItems({ ...base, limit: 200, offset });
      tutti.push(...pagina);
      if (pagina.length < 200) break;
    }
  }
  return tutti;
}

/**
 * Il file di un messaggio, se è uno scontrino possibile: la foto più grande, o un
 * documento immagine/PDF. Un altro documento risponde null (non lo conservo).
 */
function receiptMediaOf(message: TelegramMessage): { type: "photo" | "document"; fileId: string; fileUniqueId: string } | null {
  const foto = message.photo?.[message.photo.length - 1];
  if (foto) return { type: "photo", fileId: foto.file_id, fileUniqueId: foto.file_unique_id };
  const documento = message.document;
  if (documento && /^(image\/|application\/pdf$)/.test(documento.mime_type ?? "")) {
    return { type: "document", fileId: documento.file_id, fileUniqueId: documento.file_unique_id };
  }
  return null;
}

/**
 * Ricalcola i punteggi dei concorsi di una marca, con le preferenze di adesso.
 *
 * Il bonus della marca seguita si applica all'ingestione, quindi da solo
 * varrebbe solo per i concorsi che arrivano dopo: accendere Ferrero oggi e
 * trovarsi i concorsi Ferrero di ieri fermi a 62 punti sarebbe una promessa non
 * mantenuta. Qui si rifà lo stesso conto su quello che c'è già in archivio (è la
 * stessa funzione dell'ingestione, src/enrich/score.ts), una pagina per volta.
 *
 * Si chiama solo sui cambi delle marche: è lavoro che si fa per un tocco, non a
 * ogni schermata.
 */
async function rescoreBrand(deps: BotDeps, brand: string, now: Date): Promise<number> {
  const weights = await mergedWeights(deps.store);
  const favorites = await mergedBrands(deps.store);
  let cambiati = 0;
  for (let offset = 0; ; offset += RESCORE_PAGE) {
    const righe = await deps.store.queryItems({ brands: [brand], limit: RESCORE_PAGE, offset });
    if (righe.length === 0) break;
    for (const riga of righe) {
      const score = rescoreRow(riga, weights, favorites, now);
      if (score === riga.score) continue;
      await deps.store.updateItem(riga.id, { score });
      cambiati++;
    }
    if (righe.length < RESCORE_PAGE) break;
  }
  return cambiati;
}

/**
 * Applica la schermata all'unico messaggio della chat.
 *
 * Due strade, e la differenza conta:
 *  - `fresh` (comando o testo scritto): si toglie il messaggio precedente e se ne
 *    manda uno nuovo. Non si può modificare, perché non è detto che quel
 *    messaggio sia ancora visibile: dopo "Elimina conversazione" Telegram accetta
 *    la modifica di un messaggio che l'utente non vede più (risponde ok) e la chat
 *    resta muta. Fidarsi di quell'esito è quello che rendeva il bot sordo a
 *    /start: il comando veniva cancellato e il menù finiva in un messaggio
 *    invisibile.
 *  - tocco su un bottone: il messaggio lo si è appena toccato, quindi è visibile
 *    per definizione e si modifica sul posto (è il punto dell'interfaccia: un solo
 *    messaggio in chat) — a meno che l'ultima interazione sia di ore fa: in quel
 *    caso anche un tocco apre un messaggio nuovo (vedi STALE_CHAT_MS), perché il
 *    messaggio salvato può essere stato cancellato insieme alla conversazione.
 *
 * La cancellazione del vecchio è "best effort": se non esiste più, l'errore non
 * cambia niente.
 */
async function paint(
  deps: BotDeps,
  chatId: number,
  state: UiState,
  screen: Screen,
  fresh: boolean,
): Promise<UiState> {
  // Lo scontrino è un messaggio con un file: si sfoglia cambiando il file, e si
  // apre (o si lascia) sostituendo il messaggio, perché Telegram non trasforma un
  // testo in una foto né il contrario.
  if (screen.media) {
    if (!fresh && state.messageId !== null) {
      const edited = await deps.tg.editMessageMedia(chatId, state.messageId, screen.media, screen.text, { keyboard: screen.keyboard });
      if (edited.ok) return state;
    }
    if (state.messageId !== null) await deps.tg.deleteMessage(chatId, state.messageId);
    const inviato = await deps.tg.sendMedia(chatId, screen.media, screen.text, { keyboard: screen.keyboard });
    return inviato.ok ? { ...state, messageId: inviato.messageId } : state;
  }
  if (!fresh && state.messageId !== null) {
    const edited = await deps.tg.editMessageText(chatId, state.messageId, screen.text, { keyboard: screen.keyboard });
    if (edited.ok) return state;
  }
  if (state.messageId !== null) await deps.tg.deleteMessage(chatId, state.messageId);
  const sent = await deps.tg.sendMessage(chatId, screen.text, {
    keyboard: screen.keyboard,
    disablePreview: true,
  });
  // Se l'invio non riesce (per esempio 429) non perdiamo il messaggio precedente:
  // meglio riprovare a modificarlo che dimenticare dove sta la schermata.
  if (!sent.ok) return state;
  return { ...state, messageId: sent.messageId };
}

export async function handleUpdate(update: TelegramUpdate, deps: BotDeps): Promise<{ handled: boolean }> {
  const { store, tg, now, adminChatId } = deps;
  const allowed = new Set(deps.allowedChatIds && deps.allowedChatIds.length > 0 ? deps.allowedChatIds : [adminChatId]);
  const nowIso = now.toISOString();

  const callback = update.callback_query;
  const message = update.message;
  const chatId = callback?.message?.chat.id ?? message?.chat.id;
  if (chatId === undefined) return { handled: false };
  const media = message ? receiptMediaOf(message) : null;
  const conFile = message?.photo !== undefined || message?.document !== undefined;
  if (!callback && message?.text === undefined && !conFile) return { handled: false };

  // Il cancello viene PRIMA di ogni scrittura: un estraneo che scrive al bot non
  // deve poter riempire `updates` di righe, né consumare le scritture di D1.
  if (!allowed.has(chatId)) {
    // Il tuo id è la chiave d'accesso: lo mostriamo così l'admin può aggiungerti.
    if (callback) await tg.answerCallbackQuery(callback.id, "⛔ Bot privato.");
    else {
      await tg.sendMessage(
        chatId,
        `⛔ Bot privato. Il tuo chat id è <code>${chatId}</code>: chiedi di aggiungerlo a ALLOWED_CHAT_IDS.`,
      );
    }
    return { handled: true };
  }

  if (!(await store.claimUpdate(update.update_id, nowIso))) return { handled: false };

  const state = (await store.getUiState(chatId)) ?? emptyState(chatId);
  // Prefisso `d:` = il tocco arriva da un digest: quel messaggio è contenuto da
  // rileggere, quindi non si cancella. Un avviso immediato invece ha già fatto il
  // suo lavoro appena lo usi, e allora sparisce: in chat non resta niente appeso.
  const datiCallback = callback?.data ?? "";
  const conserva = datiCallback.startsWith("d:");
  const notificationId =
    !conserva && callback?.message?.message_id !== undefined && callback.message.message_id !== state.messageId
      ? callback.message.message_id
      : null;

  let prefs = (await store.getPrefs(chatId)) ?? defaultPrefs(chatId);

  // Il comando scritto dall'utente sparisce subito: in chat resta la schermata.
  if (message) await tg.deleteMessage(chatId, message.message_id);

  let intent: Intent;
  // Un messaggio scritto apre un messaggio nuovo (vedi paint): i bottoni no.
  const fresh = !callback;
  if (callback) {
    intent = parseCallback(conserva ? datiCallback.slice(2) : datiCallback);
  } else if (conFile) {
    // Una foto (o un PDF) è uno scontrino: lo prende il concorso aperto.
    intent = { kind: "receiptAdd", media };
  } else {
    const text = (message?.text ?? "").trim();
    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = (rawCommand ?? "").toLowerCase().replace(/@[\w_]+$/, "");
    const fromCommand = command.startsWith("/") ? intentForCommand(command, rest.join(" ")) : null;
    if (fromCommand) intent = fromCommand;
    // Senza comando: se la chat è in modalità ricerca, il testo è la ricerca.
    else if (state.section === "cerca" && text.length > 0) intent = { kind: "section", section: `cerca:${truncate(text, 40)}` };
    // In 💰 la risposta è l'importo: "7,50" è il rimborso di quell'offerta. Un
    // testo che non è una cifra non registra niente e la domanda resta lì.
    else if (state.section.startsWith("importo:") && text.length > 0) {
      const itemId = Number.parseInt(state.section.slice("importo:".length), 10);
      intent = Number.isFinite(itemId)
        ? { kind: "refundAmount", itemId, cents: parseEuroInput(text) }
        : { kind: "home" };
    } else intent = { kind: "home" };
  }

  // 🧾 Log delle raccolte è la schermata dell'admin: il bottone non compare
  // nella tastiera dell'altra persona, e questo è il secondo cancello — un
  // callback_data vecchio non apre una schermata che non è sua.
  if (intent.kind === "section" && intent.section === "log" && chatId !== adminChatId) {
    intent = { kind: "home" };
  }

  if (intent.kind === "decision") {
    const item = await store.getItem(intent.itemId);
    if (!item) {
      if (callback) await tg.answerCallbackQuery(callback.id, "Concorso non trovato");
      return { handled: true };
    }
    const kind = intent.action === "save" ? "saved" : intent.action === "ign" ? "ignored" : "won";
    if (intent.action === "unsave") {
      // Uscire dalla watchlist è la stessa decisione al contrario: la riga
      // sparisce e il peso dei gusti torna com'era. Se non c'era niente da
      // togliere (doppio tocco, o un bottone vecchio) non si annulla due volte.
      if (await store.deleteDelivery(chatId, intent.itemId, "saved")) {
        await store.bumpWeights(chatId, weightsFor(item.tags, -1));
      }
    } else {
      const ripetuta = await store.isDelivered(chatId, intent.itemId, kind);
      await store.recordDelivery(chatId, intent.itemId, kind, nowIso);
      // Decidere due volte la stessa cosa (doppio tocco sullo stesso bottone, o
      // scheda e digest dello stesso concorso) non sposta i pesi due volte.
      if (intent.action !== "won" && !ripetuta) {
        await store.bumpWeights(chatId, weightsFor(item.tags, intent.action === "save" ? 1 : -1));
      }
    }
  }

  if (intent.kind === "refund") {
    const item = await store.getItem(intent.itemId);
    // Solo i coupon hanno un rimborso: un callback vecchio su un concorso non
    // deve poter creare una riga che la schermata non sa mostrare.
    if (!item || item.kind !== "coupon") {
      intent = { kind: "home" };
    } else if (intent.action === "claim") {
      const amount = refundAmountFor(item);
      await store.claimRefund(chatId, item.id, amount.cents ?? 0, amount.cap, nowIso);
    } else if (intent.action === "receive") {
      await store.markRefundReceived(chatId, item.id, nowIso);
    } else if (intent.action === "undo") {
      await store.undoRefund(chatId, item.id);
    }
  }

  if (intent.kind === "refundAmount" && intent.cents !== null) {
    const item = await store.getItem(intent.itemId);
    if (item?.kind === "coupon") {
      await store.claimRefund(chatId, item.id, intent.cents, false, nowIso);
    }
  }

  let avviso: string | null = null;
  let toast: string | null = null;

  if (intent.kind === "play") {
    const item = await store.getItem(intent.itemId);
    if (item) {
      const giocato = await store.togglePlay(chatId, item.id, localDateString(now), nowIso);
      toast = giocato ? "✅ Giocato oggi" : "↩️ Tolto dai giocati di oggi";
    }
  }

  if (intent.kind === "receiptAdd") {
    // Lo scontrino va al concorso aperto: la scheda, oppure lo scontrino che si
    // sta guardando. Senza un concorso davanti non si indovina a quale vada.
    const daSezione = state.section.startsWith("scontrini:")
      ? Number.parseInt(state.section.slice("scontrini:".length), 10)
      : null;
    const itemId = state.openItemId ?? (daSezione !== null && Number.isFinite(daSezione) ? daSezione : null);
    const item = itemId !== null ? await store.getItem(itemId) : null;
    if (intent.media === null) {
      avviso = "🧾 Questo file non lo posso conservare come scontrino: mandami una foto o un PDF.";
    } else if (item === null) {
      avviso = "🧾 Per conservare uno scontrino apri prima il concorso (o il coupon), poi mandami la foto qui.";
    } else {
      await store.addReceipt({
        chatId,
        itemId: item.id,
        fileId: intent.media.fileId,
        fileUniqueId: intent.media.fileUniqueId,
        media: intent.media.type,
        addedAt: nowIso,
      });
      const quanti = (await store.listReceipts(chatId, item.id)).length;
      avviso = `✅ <b>Scontrino salvato</b> con questo concorso · ${quanti} in tutto`;
    }
  }

  if (intent.kind === "receiptDelete") {
    await store.deleteReceipt(chatId, intent.receiptId);
    // Tolto l'ultimo, la schermata dello scontrino non ha più niente da mostrare:
    // si torna alla scheda del concorso.
    if (state.section.startsWith("scontrini:")) {
      const itemId = Number.parseInt(state.section.slice("scontrini:".length), 10);
      if (Number.isFinite(itemId) && (await store.listReceipts(chatId, itemId)).length === 0) {
        intent = { kind: "back" };
        toast = "🗑 Scontrino eliminato";
      }
    }
  }

  if (intent.kind === "mutedBrand") {
    // Un id fuori registro non spegne niente: un bottone vecchio non deve poter
    // nascondere mezzo archivio con una marca che non esiste.
    if (isBrandId(intent.value)) {
      const eraSeguita = prefs.filters.favoriteBrands.includes(intent.value);
      prefs = {
        ...prefs,
        filters: withFilterChange(prefs.filters, {
          kind: intent.muted ? "muteBrand" : "unmuteBrand",
          value: intent.value,
        }),
      };
      await store.upsertPrefs(prefs);
      // Spegnere una marca che seguivi toglie anche il +10 dai suoi concorsi:
      // senza ricalcolo resterebbe scritto in archivio e ricomparirebbe al
      // momento di riaccenderla, senza che nessuno l'abbia più scelta.
      if (intent.muted && eraSeguita) await rescoreBrand(deps, intent.value, now);
    }
  }

  if (intent.kind === "config") {
    prefs = withConfig(prefs, intent.key, intent.value);
    await store.upsertPrefs(prefs);
    // Accendere o spegnere una marca cambia anche i punteggi già in archivio:
    // vedi rescoreBrand. Solo per le marche, che sono l'unico cambio di filtro
    // che tocca il punteggio di quello che c'è già.
    if (intent.key === "brand") await rescoreBrand(deps, intent.value, now);
  }

  // /start è anche l'iscrizione: chi lo scrive vuole le notifiche attive.
  if (message && (message.text ?? "").trim().toLowerCase().startsWith("/start") && !prefs.active) {
    prefs = { ...prefs, active: true };
    await store.upsertPrefs(prefs);
  }

  const applied = applyIntent(state, intent, now);
  // Il contatore delle novità riparte quando si ESCE da 🆕 Nuovi, non appena la
  // si apre: prima bastava aprirne uno e tornare indietro per trovare la sezione
  // vuota, e i "nuovi" restanti sparivano senza essere stati letti.
  const visto = state.section === "nuovi" && applied.section !== "nuovi";
  // Uscendo, la schermata si disegna già con l'ora nuova: il badge del menù
  // deve dire zero mentre lo si dipinge, non al tocco dopo. Entrando in 🆕
  // Nuovi, invece, resta quella vecchia — è lì che si contano i nuovi.
  const next = visto ? { ...applied, lastCheckAt: nowIso } : applied;
  // I dati si leggono con il lastCheckAt VECCHIO: è quello che rende possibile
  // mostrare i nuovi arrivati. Solo dopo averli mostrati il contatore riparte.
  const data = { ...(await loadScreenData(deps, chatId, next, prefs, now)), avviso };
  // La pagina salvata è quella davvero mostrata: così anche uno stato vecchio
  // (per esempio dopo una pulizia dell'archivio) resta coerente.
  const normalized = { ...next, page: data.page };
  // `fresh`: l'utente ha scritto, quindi la schermata va in un messaggio nuovo.
  // `stale`: ha toccato un bottone, ma è passato troppo tempo perché quel
  // messaggio sia ancora affidabile — vedi STALE_CHAT_MS.
  const painted = await paint(
    deps,
    chatId,
    normalized,
    renderScreen(normalized, data, now),
    fresh || isStaleChat(state.updatedAt, now),
  );
  // L'ora dell'interazione si riscrive a ogni giro: è quella che dice, al tocco
  // successivo, se il messaggio appena mandato è ancora quello in chat.
  await store.saveUiState({
    ...painted,
    updatedAt: nowIso,
    ...(visto ? { lastCheckAt: nowIso } : {}),
  });

  if (notificationId !== null) await tg.deleteMessage(chatId, notificationId);
  if (callback) await tg.answerCallbackQuery(callback.id, toast ?? toastFor(intent, prefs) ?? undefined);
  return { handled: true };
}
