import type { ChatFilters, ItemKind, ItemQuery, ItemRow, Prefs, SourceRow, UiState } from "../types.ts";
import { truncate } from "../lib/text.ts";
import {
  CATEGORY_ORDER,
  TAG_FILTERS,
  activeFilterCount,
  defaultFilters,
  filterChangeLabel,
  filterableSources,
  filtersFor,
  withFilterChange,
  type FilterChange,
} from "../filters.ts";
import { brandChoices, isBrandId } from "../config/brands.ts";
import { diagnosiFonti, riepilogoDiagnosi } from "../sources-health.ts";
import { rescoreRow } from "../enrich/score.ts";
import { mergedBrands, mergedWeights } from "../pipeline.ts";
import type { TelegramUpdate } from "./api.ts";
import type { NotifyDeps } from "./digest.ts";
import { regolamentoUrl } from "./digest.ts";
import { localDateString, sourceLabel } from "./format.ts";
import { leadHours, summarizeLead } from "../enrich/lead.ts";
import { BRANDS_PAGE_SIZE, PAGE_SIZE } from "./keyboard.ts";
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

export function defaultPrefs(chatId: number): Prefs {
  return {
    chatId,
    active: true,
    weights: {},
    minScoreInstant: 80,
    quietHours: "23-7",
    digestHours: [8, 19],
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
    case "/help":
    case "/aiuto":
      return { kind: "home" };
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
    case "/coupon":
    case "/rimborsi":
      return { kind: "section", section: "coupon" };
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
        : intent.action === "ign"
          ? "🚫 Ignorato: i filtri si adattano"
          : "🏆 Complimenti!";
    case "refresh":
      return "🔄 Aggiornato";
    case "config":
      if (intent.key === "score") return `🔔 Avvisi sopra ${prefs.minScoreInstant}/100`;
      if (intent.key === "quiet") {
        return prefs.quietHours ? `🌙 Silenzio ${prefs.quietHours.replace("-", "–")}` : "🌙 Silenzio disattivato";
      }
      if (intent.key === "digest") {
        return prefs.digestHours.length > 0 ? `📬 Digest alle ${prefs.digestHours.join(" e ")}` : "📬 Digest spenti";
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
  // 💶 Coupon: l'ordine è quello di arrivo (il default dello store), non il
  // punteggio: fra buoni sconto "quale vale la pena" non vuol dire niente, mentre
  // "quale è arrivato adesso" sì — un coupon vecchio è un coupon scaduto.
  //
  // La validità è un filtro, non una decorazione: passata la data dichiarata il
  // buono non si può più spendere, quindi esce dall'elenco (e dal numero sul
  // bottone, che conta la stessa query). Chi non dichiara una validità resta:
  // "non lo so" non è una prova, e la vita corta dei coupon la misura comunque
  // la pulizia periodica (COUPON_TTL_DAYS in src/enrich/freshness.ts).
  if (section === "coupon") {
    return { kinds: COUPON, statuses: ATTIVI, deadlineNotBefore: localDateString(now) };
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
  if (section === "oggi") {
    return {
      since: new Date(now.getTime() - 86_400_000).toISOString(),
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
  // La ricerca guarda tutto — anche gli articoli, marcati 📰 nell'elenco:
  // "cerca nutella" deve trovare sia il concorso sia il pezzo che ne parla.
  return { keyword: section.slice("cerca:".length), orderBy: "score", statuses: ATTIVI };
}

/**
 * Le sezioni che rispettano i filtri della chat. Sono quelle che *suggeriscono*
 * cosa guardare: è lì che un filtro serve, ed è lì che l'utente si aspetta che
 * valga. Restano fuori ⭐ Watchlist, 🗂 Storico e 🔍 Cerca, che sono scelte
 * esplicite: un concorso salvato non deve sparire perché hai spento la sua
 * fonte, e una ricerca è già una domanda precisa.
 */
const SEZIONI_FILTRATE = new Set([
  "nuovi", "oggi", "settimana", "scadenze", "news", "scaduti", "preferiti-lista", "coupon",
]);

function sectionQuery(section: string, now: Date, lastCheckAt: string | null, filters: ChatFilters): ItemQuery {
  const base = baseSectionQuery(section, now, lastCheckAt);
  // La sezione dei preferiti è filtrata sulle marche seguite per definizione,
  // acceso o no il filtro "solo le marche seguite": quella è la sua ragione
  // d'essere, non una preferenza da accendere ogni volta.
  if (section === "preferiti-lista" && filters.favoriteBrands.length > 0) {
    return filtersFor(filters, { ...base, brands: [...filters.favoriteBrands] });
  }
  return SEZIONI_FILTRATE.has(section) ? filtersFor(filters, base) : base;
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
    section === "coupon" ||
    section.startsWith("cerca:")
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
  // Gli elenchi dello storico si leggono solo quando servono: nel menù di tutti i
  // giorni sarebbero due query in più per niente.
  const storico = state.section === "storico" || SEZIONI_CONSEGNA.has(state.section);
  const vinti = storico ? await store.listDeliveredItems(chatId, "won", 200) : [];
  const ignorati = storico ? await store.listDeliveredItems(chatId, "ignored", 200) : [];

  // I conteggi sono query SQL di conteggio: non caricano righe, quindi il menù
  // resta leggero anche con un archivio grande.
  // I conteggi sono quelli che la chat VEDE (filtri compresi): un numero nel
  // menù che non corrisponde all'elenco è peggio di nessun numero. I totali
  // senza filtri si contano solo per poter dire "vedi 12 di 40".
  const [
    archiveTotal, contest, news, coupon, contestTotal, newsTotal, couponTotal,
    nuovi, oggi, settimana, scadenze, preferiti, quantiScaduti,
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
      // I concorsi delle marche seguite. Senza marche da seguire la sezione è
      // vuota per costruzione, e una query non filtrata conterebbe tutto
      // l'archivio: il numero sul bottone direbbe una cosa falsa.
      filters.favoriteBrands.length > 0
        ? store.countItems(sectionQuery("preferiti-lista", now, null, filters))
        : Promise.resolve(0),
      // Il conteggio dei chiusi serve solo allo storico: fuori da lì resta a zero.
      state.section === "storico" ? store.countItems(scaduti) : Promise.resolve(0),
    ]);
  const counts: ScreenCounts = {
    nuovi, oggi, settimana, scadenze, news, contest, coupon, contestTotal, newsTotal, couponTotal, preferiti,
    filtri: activeFilterCount(filters),
    salvati: salvati.length, vinti: vinti.length, ignorati: ignorati.length, scaduti: quantiScaduti,
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
    const daConsegne = SEZIONI_CONSEGNA.has(state.section)
      ? state.section === "salvati"
        ? salvati
        : state.section === "vinti"
          ? vinti
          : ignorati
      : null;
    const query = sectionQuery(state.section, now, state.lastCheckAt, filters);
    total = daConsegne ? daConsegne.length : await store.countItems(query);
    const pagine = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pagina = Math.min(Math.max(state.page, 0), pagine - 1);
    items = daConsegne
      ? daConsegne.slice(pagina * PAGE_SIZE, pagina * PAGE_SIZE + PAGE_SIZE)
      : await store.queryItems({ ...query, limit: PAGE_SIZE, offset: pagina * PAGE_SIZE });
  }

  const openItem = state.openItemId !== null ? await store.getItem(state.openItemId) : null;
  const decision = state.openItemId !== null ? await decisionFor(deps, chatId, state.openItemId) : null;
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
  // schermata (le marche stanno due per riga), e il conto deve usare lo stesso
  // passo della tastiera, altrimenti "Succ" salta mezzo schermo.
  const passo = state.section === "preferiti" ? BRANDS_PAGE_SIZE : PAGE_SIZE;
  const totalePagine =
    state.section === "filtri-fonti" ? tutteLeFonti.length : state.section === "preferiti" ? marche.length : total;
  const pagine = Math.max(1, Math.ceil(totalePagine / passo));
  const page = Math.min(Math.max(state.page, 0), pagine - 1);

  return {
    counts,
    page,
    items,
    total,
    openItem,
    decision,
    regolamentoUrl: openItem ? regolamentoUrl(openItem) : null,
    sources: fonti,
    runs: state.section === "fonti" ? await store.recentRuns(4) : [],
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
  };
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

  if (!(await store.claimUpdate(update.update_id, nowIso))) return { handled: false };

  const callback = update.callback_query;
  const message = update.message;
  const chatId = callback?.message?.chat.id ?? message?.chat.id;
  if (chatId === undefined) return { handled: false };
  if (!callback && message?.text === undefined) return { handled: false };

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
  } else {
    const text = (message?.text ?? "").trim();
    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = (rawCommand ?? "").toLowerCase().replace(/@[\w_]+$/, "");
    const fromCommand = command.startsWith("/") ? intentForCommand(command, rest.join(" ")) : null;
    if (fromCommand) intent = fromCommand;
    // Senza comando: se la chat è in modalità ricerca, il testo è la ricerca.
    else if (state.section === "cerca" && text.length > 0) intent = { kind: "section", section: `cerca:${truncate(text, 40)}` };
    else intent = { kind: "home" };
  }

  if (intent.kind === "decision") {
    const item = await store.getItem(intent.itemId);
    if (!item) {
      if (callback) await tg.answerCallbackQuery(callback.id, "Concorso non trovato");
      return { handled: true };
    }
    const kind = intent.action === "save" ? "saved" : intent.action === "ign" ? "ignored" : "won";
    const ripetuta = await store.isDelivered(chatId, intent.itemId, kind);
    await store.recordDelivery(chatId, intent.itemId, kind, nowIso);
    // Decidere due volte la stessa cosa (doppio tocco sullo stesso bottone, o
    // scheda e digest dello stesso concorso) non sposta i pesi due volte.
    if (intent.action !== "won" && !ripetuta) {
      await store.bumpWeights(chatId, weightsFor(item.tags, intent.action === "save" ? 1 : -1));
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

  const next = applyIntent(state, intent, now);
  // I dati si leggono con il lastCheckAt VECCHIO: è quello che rende possibile
  // mostrare i nuovi arrivati. Solo dopo averli mostrati il contatore riparte.
  const data = await loadScreenData(deps, chatId, next, prefs, now);
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
  const visto = normalized.section === "nuovi" && normalized.openItemId === null;
  // L'ora dell'interazione si riscrive a ogni giro: è quella che dice, al tocco
  // successivo, se il messaggio appena mandato è ancora quello in chat.
  await store.saveUiState({
    ...painted,
    updatedAt: nowIso,
    ...(visto ? { lastCheckAt: nowIso } : {}),
  });

  if (notificationId !== null) await tg.deleteMessage(chatId, notificationId);
  if (callback) await tg.answerCallbackQuery(callback.id, toastFor(intent, prefs) ?? undefined);
  return { handled: true };
}
