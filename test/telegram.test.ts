import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../src/db/memory.ts";
import type { FetchLike, ItemRow, NewItem, Prefs, RunRow, SourceRow } from "../src/types.ts";
import { TelegramClient, MAX_MESSAGE_CHARS, type InlineKeyboardMarkup, type TelegramUpdate } from "../src/telegram/api.ts";
import {
  daysLeft,
  escapeHtml,
  formatDate,
  formatDigest,
  formatItemCard,
  formatItemLine,
  localDateString,
  localHour,
  startOfLocalDay,
} from "../src/telegram/format.ts";
import {
  BRANDS_PAGE_SIZE,
  cardKeyboard,
  filtriFontiKeyboard,
  filtriKeyboard,
  itemButtonLabel,
  listKeyboard,
  menuKeyboard,
  settingsKeyboard,
  sourceToggleLabel,
} from "../src/telegram/keyboard.ts";
import { SCORE_WEIGHTS } from "../src/enrich/score.ts";
import { activeFilterCount, defaultFilters, filterableSources, parseFilters, withFilterChange } from "../src/filters.ts";
import { applyIntent, parseCallback } from "../src/telegram/screens.ts";
import { channelOf } from "../src/enrich/lead.ts";
import { STALE_CHAT_MS, handleUpdate, isStaleChat } from "../src/telegram/bot.ts";
import {
  isQuietHour,
  regolamentoUrl,
  reminderDaysFor,
  sendCollectionReminder,
  sendDigests,
  sendInstantAlerts,
  sendWatchlistReminders,
} from "../src/telegram/digest.ts";
import { COLLECTION_REMINDER_MARK, NOTIFY_CRON } from "../src/schedule.ts";

/**
 * Test dell'interfaccia: menù a pulsanti su UN solo messaggio.
 * Niente rete: il client Telegram è vero, con un finto fetch che registra le
 * chiamate, e il database è lo store in-memory (stessa semantica di D1).
 *
 * La verifica che conta: navigando, il bot deve *modificare* il messaggio che ha
 * già mandato, non accumularne di nuovi, e deve cancellare il comando scritto
 * dall'utente.
 */

/** 20/11/2026 11:00 a Roma. */
const NOW = new Date("2026-11-20T10:00:00.000Z");
const CHAT = 4242;

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/**
 * Finto Telegram: registra ogni chiamata e si comporta come l'API vera sul punto
 * che conta, cioè rifiuta una modifica che non cambia nulla ("message is not
 * modified"), che è quello che succede al doppio tocco sullo stesso bottone.
 */
function makeTg() {
  const calls: Call[] = [];
  const testi = new Map<number, string>();
  // Messaggi che Telegram accetta ancora di modificare ma che l'utente NON vede
  // più: è il caso della chat svuotata con "Elimina conversazione".
  const invisibili = new Set<number>();
  let nextMessageId = 100;

  const fetcher: FetchLike = async (input, init) => {
    const method = String(input).split("/").pop() ?? "";
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, payload });

    if (method === "sendMessage") {
      const id = nextMessageId++;
      testi.set(id, String(payload.text));
      return jsonResponse({ ok: true, result: { message_id: id } });
    }
    if (method === "editMessageText") {
      const id = Number(payload.message_id);
      // Come l'API vera: un messaggio che non esiste più non si può modificare.
      if (!testi.has(id)) return jsonResponse({ ok: false, description: "Bad Request: message to edit not found" }, 400);
      // Chat svuotata: la modifica riesce (e il contenuto cambia davvero lato
      // server) ma per l'utente resta invisibile.
      if (invisibili.has(id)) {
        testi.set(id, String(payload.text));
        return jsonResponse({ ok: true, result: { message_id: id } });
      }
      if (testi.get(id) === String(payload.text)) {
        return jsonResponse({ ok: false, description: "Bad Request: message is not modified" }, 400);
      }
      testi.set(id, String(payload.text));
      return jsonResponse({ ok: true, result: { message_id: id } });
    }
    return jsonResponse({ ok: true, result: true });
  };

  return { tg: new TelegramClient("test-token", fetcher), calls, invisibili };
}

function makeItem(partial: Partial<NewItem> = {}): NewItem {
  return {
    sourceId: "premieconcorsi",
    url: "https://esempio.it/concorso/1",
    urlKey: "key-1",
    simhash: "0123456789abcdef",
    title: "Concorso esempio con gift card",
    summary: "Vinci buoni spesa da 100 euro",
    publishedAt: null,
    firstSeenAt: "2026-11-20T08:00:00.000Z",
    lastSeenAt: "2026-11-20T08:00:00.000Z",
    deadline: "2026-11-30",
    prize: "Buoni spesa da 100 €",
    participation: "Senza obbligo di acquisto",
    prizeValue: 0.8,
    effort: 0.9,
    requiresPurchase: false,
    tags: ["giftcard"],
    score: 85,
    clusterId: null,
    status: "new",
    aiUsed: false,
    ...partial,
  };
}

let seedCounter = 0;

async function seed(store: MemoryStore, items: Partial<NewItem>[]): Promise<number[]> {
  const ids: number[] = [];
  for (const [index, partial] of items.entries()) {
    // Chiave sempre nuova: due chiamate a seed() non devono collidere su urlKey,
    // altrimenti il secondo item non verrebbe inserito.
    const unique = ++seedCounter;
    const inserted = await store.insertItem(
      makeItem({
        url: `https://esempio.it/concorso/${unique}`,
        urlKey: `key-${unique}`,
        title: `Concorso numero ${index + 1}`,
        ...partial,
      }),
    );
    ids.push(inserted.item.id);
  }
  return ids;
}

/** Riga completa (con id) per i test di formattazione e delle tastiere. */
function row(partial: Partial<ItemRow> = {}): ItemRow {
  return { ...makeItem(), id: 1, ...partial } as ItemRow;
}

function prefs(partial: Partial<Prefs> = {}): Prefs {
  return {
    chatId: CHAT,
    active: true,
    weights: {},
    minScoreInstant: 80,
    quietHours: "23-7",
    digestHours: [8, 19],
    filters: defaultFilters(),
    ...partial,
  };
}

function deps(store: MemoryStore, tg: TelegramClient, adminChatId = CHAT) {
  return { store, tg, now: NOW, adminChatId, allowedChatIds: [CHAT] };
}

function command(updateId: number, text: string): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId, chat: { id: CHAT }, text, from: { id: CHAT } } };
}

function tap(updateId: number, data: string, messageId: number): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: { id: `cb-${updateId}`, data, message: { message_id: messageId, chat: { id: CHAT } }, from: { id: CHAT } },
  };
}

const methods = (calls: Call[]): string[] => calls.map((call) => call.method);
const lastWith = (calls: Call[], method: string): Call | undefined =>
  [...calls].reverse().find((call) => call.method === method);

/** L'ultima tastiera disegnata: così i test toccano il bottone che l'utente vede. */
function lastKeyboard(calls: Call[]): InlineKeyboardMarkup | null {
  const call = lastWith(calls, "editMessageText") ?? lastWith(calls, "sendMessage");
  return (call?.payload.reply_markup as InlineKeyboardMarkup | undefined) ?? null;
}

/**
 * Le etichette dei bottoni dell'ultima schermata, unite: gli item di un elenco
 * stanno LÌ, non nel testo del messaggio (che porta testata e spiegazione).
 */
function etichette(calls: Call[]): string {
  return (lastKeyboard(calls)?.inline_keyboard.flat().map((voce) => voce.text ?? "") ?? []).join(" | ");
}

/**
 * Il callback_data del bottone con quell'etichetta, preso dalla tastiera viva.
 * `nth` serve dove l'etichetta si ripete: "➕ 1h" sta sia sul cursore dell'inizio
 * sia su quello della fine, ed è la riga (in alto ➖ 🌙 dalle, in basso alle) a
 * dire quale stai spostando.
 */
function buttonData(calls: Call[], label: string, nth = 0): string {
  const bottoni = lastKeyboard(calls)?.inline_keyboard.flat().filter((bottono) => bottono.text === label) ?? [];
  const trovato = bottoni[nth];
  if (!trovato?.callback_data) throw new Error(`bottone "${label}" non trovato (posizione ${nth + 1})`);
  return trovato.callback_data;
}

/** La riga che contiene un certo callback: le impostazioni crescono, gli indici no. */
function rigaCon(keyboard: InlineKeyboardMarkup, data: string) {
  return keyboard.inline_keyboard.find((riga) => riga.some((bottono) => bottono.callback_data === data));
}

describe("format", () => {
  it("esegue l'escape di &, < e >", () => {
    expect(escapeHtml('<b>&"</b>')).toBe("&lt;b&gt;&amp;&quot;&lt;/b&gt;");
  });

  it("non lascia passare HTML dai titoli delle fonti", () => {
    const card = formatItemCard(row({ title: 'Concorso <script>alert("x")</script> & premi' }), NOW);
    expect(card).toContain("&lt;script&gt;");
    expect(card).not.toContain("<script>");
    expect(card).toContain("&amp;");
  });

  it("mostra i giorni mancanti solo quando sono utili", () => {
    expect(formatItemLine(row({ deadline: "2026-11-24" }), NOW)).toContain("⏳4gg");
    expect(formatItemLine(row({ id: 2, deadline: "2027-05-01" }), NOW)).not.toContain("⏳");
  });

  it("calcola giorni e date locali italiane", () => {
    expect(daysLeft("2026-11-30", NOW)).toBe(10);
    expect(daysLeft("2026-11-19", NOW)).toBe(-1);
    expect(daysLeft(null, NOW)).toBeNull();
    expect(formatDate("2026-11-30")).toBe("30/11/2026");
    expect(formatDate(null)).toBe("—");
    expect(localDateString(new Date("2026-11-20T23:30:00Z"))).toBe("2026-11-21");
  });

  it("legge l'ora locale tenendo conto dell'ora legale", () => {
    expect(localHour(new Date("2026-07-01T10:00:00Z"))).toBe(12); // CEST
    expect(localHour(new Date("2026-01-15T10:00:00Z"))).toBe(11); // CET
  });

  it("spezza il digest restando sotto il limite Telegram", () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      row({
        id: index + 1,
        title: `Concorso molto lungo numero ${index + 1} con premio importante in gift card e buoni spesa`,
        summary: "x".repeat(120),
      }),
    );
    const messages = formatDigest([{ title: "📋 Altri", items }], NOW);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect((messages.join("\n").match(/<a href="https:\/\/esempio\.it/g) ?? []).length).toBe(60);
  });
});

describe("bottoni · costruzione delle tastiere", () => {
  it("il menù porta a tutte le sezioni, con i conteggi", () => {
    const keyboard = menuKeyboard({
      nuovi: 3, oggi: 12, settimana: 40, scadenze: 2, salvati: 1, news: 7, coupon: 5,
      seguite: 4, filtri: 0,
    });
    const bottoni = keyboard.inline_keyboard.flat();
    expect(bottoni.map((b) => b.callback_data)).toEqual([
      "s:nuovi", "s:oggi", "s:settimana", "s:scadenze", "s:premi", "s:salvati", "s:news",
      "s:cerca", "s:storico", "s:coupon", "s:preferiti", "s:filtri", "s:fonti", "s:impostazioni",
      "refresh", "s:aiuto",
    ]);
    expect(bottoni[0]?.text).toBe("🆕 Nuovi (3)");
    // La porta ai tipi di premio non porta un numero: i conteggi sono dentro, e
    // 🆓 Gratis vive lì — nel menù sarebbe la stessa cosa da due posti.
    expect(bottoni[4]?.text).toBe("🎁 Tipi di premio");
    expect(bottoni.some((b) => (b.text ?? "").includes("🆓"))).toBe(false);
    expect(bottoni[5]?.text).toBe("⭐ Watchlist (1)");
    expect(bottoni[6]?.text).toBe("📰 News (7)");
    expect(bottoni[9]?.text).toBe("💶 Coupon e rimborsi (5)");
    // Il numero qui sono le MARCHE seguite, non i loro concorsi: è quello che il
    // nome della voce promette.
    expect(bottoni[10]?.text).toBe("🏷 Marche seguite (4)");
    expect(bottoni[15]?.text).toBe("❓ Aiuto");
  });

  it("un coupon si riconosce dal bottone: 💶 e senza punteggio", () => {
    // Il punteggio risponde a "quanto vale la pena guardare questo concorso", e
    // su un buono sconto non vuol dire niente: mostrarlo sarebbe un numero
    // inventato.
    const label = itemButtonLabel(row({ kind: "coupon", score: 31, title: "Buono sconto Aia Spinacine" }), NOW);
    expect(label).toContain("💶");
    expect(label).not.toContain("31");
    expect(label).toContain("Buono sconto Aia Spinacine");
  });

  it("un articolo si riconosce dal bottone: 📰 invece di ⭐", () => {
    expect(itemButtonLabel(row({ kind: "news", title: "Tutti i concorsi del mese" }), NOW)).toContain("📰");
    expect(itemButtonLabel(row({ kind: "contest", title: "Concorso Barilla" }), NOW)).toContain("⭐");
  });

  it("l'elenco ha un bottone per concorso e i numeri di pagina solo se servono", () => {
    const items = Array.from({ length: 3 }, (_, index) => row({ id: index + 1 }));
    const unaPagina = listKeyboard(items, NOW, { index: 0, total: 1 });
    expect(unaPagina.inline_keyboard).toHaveLength(4); // 3 item + riga di navigazione
    expect(unaPagina.inline_keyboard[0]?.[0]?.callback_data).toBe("open:1");

    const due = listKeyboard(items, NOW, { index: 0, total: 2 });
    expect(due.inline_keyboard[3]?.map((b) => b.callback_data)).toEqual(["noop", "noop", "page:1"]);
    const seconda = listKeyboard(items, NOW, { index: 1, total: 2 });
    expect(seconda.inline_keyboard[3]?.map((b) => b.callback_data)).toEqual(["page:0", "noop", "noop"]);
  });

  it("la scheda di un articolo avverte che il link non è la pagina del concorso", () => {
    const card = formatItemCard(row({ kind: "news", sourceId: "news-brand" }), NOW);
    expect(card).toContain("📰");
    expect(card).toContain("il link non è la pagina ufficiale");
    expect(formatItemCard(row({ kind: "contest" }), NOW)).not.toContain("pagina ufficiale");
  });

  it("la scheda mostra il Regolamento trovato sulla pagina del concorso", () => {
    const item = row({ id: 7, url: "https://esempio.it/concorso", summary: "", rulesUrl: "https://esempio.it/bando.pdf" });
    const keyboard = cardKeyboard(item, null, regolamentoUrl(item));
    expect(keyboard.inline_keyboard[1]?.map((b) => [b.text, b.url])).toEqual([
      ["🔗 Apri", "https://esempio.it/concorso"],
      ["📄 Regolamento", "https://esempio.it/bando.pdf"],
    ]);
  });

  it("nella scheda il bottone della decisione già presa è inerte", () => {
    const item = row({ id: 7 });
    const keyboard = cardKeyboard(item, "saved", "https://esempio.it/regolamento");
    const prima = keyboard.inline_keyboard[0] ?? [];
    expect(prima[0]).toEqual({ text: "⭐ In watchlist", callback_data: "noop" });
    expect(prima[1]?.callback_data).toBe("ign:7");
    expect(keyboard.inline_keyboard[1]?.map((b) => b.text)).toEqual(["🔗 Apri", "📄 Regolamento"]);
    expect(keyboard.inline_keyboard[2]?.map((b) => b.callback_data)).toEqual(["back", "refresh", "home"]);
  });

  it("le impostazioni marcano i valori attivi", () => {
    const keyboard = settingsKeyboard(prefs({ minScoreInstant: 90, quietHours: "22-8", digestHours: [] }));
    expect(rigaCon(keyboard, "cfg:score:90")?.find((b) => b.text.startsWith("•"))?.text).toBe("• 90");
    expect(rigaCon(keyboard, "cfg:quiet:22-8")?.find((b) => b.text.startsWith("•"))?.text).toBe("• 22–8");
    expect(rigaCon(keyboard, "cfg:digest:off")?.find((b) => b.text.startsWith("•"))?.text).toBe("• Off");
    expect(keyboard.inline_keyboard.some((riga) => riga[0]?.callback_data === "cfg:notify:off")).toBe(true);
  });

  it("i ➖ ➕ spostano la soglia di cinque punti, e ai bordi diventano inerti", () => {
    const centro = settingsKeyboard(prefs({ minScoreInstant: 80 }));
    expect(centro.inline_keyboard[0]?.map((b) => b.callback_data)).toEqual(["cfg:score:75", "noop", "cfg:score:85"]);
    expect(centro.inline_keyboard[0]?.[1]?.text).toBe("🔔 80/100");

    // Al minimo il ➖ resta al suo posto ma non fa niente: la riga non si sposta
    // sotto il dito, che è il modo in cui si fanno i tocchi sbagliati.
    const basso = settingsKeyboard(prefs({ minScoreInstant: 0 }));
    expect(basso.inline_keyboard[0]?.[0]).toEqual({ text: "➖", callback_data: "noop" });
    expect(basso.inline_keyboard[0]?.[2]?.callback_data).toBe("cfg:score:5");

    const alto = settingsKeyboard(prefs({ minScoreInstant: 100 }));
    expect(alto.inline_keyboard[0]?.[2]).toEqual({ text: "➕", callback_data: "noop" });
    expect(alto.inline_keyboard[0]?.[0]?.callback_data).toBe("cfg:score:95");
  });

  it("il silenzio ha due cursori, e ognuno sposta il suo estremo", () => {
    const keyboard = settingsKeyboard(prefs({ quietHours: "23-7" }));
    expect(rigaCon(keyboard, "cfg:quiet:22-7")?.map((b) => b.callback_data)).toEqual([
      "cfg:quiet:22-7", "noop", "cfg:quiet:0-7",
    ]);
    expect(rigaCon(keyboard, "cfg:quiet:23-6")?.map((b) => b.callback_data)).toEqual([
      "cfg:quiet:23-6", "noop", "cfg:quiet:23-8",
    ]);
    expect(rigaCon(keyboard, "cfg:quiet:22-7")?.[1]?.text).toBe("🌙 dalle 23:00");
    expect(rigaCon(keyboard, "cfg:quiet:23-6")?.[1]?.text).toBe("🌙 alle 07:00");
  });

  it("con il silenzio spento i cursori partono dalla fascia solita", () => {
    const keyboard = settingsKeyboard(prefs({ quietHours: "" }));
    expect(rigaCon(keyboard, "cfg:quiet:22-7")?.[2]?.callback_data).toBe("cfg:quiet:0-7");
    expect(rigaCon(keyboard, "cfg:quiet:23-6")?.[2]?.callback_data).toBe("cfg:quiet:23-8");
    // E "Off" resta a un tocco di distanza — marcato, perché il silenzio è spento.
    expect(rigaCon(keyboard, "cfg:quiet:off")?.find((b) => b.text.startsWith("•"))?.text).toBe("• Off");
  });

  it("la griglia del digest offre le ventiquattr'ore, con il pallino su quelle accese", () => {
    const keyboard = settingsKeyboard(prefs({ digestHours: [8, 19] }));
    const griglia = keyboard.inline_keyboard.filter((riga) =>
      riga.some((b) => b.callback_data?.startsWith("cfg:hour:")),
    );
    expect(griglia).toHaveLength(4); // ventiquattro ore, sei per riga
    expect(griglia.flat().map((b) => b.callback_data)).toEqual(
      Array.from({ length: 24 }, (_, hour) => `cfg:hour:${hour}`),
    );
    expect(griglia.flat().map((b) => b.text)).toEqual(
      Array.from({ length: 24 }, (_, hour) => {
        const due = String(hour).padStart(2, "0");
        return hour === 8 || hour === 19 ? `• ${due}` : due;
      }),
    );
  });
});

describe("intenti", () => {
  it("traduce i callback_data dei bottoni", () => {
    expect(parseCallback("s:oggi")).toEqual({ kind: "section", section: "oggi" });
    expect(parseCallback("open:17")).toEqual({ kind: "open", itemId: 17 });
    expect(parseCallback("save:5")).toEqual({ kind: "decision", action: "save", itemId: 5 });
    expect(parseCallback("won:5")).toEqual({ kind: "decision", action: "won", itemId: 5 });
    expect(parseCallback("cfg:digest:7,13,20")).toEqual({ kind: "config", key: "digest", value: "7,13,20" });
    expect(parseCallback("home")).toEqual({ kind: "home" });
    expect(parseCallback("back")).toEqual({ kind: "back" });
  });

  it("ignora quello che non conosce", () => {
    expect(parseCallback("noop")).toEqual({ kind: "none" });
    expect(parseCallback("s:inesistente")).toEqual({ kind: "none" });
    expect(parseCallback("cfg:boh:1")).toEqual({ kind: "none" });
    expect(parseCallback(undefined)).toEqual({ kind: "none" });
  });

  it("aprire una sezione azzera pagina e scheda, indietro chiude solo la scheda", () => {
    const stato = {
      chatId: 1, messageId: 10, section: "oggi", page: 3, openItemId: 9, lastCheckAt: null, updatedAt: null,
    };
    const sezione = applyIntent(stato, { kind: "section", section: "scadenze" }, NOW);
    expect(sezione).toMatchObject({ section: "scadenze", page: 0, openItemId: null });
    const scheda = applyIntent(sezione, { kind: "open", itemId: 4 }, NOW);
    expect(scheda).toMatchObject({ section: "scadenze", openItemId: 4 });
    const indietro = applyIntent(scheda, { kind: "back" }, NOW);
    expect(indietro).toMatchObject({ section: "scadenze", openItemId: null });
    // Il "controllo" non si sposta qui: lo fa bot.ts solo quando i nuovi si vedono.
    expect(indietro.lastCheckAt).toBeNull();
  });
});

describe("interfaccia · un solo messaggio per chat", () => {
  let store: MemoryStore;
  let ids: number[];

  beforeEach(async () => {
    store = createMemoryStore();
    await store.upsertPrefs(prefs());
    ids = await seed(store, [
      { title: "Barilla vinci una Fiat Panda" },
      { title: "Findus buoni spesa" },
      { title: "Nutella vinci un viaggio", firstSeenAt: "2026-11-15T08:00:00.000Z" },
      { title: "Sammontana gusta e vinci", firstSeenAt: "2026-11-10T08:00:00.000Z" },
    ]);
  });

  it("/start cancella il comando e manda il menù, salvando l'id del messaggio", async () => {
    const { tg, calls } = makeTg();
    const result = await handleUpdate(command(1, "/start"), deps(store, tg));

    expect(result.handled).toBe(true);
    expect(methods(calls)).toContain("deleteMessage");
    expect(lastWith(calls, "deleteMessage")?.payload.message_id).toBe(1);

    const inviato = lastWith(calls, "sendMessage");
    expect(inviato?.payload.text).toContain("Concorsi Radar");
    const keyboard = inviato?.payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] };
    expect(keyboard.inline_keyboard.flat().map((b) => b.callback_data)).toContain("s:oggi");

    const stato = await store.getUiState(CHAT);
    expect(stato?.messageId).toBe(100);
    expect(stato?.section).toBe("menu");
  });

  it("toccare una sezione modifica il messaggio esistente invece di mandarne uno nuovo", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;

    await handleUpdate(tap(2, "s:oggi", 100), deps(store, tg));

    expect(methods(calls)).not.toContain("sendMessage");
    const modifica = lastWith(calls, "editMessageText");
    expect(modifica?.payload.message_id).toBe(100);
    expect(modifica?.payload.text).toContain("Oggi (dalle 00:00)");
    expect(methods(calls)).toContain("answerCallbackQuery");
  });

  it("aprire un concorso mostra la scheda e \"torna\" riporta all'elenco", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "open:1", 100), deps(store, tg));

    let stato = await store.getUiState(CHAT);
    expect(stato?.openItemId).toBe(1);
    const scheda = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(scheda).toContain("Barilla vinci una Fiat Panda");
    expect(scheda).toContain("🆔 <code>1</code>");

    await handleUpdate(tap(3, "back", 100), deps(store, tg));
    stato = await store.getUiState(CHAT);
    expect(stato?.openItemId).toBeNull();
  });

  it("la decisione nella scheda resta visibile e addestra i pesi di quella chat", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "open:1", 100), deps(store, tg));
    await handleUpdate(tap(3, "save:1", 100), deps(store, tg));

    expect(await store.isDelivered(CHAT, 1, "saved")).toBe(true);
    expect((await store.getPrefs(CHAT))?.weights.giftcard).toBe(1);

    const toast = lastWith(calls, "answerCallbackQuery")?.payload.text;
    expect(toast).toBe("⭐ In watchlist");
    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("⭐ <b>Nella tua watchlist</b>");
  });

  it("una decisione presa dall'avviso toglie l'avviso e aggiorna la schermata", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;

    // Notifica (messaggio 777) diversa dalla schermata viva (100): si usa e si toglie.
    const notifica: TelegramUpdate = {
      update_id: 2,
      callback_query: { id: "cb-2", data: "save:2", message: { message_id: 777, chat: { id: CHAT } }, from: { id: CHAT } },
    };
    await handleUpdate(notifica, deps(store, tg));

    expect(await store.isDelivered(CHAT, 2, "saved")).toBe(true);
    const cancellati = calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload.message_id);
    expect(cancellati).toContain(777);
    expect(lastWith(calls, "editMessageText")?.payload.message_id).toBe(100);
    expect(methods(calls)).not.toContain("sendMessage");
  });

  it("il doppio tocco sullo stesso bottone non duplica il messaggio", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:settimana", 100), deps(store, tg));
    calls.length = 0;

    // Secondo tocco identico: l'API risponde "message is not modified".
    await handleUpdate(tap(3, "s:settimana", 100), deps(store, tg));
    expect(methods(calls)).not.toContain("sendMessage");
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1);
  });

  it("se il messaggio è stato cancellato a mano, ne parte uno nuovo", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await store.saveUiState({ ...(await store.getUiState(CHAT))!, messageId: 99999 });
    calls.length = 0;

    await handleUpdate(tap(2, "s:oggi", 99999), deps(store, tg));
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("Oggi (dalle 00:00)");
    expect((await store.getUiState(CHAT))?.messageId).not.toBe(99999);
  });

  it("dallo stato senza messaggio il menù viene inviato una volta sola", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    calls.length = 0;
    await handleUpdate(tap(2, "refresh", 100), deps(store, tg));
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
  });

  it("impagina gli elenchi lunghi", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(
      store2,
      Array.from({ length: 8 }, (_, index) => ({ title: `Concorso lungo numero ${index + 1}` })),
    );
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    await handleUpdate(tap(2, "s:oggi", 100), deps(store2, tg));

    const prima = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(prima).toContain("8 concorsi");
    expect(prima).toContain("pagina 1/2");

    const titoli = (call: Call | undefined): string[] =>
      ((call?.payload.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined)
        ?.inline_keyboard.flat() ?? [])
        .filter((bottone) => bottone.callback_data?.startsWith("open:"))
        .map((bottone) => bottone.text);
    const primaPagina = titoli(lastWith(calls, "editMessageText"));
    expect(primaPagina).toHaveLength(6);

    await handleUpdate(tap(3, "page:1", 100), deps(store2, tg));
    const seconda = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(seconda).toContain("pagina 2/2");
    const secondaPagina = titoli(lastWith(calls, "editMessageText"));
    expect(secondaPagina).toHaveLength(2);
    // Le due pagine non si sovrappongono: è la prova che la pagina si legge dal
    // database con OFFSET, non ritagliando le prime righe caricate.
    for (const titolo of secondaPagina) expect(primaPagina).not.toContain(titolo);
  });

  it("sfoglia anche oltre le prime righe caricate in memoria", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(
      store2,
      Array.from({ length: 70 }, (_, index) => ({ title: `Concorso numero ${index + 1}` })),
    );
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    await handleUpdate(tap(2, "s:oggi", 100), deps(store2, tg));
    await handleUpdate(tap(3, "page:11", 100), deps(store2, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("70 concorsi");
    expect(testo).toContain("pagina 12/12");
    const righe = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][]
    }).inline_keyboard.filter((riga) => riga[0]?.callback_data?.startsWith("open:"));
    expect(righe).toHaveLength(4);
  });

  it("una pagina fuori intervallo torna dentro e mostra contenuto", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:oggi", 100), deps(store, tg));
    await handleUpdate(tap(3, "page:9", 100), deps(store, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("concorsi");
    expect(testo).not.toContain("Nessun concorso");
    expect((await store.getUiState(CHAT))?.page).toBe(0);
  });

  it("le impostazioni cambiano preferenze reali e si rileggono subito", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:impostazioni", 100), deps(store, tg));
    await handleUpdate(tap(3, "cfg:score:90", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.minScoreInstant).toBe(90);
    expect(lastWith(calls, "answerCallbackQuery")?.payload.text).toBe("🔔 Avvisi sopra 90/100");

    await handleUpdate(tap(4, "cfg:quiet:off", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.quietHours).toBe("");

    await handleUpdate(tap(5, "cfg:digest:7,13,20", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.digestHours).toEqual([7, 13, 20]);

    await handleUpdate(tap(6, "cfg:digest:off", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.digestHours).toEqual([]);

    await handleUpdate(tap(7, "cfg:notify:off", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.active).toBe(false);
    expect(lastWith(calls, "answerCallbackQuery")?.payload.text).toBe("⏸ Notifiche sospese");

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("📣 Notifiche: <b>sospese</b>");
  });

  it("valori inventati dalle impostazioni non cambiano nulla", async () => {
    const { tg } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "cfg:score:999", 100), deps(store, tg));
    await handleUpdate(tap(3, "cfg:quiet:99-99", 100), deps(store, tg));
    await handleUpdate(tap(4, "cfg:quiet:7-33", 100), deps(store, tg));
    await handleUpdate(tap(5, "cfg:digest:99", 100), deps(store, tg));
    // La griglia delle ore è nuova, e il valore che arriva è solo un numero:
    // "99" non è un'ora, e "9x" nemmeno (parseInt ne farebbe 9).
    await handleUpdate(tap(6, "cfg:hour:99", 100), deps(store, tg));
    await handleUpdate(tap(7, "cfg:hour:9x", 100), deps(store, tg));
    await handleUpdate(tap(8, "cfg:hour:", 100), deps(store, tg));
    const salvate = await store.getPrefs(CHAT);
    expect(salvate?.minScoreInstant).toBe(80);
    expect(salvate?.quietHours).toBe("23-7");
    expect(salvate?.digestHours).toEqual([8, 19]);
  });

  /**
   * Il giro completo delle impostazioni fini, fatto dai bottoni VERI: il tocco
   * si prende dalla tastiera che il bot ha appena disegnato, quindi se un bottone
   * portasse un valore che il router rifiuta (o un altro valore), questo test lo
   * vedrebbe. La preferenza in D1 è la prova finale, non il testo del messaggio.
   */
  it("i cursori e la griglia cambiano preferenze reali, lette dai bottoni disegnati", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:impostazioni", 100), deps(store, tg));

    await handleUpdate(tap(3, buttonData(calls, "➕ 5"), 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.minScoreInstant).toBe(85);
    expect(lastWith(calls, "answerCallbackQuery")?.payload.text).toBe("🔔 Avvisi sopra 85/100");

    // Il primo "➖ 1h" è il cursore dell'inizio: il silenzio comincia prima.
    await handleUpdate(tap(4, buttonData(calls, "➖ 1h"), 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.quietHours).toBe("22-7");
    expect(lastWith(calls, "answerCallbackQuery")?.payload.text).toBe("🌙 Silenzio 22–7");

    // Il secondo "➕ 1h" è il cursore della fine: la fascia si allunga dall'altra
    // parte, e resta 22-8 (non 23-8, che sarebbe uno spostamento, non un allungo).
    await handleUpdate(tap(5, buttonData(calls, "➕ 1h", 1), 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.quietHours).toBe("22-8");

    // Un'ora del digest si accende e si spegne dallo stesso bottone.
    await handleUpdate(tap(6, buttonData(calls, "09"), 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.digestHours).toEqual([8, 9, 19]);
    expect(lastWith(calls, "answerCallbackQuery")?.payload.text).toBe("📬 Accesa 09:00");

    await handleUpdate(tap(7, buttonData(calls, "• 09"), 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.digestHours).toEqual([8, 19]);
    expect(lastWith(calls, "answerCallbackQuery")?.payload.text).toBe("📬 Spenta 09:00");

    // La schermata dice i valori nuovi — compreso il silenzio allungato a 22–8.
    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("solo sopra <b>85</b>/100");
    expect(testo).toContain("🌙 Silenzio: <b>22:00–08:00</b>");
    expect(testo).toContain("📬 Digest: <b>08:00, 19:00</b>");
  });

  it("la ricerca parte dal pulsante e usa il messaggio successivo come parola", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:cerca", 100), deps(store, tg));
    expect(lastWith(calls, "editMessageText")?.payload.text).toContain("Scrivi la parola da cercare");
    expect((await store.getUiState(CHAT))?.section).toBe("cerca");

    await handleUpdate(command(3, "viaggio"), deps(store, tg));
    expect((await store.getUiState(CHAT))?.section).toBe("cerca:viaggio");
    const testo = lastWith(calls, "sendMessage")?.payload.text ?? "";
    expect(testo).toContain("Ricerca: viaggio");
    expect(methods(calls)).toContain("deleteMessage");
  });

  it("fuori dalla ricerca un testo libero riapre il menù in un messaggio nuovo", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;
    await handleUpdate(command(2, "ciao"), deps(store, tg));
    // Prima sparisce il testo scritto, poi la vecchia schermata, poi arriva il menù:
    // in chat resta un messaggio solo.
    expect(methods(calls)).toEqual(["deleteMessage", "deleteMessage", "sendMessage"]);
    expect(calls[0]?.payload.message_id).toBe(2);
    expect(calls[1]?.payload.message_id).toBe(100);
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("Concorsi Radar");
  });

  it("due /start di fila lasciano un solo menù in chat", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;
    await handleUpdate(command(2, "/start"), deps(store, tg));

    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload.message_id)).toEqual([
      2, 100,
    ]);
    expect((await store.getUiState(CHAT))?.messageId).toBe(101);
  });

  it("/start riapre il menù anche se la chat è stata svuotata", async () => {
    const { tg, calls, invisibili } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    expect((await store.getUiState(CHAT))?.messageId).toBe(100);

    // L'utente ha eliminato la conversazione: Telegram accetta ancora la modifica
    // di quel messaggio (risponde ok) ma non lo mostra più. Se il bot si fidasse di
    // quell'ok, il comando sparirebbe e il menù non arriverebbe mai.
    invisibili.add(100);
    calls.length = 0;
    await handleUpdate(command(2, "/start"), deps(store, tg));

    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(0);
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("Concorsi Radar");
    expect((await store.getUiState(CHAT))?.messageId).toBe(101);
  });

  it("dopo ore di silenzio anche un tocco apre un messaggio nuovo, non uno invisibile", async () => {
    // Il caso che rendeva il bot muto: un tocco su un avviso della sera prima,
    // con la conversazione svuotata nel frattempo. Telegram accetta la modifica
    // del messaggio che non c'è più (risponde ok) e l'utente non vede niente —
    // l'unica difesa è non modificare un messaggio vecchio (vedi STALE_CHAT_MS).
    const { tg, calls, invisibili } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    const stato = (await store.getUiState(CHAT))!;
    expect(stato.messageId).toBe(100);
    invisibili.add(100);
    const ottoOre = new Date(NOW.getTime() - 8 * 3_600_000).toISOString();
    await store.saveUiState({ ...stato, updatedAt: ottoOre });
    calls.length = 0;

    await handleUpdate(tap(2, "s:oggi", 100), deps(store, tg));

    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(0);
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("Oggi (dalle 00:00)");
    const dopo = await store.getUiState(CHAT);
    expect(dopo?.messageId).toBe(101);
    // E l'ora si riaggiorna: dal tocco successivo si torna a un solo messaggio.
    expect(dopo?.updatedAt).toBe(NOW.toISOString());
  });

  it("dentro la stessa conversazione il tocco continua a modificare l'unico messaggio", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    const cinqueOre = new Date(NOW.getTime() - 5 * 3_600_000).toISOString();
    await store.saveUiState({ ...(await store.getUiState(CHAT))!, updatedAt: cinqueOre });
    calls.length = 0;

    await handleUpdate(tap(2, "s:oggi", 100), deps(store, tg));

    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
    expect(lastWith(calls, "editMessageText")?.payload.message_id).toBe(100);
  });

  it("la soglia è di sei ore, e senza data si apre un messaggio nuovo", () => {
    const iso = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
    // Sulla soglia esatta si modifica ancora: la chat è "vecchia" solo oltre.
    expect(isStaleChat(iso(-STALE_CHAT_MS), NOW)).toBe(false);
    expect(isStaleChat(iso(-STALE_CHAT_MS + 60_000), NOW)).toBe(false);
    expect(isStaleChat(iso(-STALE_CHAT_MS - 60_000), NOW)).toBe(true);
    // "Non lo so" non è una prova che il messaggio esista: si apre uno nuovo.
    expect(isStaleChat(null, NOW)).toBe(true);
    expect(isStaleChat("non una data", NOW)).toBe(true);
    // Un orologio avanti (Worker e richiesta non sono la stessa macchina) non
    // deve rendere la chat fresca per sempre.
    expect(isStaleChat(iso(60_000), NOW)).toBe(false);
  });

  it("il contatore dei nuovi riparte dopo aver visto la sezione", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(store2, [{ title: "Concorso vecchio", firstSeenAt: "2026-11-10T08:00:00.000Z" }]);
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));

    // Arriva un concorso nuovo mentre l'utente non guarda.
    await seed(store2, [{ title: "Concorso appena arrivato", firstSeenAt: "2026-11-20T09:30:00.000Z" }]);
    await handleUpdate(tap(2, "refresh", 100), deps(store2, tg));
    const menu = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    expect(menu.inline_keyboard.flat().find((b) => b.callback_data === "s:nuovi")?.text).toBe("🆕 Nuovi (1)");

    await handleUpdate(tap(3, "s:nuovi", 100), deps(store2, tg));
    const elenco = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(elenco).toContain("Nuovi dall'ultimo controllo");
    expect(elenco).toContain("1 concorso");
    const righeElenco = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][];
    }).inline_keyboard;
    expect(righeElenco[0]?.[0]?.text).toContain("Concorso appena arrivato");
    expect((await store2.getUiState(CHAT))?.lastCheckAt).toBe(NOW.toISOString());

    await handleUpdate(tap(4, "home", 100), deps(store2, tg));
    const menuDopo = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    expect(menuDopo.inline_keyboard.flat().find((b) => b.callback_data === "s:nuovi")?.text).toBe("🆕 Nuovi (0)");
  });

  it("la sezione scadenze mostra solo chi deve ancora chiudere", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(store2, [
      { title: "Scade domani", deadline: "2026-11-21" },
      { title: "Già chiuso", deadline: "2026-11-01" },
      { title: "Scade tra un mese", deadline: "2026-12-20" },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    await handleUpdate(tap(2, "s:scadenze", 100), deps(store2, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("1 concorso");
    const keyboard = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][];
    };
    expect(keyboard.inline_keyboard[0]?.[0]?.text).toContain("Scade domani");
  });

  it("un tocco dal digest apre la scheda senza cancellare il digest", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;

    // Il digest è un altro messaggio (500): il prefisso d: dice di conservarlo.
    await handleUpdate(
      { update_id: 2, callback_query: { id: "cb-2", data: "d:open:3", message: { message_id: 500, chat: { id: CHAT } }, from: { id: CHAT } } },
      deps(store, tg),
    );

    expect((await store.getUiState(CHAT))?.openItemId).toBe(3);
    expect(lastWith(calls, "editMessageText")?.payload.message_id).toBe(100);
    expect(calls.filter((call) => call.method === "deleteMessage")).toHaveLength(0);
  });

  it("ripetere la stessa decisione non sposta i pesi due volte", async () => {
    const { tg } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "save:1", 100), deps(store, tg));
    await handleUpdate(tap(3, "save:1", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.weights.giftcard).toBe(1);
  });

  it("i salvati sono per chat e mostrano il punteggio", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "save:1", 100), deps(store, tg));
    await handleUpdate(tap(3, "save:2", 100), deps(store, tg));
    await handleUpdate(tap(4, "s:salvati", 100), deps(store, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("Watchlist</b> · 2 concorsi in watchlist");
    const keyboard = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const apribili = keyboard.inline_keyboard.map((riga) => riga[0]?.callback_data).filter((data) => data?.startsWith("open:"));
    expect(apribili.sort()).toEqual(["open:1", "open:2"]);
  });

  it("la watchlist è ordinata per scadenza, non per quando l'hai salvata", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(store2, [
      { title: "Chiude a dicembre", deadline: "2026-12-20", score: 99 },
      { title: "Chiude dopodomani", deadline: "2026-11-22", score: 30 },
      { title: "Chiude tra un mese", deadline: "2027-01-10", score: 80 },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    // Salvati nell'ordine peggiore possibile: il primo è quello che chiude più tardi.
    for (const id of [1, 2, 3]) await handleUpdate(tap(10 + id, `save:${id}`, 100), deps(store2, tg));
    await handleUpdate(tap(20, "s:salvati", 100), deps(store2, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("3 concorsi in watchlist");
    expect(testo).toContain("chiude prima sta in cima");
    const titoli = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][]
    }).inline_keyboard.map((riga) => riga[0]?.text ?? "");
    expect(titoli[0]).toContain("Chiude dopodomani");
    expect(titoli[1]).toContain("Chiude a dicembre");
    expect(titoli[2]).toContain("Chiude tra un mese");
  });

  it("lo storico riunisce vinti, chiusi e scartati", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(store2, [
      { title: "Concorso ancora aperto", deadline: "2026-12-20" },
      { title: "Concorso chiuso ieri", deadline: "2026-11-19" },
      { title: "Concorso chiuso a settembre", deadline: "2026-09-01" },
      { title: "Concorso da vincere", deadline: "2026-11-25" },
      { title: "Concorso scartato", deadline: "2026-11-26" },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    await handleUpdate(tap(2, "won:4", 100), deps(store2, tg));
    await handleUpdate(tap(3, "ign:5", 100), deps(store2, tg));

    await handleUpdate(tap(4, "s:storico", 100), deps(store2, tg));
    const menu = lastWith(calls, "editMessageText");
    expect(menu?.payload.text).toContain("<b>1</b> vinti");
    expect(menu?.payload.text).toContain("<b>2</b> chiusi");
    expect(menu?.payload.text).toContain("<b>1</b> scartati");
    expect((menu?.payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard
      .flat().map((b) => b.callback_data)).toContain("s:scaduti");

    await handleUpdate(tap(5, "s:scaduti", 100), deps(store2, tg));
    const chiusi = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(chiusi).toContain("Concorsi chiusi");
    expect(chiusi).toContain("2 concorsi chiusi");
    const titoliChiusi = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][]
    }).inline_keyboard.map((riga) => riga[0]?.text ?? "");
    // Chi ha chiuso per ultimo in cima, e il concorso ancora aperto non c'è.
    expect(titoliChiusi[0]).toContain("Concorso chiuso ieri");
    expect(titoliChiusi.join(" ")).not.toContain("ancora aperto");

    await handleUpdate(tap(6, "s:vinti", 100), deps(store2, tg));
    expect(lastWith(calls, "editMessageText")?.payload.text).toContain("1 concorso vinto");
  });

  it("la sezione news tiene separate le notizie dai concorsi", async () => {
    const store2 = createMemoryStore();
    await store2.upsertPrefs(prefs());
    await seed(store2, [
      { title: "Concorso su cui si partecipa", kind: "contest" },
      { title: "Articolo che parla del concorso", kind: "news", sourceId: "news-brand" },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store2, tg));
    // /start manda un messaggio nuovo: per rivedere il menù si tocca Aggiorna.
    await handleUpdate(tap(2, "refresh", 100), deps(store2, tg));

    // Il menù conta le due cose separatamente.
    const menu = lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    expect(menu.inline_keyboard.flat().find((b) => b.callback_data === "s:news")?.text).toBe("📰 News (1)");
    expect(menu.inline_keyboard.flat().find((b) => b.callback_data === "s:oggi")?.text).toBe("📋 Oggi (1)");

    // La sezione dei concorsi non contiene il link all'articolo...
    await handleUpdate(tap(3, "s:oggi", 100), deps(store2, tg));
    const concorsi = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(concorsi).toContain("1 concorso");
    const righeConcorsi = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][];
    }).inline_keyboard;
    expect(righeConcorsi[0]?.[0]?.text).toContain("Concorso su cui si partecipa");
    expect(righeConcorsi.flat().some((b) => b.text.includes("Articolo che parla"))).toBe(false);

    // ...e la sezione news contiene solo quello.
    await handleUpdate(tap(4, "s:news", 100), deps(store2, tg));
    const news = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(news).toContain("Articoli e news");
    expect(news).toContain("1 articolo");
    const righeNews = (lastWith(calls, "editMessageText")?.payload.reply_markup as {
      inline_keyboard: { text: string }[][];
    }).inline_keyboard;
    expect(righeNews[0]?.[0]?.text).toContain("Articolo che parla del concorso");
    expect(righeNews[0]?.[0]?.text).toContain("📰");
  });

  it("la sezione fonti mostra fonti e ultime raccolte", async () => {
    const { tg, calls } = makeTg();
    store.seedSources([
      {
        id: "vincimi", name: "Vincimi", kind: "rss", url: "https://v.example/feed", category: "online",
        tags: ["aggregatore"], cadenceMin: 45, enabled: true, etag: null, lastModified: null,
        lastRunAt: "2026-11-20T09:00:00.000Z", lastOkAt: "2026-11-20T09:00:00.000Z", failStreak: 0,
        lastStatus: 200, lastError: null, lastItems: 12,
      },
      {
        // Una fonte che ha risposto con un 403: è la riga che prima si trovava
        // solo nel log del runner di GitHub.
        id: "scontrinofelice", name: "Scontrino Felice", kind: "rss", url: "https://s.example/feed",
        category: "scontrino", tags: ["scontrino"], cadenceMin: 30, enabled: true, etag: null,
        lastModified: null, lastRunAt: "2026-11-20T09:05:00.000Z", lastOkAt: "2026-11-19T08:00:00.000Z",
        failStreak: 2, lastStatus: 403, lastError: "HTTP 403", lastItems: 0,
      },
    ]);
    await store.recordRun({
      startedAt: "2026-11-20T09:30:00.000Z", trigger: "actions", sourcesOk: 12, sourcesFail: 0, itemsNew: 22, ms: 4000, note: null, log: null,
    });
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:fonti", 100), deps(store, tg));

    const testo = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(testo).toContain("2 configurate, 2 attive");
    // Ora, codice HTTP e quanti item: la fonte si controlla da qui.
    expect(testo).toContain("🟢 Vincimi · 20/11 10:00 · HTTP 200 · 12 item");
    expect(testo).toContain("🔴 Scontrino Felice · 20/11 10:05 · HTTP 403 · ⚠️ 2 di fila");
    expect(testo).toContain("GitHub 20/11 10:30 · 12 ok / 0 errori · 22 nuovi");
  });

  it("è idempotente sullo stesso update_id", async () => {
    const { tg, calls } = makeTg();
    expect((await handleUpdate(command(1, "/start"), deps(store, tg))).handled).toBe(true);
    calls.length = 0;
    expect((await handleUpdate(command(1, "/start"), deps(store, tg))).handled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("le chat non autorizzate ricevono solo il proprio id", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(
      { update_id: 4, message: { message_id: 7, chat: { id: 999 }, text: "/start", from: { id: 999 } } },
      deps(store, tg),
    );
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("⛔ Bot privato");
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("999");
    expect(calls.filter((call) => call.method === "deleteMessage")).toHaveLength(0);
    expect(await store.getUiState(999)).toBeNull();
  });

  it("i comandi restano scorciatoie: /scadenze apre la sezione giusta", async () => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/start"), deps(store, tg));
    calls.length = 0;
    await handleUpdate(command(2, "/scadenze"), deps(store, tg));
    expect((await store.getUiState(CHAT))?.section).toBe("scadenze");
    // Il comando sparisce, la schermata precedente viene tolta, la nuova arriva:
    // la scorciatoia non lascia messaggi appesi.
    expect(calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload.message_id)).toEqual([
      2, 100,
    ]);
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("In scadenza");
  });
});

describe("filtri personali · due chat, due feed", () => {
  const AMICA = 777;

  /** Comandi e tocchi per una chat qualsiasi: i filtri sono per chat. */
  const cmd = (chatId: number, updateId: number, text: string): TelegramUpdate => ({
    update_id: updateId,
    message: { message_id: updateId, chat: { id: chatId }, text, from: { id: chatId } },
  });
  const tapIn = (chatId: number, updateId: number, data: string, messageId: number): TelegramUpdate => ({
    update_id: updateId,
    callback_query: { id: `cb-${updateId}`, data, message: { message_id: messageId, chat: { id: chatId } }, from: { id: chatId } },
  });
  const entrambe = (store: MemoryStore, tg: TelegramClient) => ({
    store,
    tg,
    now: NOW,
    adminChatId: CHAT,
    allowedChatIds: [CHAT, AMICA],
  });

  /** Testo dell'ultimo messaggio spedito/modificato, per chat, senza i tag HTML. */
  const schermata = (calls: Call[], chatId: number): string => {
    const call = [...calls]
      .reverse()
      .find((entry) => (entry.method === "editMessageText" || entry.method === "sendMessage") && entry.payload.chat_id === chatId);
    return String(call?.payload.text ?? "").replace(/<\/?b>/g, "");
  };
  const bottoni = (calls: Call[], chatId: number): { text: string; callback_data?: string }[][] => {
    const call = [...calls]
      .reverse()
      .find((entry) => (entry.method === "editMessageText" || entry.method === "sendMessage") && entry.payload.chat_id === chatId);
    const tastiera = call?.payload.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined;
    return tastiera?.inline_keyboard ?? [];
  };

  async function dueChat(store: MemoryStore): Promise<void> {
    await store.upsertPrefs(prefs());
    await store.upsertPrefs({ ...prefs(), chatId: AMICA });
  }

  it("🎛 Cosa vedi spegne un tipo di concorso solo per chi lo tocca", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Raccolta bollini Bennet", tags: ["raccolta_punti"] },
      { title: "Concorso gift card", tags: ["giftcard"] },
      { title: "Concorso viaggio a Parigi", tags: ["viaggio"] },
    ]);
    const { tg, calls } = makeTg();

    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:filtri", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("Cosa vedi");
    expect(schermata(calls, CHAT)).toContain("solo per te");

    await handleUpdate(tapIn(CHAT, 3, "cfg:tag:raccolta_punti", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.mutedTags).toEqual(["raccolta_punti"]);
    // Il messaggio in sovraimpressione dice cosa è successo, e la schermata resta
    // quella dei filtri (non si torna al menù a ogni tocco).
    const conferma = calls.filter((call) => call.method === "answerCallbackQuery").pop();
    expect(String(conferma?.payload.text)).toContain("Raccolte punti");
    expect(schermata(calls, CHAT)).toContain("Cosa vedi");

    // L'elenco si accorcia e il numero in testa dice che è per via dei filtri.
    await handleUpdate(tapIn(CHAT, 4, "s:oggi", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("2 concorsi");
    const titoli = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(titoli.join("\n")).not.toContain("Raccolta bollini");
    expect(titoli.join("\n")).toContain("gift card");

    await handleUpdate(tapIn(CHAT, 5, "home", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("🎛 Filtri tuoi");
    expect(schermata(calls, CHAT)).toContain("2 di 3 concorsi");

    // L'altra persona non ha toccato niente: per lei l'archivio è quello intero.
    expect((await store.getPrefs(AMICA))?.filters).toEqual(defaultFilters());
    await handleUpdate(cmd(AMICA, 6, "/start"), entrambe(store, tg));
    const suo = schermata(calls, AMICA);
    expect(suo).toContain("3 concorsi");
    expect(suo).not.toContain("Filtri tuoi");
    await handleUpdate(tapIn(AMICA, 7, "s:oggi", 200), entrambe(store, tg));
    const suoi = bottoni(calls, AMICA).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(suoi.join("\n")).toContain("Raccolta bollini");
  });

  it("spegne una fonte e una categoria, e i loro concorsi escono dall'elenco", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Concorso Vincimi", sourceId: "vincimi", tags: ["giftcard"] },
      { title: "Concorso con scontrino", sourceId: "scontrinofelice-acquisto", tags: ["acquisto"] },
      { title: "Concorso Ferrero", sourceId: "sitemap-ferrero", tags: ["brand"] },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));

    await handleUpdate(tapIn(CHAT, 2, "cfg:src:vincimi", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.mutedSources).toEqual(["vincimi"]);

    await handleUpdate(tapIn(CHAT, 3, "cfg:cat:scontrino", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.mutedCategories).toEqual(["scontrino"]);

    await handleUpdate(tapIn(CHAT, 4, "home", 100), entrambe(store, tg));
    const menu = schermata(calls, CHAT);
    expect(menu).toContain("1 di 3 concorsi");
    await handleUpdate(tapIn(CHAT, 5, "s:oggi", 100), entrambe(store, tg));
    const rimasti = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(rimasti.join("\n")).toContain("Ferrero");
    expect(rimasti.join("\n")).not.toContain("Vincimi");
    expect(rimasti.join("\n")).not.toContain("scontrino");
  });

  it("🎁 solo senza acquisto lascia fuori chi chiede la spesa", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Concorso gratuito Kanzi", requiresPurchase: false },
      { title: "Concorso con scontrino Conad", requiresPurchase: true },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:filtri", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 3, "cfg:free:on", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.freeOnly).toBe(true);

    await handleUpdate(tapIn(CHAT, 4, "s:oggi", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("1 concorso");
    const titoli = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(titoli.join("\n")).toContain("Kanzi");
    expect(titoli.join("\n")).not.toContain("Conad");
  });

  it("📡 Scegli le fonti si sfoglia a pagine e non torna indietro a ogni tocco", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:filtri-fonti", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("pagina 1/");

    const primaPagina = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("cfg:src:"));
    expect(primaPagina.length).toBeGreaterThan(0);
    // Ogni bottone ha un id di fonte vero: sono quelli delle fonti accese.
    const spegnibili = new Set(filterableSources().map((source) => `cfg:src:${source.id}`));
    for (const bottone of primaPagina) expect(spegnibili.has(bottone.callback_data ?? "")).toBe(true);

    await handleUpdate(tapIn(CHAT, 3, "page:1", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("pagina 2/");
    const secondaPagina = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("cfg:src:"));
    expect(secondaPagina.length).toBeGreaterThan(0);
    // Le due pagine non si sovrappongono.
    const primi = primaPagina.map((b) => b.callback_data);
    for (const bottone of secondaPagina) expect(primi).not.toContain(bottone.callback_data);

    const scelta = secondaPagina[0];
    await handleUpdate(tapIn(CHAT, 4, String(scelta.callback_data), 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.mutedSources).toHaveLength(1);
    // Il tocco non riporta alla prima pagina: si resta dove si era.
    expect(schermata(calls, CHAT)).toContain("pagina 2/");
    const cambiato = bottoni(calls, CHAT).flat().find((b) => b.callback_data === scelta.callback_data);
    expect(cambiato?.text.startsWith("🚫")).toBe(true);
  });

  it("🏷 Marche seguite: la marca seguita vale di più e ha la sua sezione", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Concorso Nutella", brand: "ferrero" },
      { title: "Concorso Conad bollini", brand: "conad" },
      { title: "Concorso senza marca", brand: null },
    ]);
    const { tg, calls } = makeTg();
    const voci = (): { text: string; callback_data?: string }[] => bottoni(calls, CHAT).flat();
    const conMarca = async (): Promise<number> =>
      (await store.queryItems({ limit: 10 })).find((item) => item.brand === "ferrero")?.score ?? -1;

    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    // Il menù ha la voce, e prima di seguire qualcosa conta zero.
    expect(voci().find((b) => b.callback_data === "s:preferiti")?.text).toBe("🏷 Marche seguite (0)");

    await handleUpdate(tapIn(CHAT, 2, "s:preferiti", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("Marche seguite");
    // La schermata dice cosa cambia a seguirne una: punti, sezione sua, avviso.
    expect(schermata(calls, CHAT)).toContain("10 punti in più");
    expect(schermata(calls, CHAT)).toContain("ti avviso appena ne esce uno");
    // Le marche con concorsi in archivio stanno in cima, con il conteggio.
    const marche = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("cfg:brand:"));
    expect(marche).toHaveLength(BRANDS_PAGE_SIZE);
    // Le marche con concorsi in archivio stanno in cima (a pari conteggio in
    // ordine alfabetico), le altre seguono.
    expect(marche.slice(0, 2).map((b) => b.text)).toEqual(["⬜️ Conad (1)", "⬜️ Ferrero (1)"]);
    expect(schermata(calls, CHAT)).toContain("Pagina 1/");

    // Accendere la marca ricalcola i punteggi già in archivio: è la differenza
    // fra una promessa e un numero che si vede subito.
    await handleUpdate(tapIn(CHAT, 3, "cfg:brand:ferrero", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.favoriteBrands).toEqual(["ferrero"]);
    expect(String(calls.filter((c) => c.method === "answerCallbackQuery").pop()?.payload.text)).toContain("Ferrero");
    const conBonus = await conMarca();
    await handleUpdate(tapIn(CHAT, 4, "cfg:brand:ferrero", 100), entrambe(store, tg));
    const senzaBonus = await conMarca();
    expect(conBonus - senzaBonus).toBe(SCORE_WEIGHTS.favoriteBrand);
    await handleUpdate(tapIn(CHAT, 5, "cfg:brand:ferrero", 100), entrambe(store, tg));
    expect(bottoni(calls, CHAT).flat().find((b) => b.callback_data === "cfg:brand:ferrero")?.text).toBe("✅ Ferrero (1)");

    // La sezione mostra solo i concorsi di quella marca.
    await handleUpdate(tapIn(CHAT, 6, "s:preferiti-lista", 100), entrambe(store, tg));
    const elenco = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(elenco.join("\n")).toContain("Nutella");
    expect(elenco.join("\n")).not.toContain("Conad");
    expect(schermata(calls, CHAT)).toContain("1 concorso");

    await handleUpdate(tapIn(CHAT, 7, "home", 100), entrambe(store, tg));
    expect(voci().find((b) => b.callback_data === "s:preferiti")?.text).toBe("🏷 Marche seguite (1)");

    // Il filtro vero: "solo le marche che seguo" toglie il resto dagli elenchi.
    await handleUpdate(tapIn(CHAT, 8, "s:preferiti", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 9, "cfg:brands:on", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.brandsOnly).toBe(true);
    expect(schermata(calls, CHAT)).toContain("Filtro acceso");
    await handleUpdate(tapIn(CHAT, 10, "s:oggi", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("1 concorso");
    const solo = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(solo.join("\n")).toContain("Nutella");
    expect(solo.join("\n")).not.toContain("senza marca");
    // Nel menù il filtro si conta, e dice "vedi 1 di 3".
    await handleUpdate(tapIn(CHAT, 11, "home", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("1 di 3 concorsi");

    // L'altra chat non ha toccato niente.
    expect((await store.getPrefs(AMICA))?.filters).toEqual(defaultFilters());
  });

  it("i preferiti vuoti mandano dove si accende una marca", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [{ title: "Concorso senza marca", brand: null }]);
    const { tg, calls } = makeTg();

    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:preferiti-lista", 100), entrambe(store, tg));
    expect(schermata(calls, CHAT)).toContain("Non segui ancora nessuna marca");
    expect(bottoni(calls, CHAT).flat().some((b) => b.callback_data === "s:preferiti")).toBe(true);

    // Il filtro senza marche da seguire non nasconde niente: il bottone è inerte
    // e non si scrive che c'è un filtro attivo.
    await handleUpdate(tapIn(CHAT, 3, "s:preferiti", 100), entrambe(store, tg));
    const inerte = bottoni(calls, CHAT).flat().find((b) => b.text.includes("Solo le marche seguite"));
    expect(inerte?.callback_data).toBe("noop");
    expect(schermata(calls, CHAT)).not.toContain("Filtro acceso");

    // Svuotare l'elenco spegne anche il filtro, e i punteggi tornano com'erano.
    await handleUpdate(tapIn(CHAT, 4, "cfg:brand:conad", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 5, "cfg:brands:on", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.brandsOnly).toBe(true);
    await handleUpdate(tapIn(CHAT, 6, "cfg:brands:reset", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.favoriteBrands).toEqual([]);
    expect((await store.getPrefs(CHAT))?.filters.brandsOnly).toBe(false);
  });

  it("la riga delle stelle sta in elenco e filtra dove serve", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Concorso scarso", score: 40 },
      { title: "Concorso buono", score: 72 },
      { title: "Concorso ottimo", score: 88 },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:oggi", 100), entrambe(store, tg));

    const aperti = (): string[] =>
      bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    // La riga è una sola, in fondo all'elenco, e dice quale soglia è attiva.
    const riga = bottoni(calls, CHAT).find((riga) => riga.some((b) => b.callback_data?.startsWith("cfg:star:")));
    expect(riga?.map((b) => b.callback_data)).toEqual(["cfg:star:0", "cfg:star:70", "cfg:star:80"]);
    expect(riga?.[0]?.text.startsWith("•")).toBe(true);
    // E l'elenco è ordinato dal punteggio più alto: il primo è il migliore.
    expect(aperti()[0]).toContain("ottimo");

    await handleUpdate(tapIn(CHAT, 3, "cfg:star:80", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.minScore).toBe(80);
    expect(schermata(calls, CHAT)).toContain("Oggi (dalle 00:00)"); // resta dove sei
    expect(schermata(calls, CHAT)).toContain("1 concorso");
    expect(aperti()).toHaveLength(1);
    expect(aperti()[0]).toContain("ottimo");
    expect((await store.getPrefs(AMICA))?.filters.minScore).toBe(0);

    // Nella sezione news la riga non c'è: il punteggio di un articolo non è una stella.
    await seed(store, [{ title: "Articolo che parla di concorsi", kind: "news", score: 50 }]);
    await handleUpdate(tapIn(CHAT, 4, "s:news", 100), entrambe(store, tg));
    expect(bottoni(calls, CHAT).flat().some((b) => b.callback_data?.startsWith("cfg:star:"))).toBe(false);

    // E dalla schermata dei filtri si può rimettere su "tutte".
    await handleUpdate(tapIn(CHAT, 5, "cfg:star:0", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.minScore).toBe(0);
  });

  it("l'elenco dei concorsi parte dal punteggio più alto, non dall'ultimo arrivato", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Arrivato per ultimo e scarso", score: 30, firstSeenAt: "2026-11-20T11:00:00.000Z" },
      { title: "Arrivato prima e ottimo", score: 90, firstSeenAt: "2026-11-20T08:00:00.000Z" },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:oggi", 100), entrambe(store, tg));

    const aperti = bottoni(calls, CHAT).flat().filter((b) => b.callback_data?.startsWith("open:")).map((b) => b.text);
    expect(aperti[0]).toContain("ottimo");
    expect(aperti[1]).toContain("scarso");
  });

  it("un elenco vuoto con i filtri attivi dice che può essere per quello", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [{ title: "Concorso scarso", score: 40 }]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:oggi", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 3, "cfg:star:80", 100), entrambe(store, tg));

    expect(schermata(calls, CHAT)).toContain("filtri attivi");
    expect(bottoni(calls, CHAT).flat().some((b) => b.callback_data === "s:filtri")).toBe(true);

    // Senza filtri, un elenco vuoto è solo un elenco vuoto: nessun invito a
    // toccare filtri che non esistono.
    const vuoto = createMemoryStore();
    await dueChat(vuoto);
    await handleUpdate(cmd(CHAT, 4, "/start"), entrambe(vuoto, tg));
    await handleUpdate(tapIn(CHAT, 5, "s:oggi", 100), entrambe(vuoto, tg));
    expect(schermata(calls, CHAT)).not.toContain("filtri attivi");
    expect(bottoni(calls, CHAT).flat().some((b) => b.callback_data === "s:filtri")).toBe(false);
  });

  it("♻️ rimette tutto come prima", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    await seed(store, [
      { title: "Raccolta bollini Bennet", tags: ["raccolta_punti"] },
      { title: "Concorso viaggio a Parigi", tags: ["viaggio"] },
    ]);
    const { tg, calls } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "s:filtri", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 3, "cfg:tag:raccolta_punti", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 4, "cfg:free:on", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 5, "cfg:src:vincimi", 100), entrambe(store, tg));
    expect(activeFilterCount((await store.getPrefs(CHAT))!.filters)).toBe(3);

    await handleUpdate(tapIn(CHAT, 6, "cfg:reset:all", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters).toEqual(defaultFilters());
    expect(schermata(calls, CHAT)).toContain("tutto");

    await handleUpdate(tapIn(CHAT, 7, "home", 100), entrambe(store, tg));
    const menu = schermata(calls, CHAT);
    expect(menu).toContain("2 concorsi");
    expect(menu).not.toContain("Filtri tuoi");
  });

  it("un tocco con un valore inventato non entra nelle preferenze", async () => {
    const store = createMemoryStore();
    await dueChat(store);
    const { tg } = makeTg();
    await handleUpdate(cmd(CHAT, 1, "/start"), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 2, "cfg:src:fonte-che-non-esiste", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 3, "cfg:tag:tag-inventato", 100), entrambe(store, tg));
    await handleUpdate(tapIn(CHAT, 4, "cfg:cat:marzapane", 100), entrambe(store, tg));
    expect((await store.getPrefs(CHAT))?.filters).toEqual(defaultFilters());
  });
});

describe("digest e avvisi", () => {
  it("riconosce la fascia di silenzio", () => {
    expect(isQuietHour(prefs(), new Date("2026-11-20T23:30:00Z"))).toBe(true); // 00:30 a Roma
    expect(isQuietHour(prefs(), new Date("2026-11-20T12:00:00Z"))).toBe(false); // 13:00 a Roma
    expect(isQuietHour(prefs({ quietHours: "" }), new Date("2026-11-20T23:30:00Z"))).toBe(false);
  });

  it("trova l'URL del regolamento senza duplicare la pagina", () => {
    expect(regolamentoUrl(row({ summary: "Vedi https://esempio.it/regolamento.pdf per i dettagli" }))).toBe(
      "https://esempio.it/regolamento.pdf",
    );
    expect(regolamentoUrl(row({ url: "https://esempio.it/regolamento", summary: "" }))).toBeNull();
  });

  it("il bando salvato dalla raccolta vale più del testo dell'item", () => {
    // È il caso per cui la colonna esiste: il riassunto del feed non nominava
    // nessun regolamento, ma la pagina del concorso sì.
    expect(
      regolamentoUrl(
        row({ url: "https://esempio.it/concorso", summary: "Partecipa con lo scontrino.", rulesUrl: "https://esempio.it/bando.pdf" }),
      ),
    ).toBe("https://esempio.it/bando.pdf");
    // Un "bando" che punta alla pagina stessa non è un bottone in più.
    expect(
      regolamentoUrl(row({ url: "https://esempio.it/concorso", rulesUrl: "https://esempio.it/concorso" })),
    ).toBeNull();
  });

  it("non manda digests a chi li ha spenti dalle impostazioni", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs({ digestHours: [] }));
    await seed(store, [{ title: "Concorso da digest" }]);
    const { tg, calls } = makeTg();
    const result = await sendDigests({ store, tg, now: NOW });
    expect(result).toEqual({ chats: 0, messages: 0 });
    expect(calls).toHaveLength(0);
  });

  it("ricorda i concorsi in watchlist prima che chiudano, senza ripetersi", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [
      { title: "Chiude tra tre giorni", deadline: "2026-11-23" },
      { title: "Chiude fra dieci giorni", deadline: "2026-11-30" },
    ]);
    for (const id of ids) await store.recordDelivery(CHAT, id, "saved", NOW.toISOString());
    const { tg, calls } = makeTg();

    // A tre giorni dalla chiusura arriva il primo promemoria; quello che chiude fra
    // dieci giorni resta in silenzio.
    expect(await sendWatchlistReminders({ store, tg, now: NOW })).toEqual({ sent: 1 });
    const primo = lastWith(calls, "sendMessage")?.payload.text ?? "";
    expect(primo).toContain("⭐ <b>Watchlist</b> · chiude tra 3 giorni");
    expect(primo).toContain("Chiude tra tre giorni");
    expect(primo).not.toContain("Chiude fra dieci giorni");

    // Lo stesso giro non lo ripete...
    expect(await sendWatchlistReminders({ store, tg, now: NOW })).toEqual({ sent: 0 });

    // ...ma il giorno prima della chiusura arriva il secondo avviso, una volta sola.
    const domani = new Date("2026-11-22T10:00:00.000Z");
    expect(await sendWatchlistReminders({ store, tg, now: domani })).toEqual({ sent: 1 });
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("chiude domani");
    expect(await sendWatchlistReminders({ store, tg, now: domani })).toEqual({ sent: 0 });
  });

  it("senza scadenza la watchlist non produce promemoria", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [{ title: "Concorso senza data", deadline: null }]);
    await store.recordDelivery(CHAT, ids[0], "saved", NOW.toISOString());
    const { tg, calls } = makeTg();

    expect(await sendWatchlistReminders({ store, tg, now: NOW })).toEqual({ sent: 0 });
    expect(calls).toHaveLength(0);
  });

  it("la scala dei promemoria la decidono i tag dell'item", () => {
    // Le raccolte punti e i premi da richiedere si avvisano molto prima: a tre
    // giorni dalla fine di una raccolta è tardi per cominciare a mettere via gli
    // scontrini, e il premio va richiesto.
    expect(reminderDaysFor(row({ tags: ["raccolta_punti", "punto_vendita"] }))).toEqual([30, 7, 1]);
    expect(reminderDaysFor(row({ tags: ["premio_da_richiedere"] }))).toEqual([30, 7, 1]);
    expect(reminderDaysFor(row({ tags: ["viaggio"] }))).toEqual([3, 1]);
  });

  it("una raccolta punti si ricorda a trenta giorni, con il consiglio giusto", async () => {
    // Il caso vero: la raccolta Bennet chiude il 20 dicembre, ma i bollini si
    // collezionano alla cassa una spesa alla volta. Il promemoria standard (3
    // giorni) arriverebbe quando non c'è più niente da mettere via.
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [
      {
        title: "Raccolta bollini Bennet Guzzini: scopri tutti i premi",
        tags: ["raccolta_punti", "punto_vendita"],
        deadline: "2026-12-20",
      },
      { title: "Concorso normale che chiude lo stesso giorno", deadline: "2026-12-20" },
    ]);
    for (const id of ids) await store.recordDelivery(CHAT, id, "saved", NOW.toISOString());
    const { tg, calls } = makeTg();

    expect(await sendWatchlistReminders({ store, tg, now: NOW })).toEqual({ sent: 1 });
    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("🧾 <b>Raccolta punti</b> · chiude tra 30 giorni");
    expect(testo).toContain("scontrini e bollini");
    expect(testo).toContain("Bennet");
    // Il concorso normale che chiude lo stesso giorno tace: la sua scala è a 3.
    expect(testo).not.toContain("Concorso normale");

    // Lo stesso giro non lo ripete.
    expect(await sendWatchlistReminders({ store, tg, now: NOW })).toEqual({ sent: 0 });
  });

  it("la scala della raccolta non ricade sulle soglie del concorso", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [
      {
        title: "Raccolta bollini Bennet Guzzini: colleziona i premi",
        tags: ["raccolta_punti"],
        deadline: "2026-12-20",
      },
    ]);
    await store.recordDelivery(CHAT, ids[0], "saved", NOW.toISOString());
    const { tg, calls } = makeTg();

    expect(await sendWatchlistReminders({ store, tg, now: NOW })).toEqual({ sent: 1 }); // 30

    // A sette giorni: è il momento in cui il premio si richiede.
    expect(await sendWatchlistReminders({ store, tg, now: new Date("2026-12-13T10:00:00.000Z") })).toEqual({ sent: 1 });
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("chiude tra 7 giorni");

    // A tre giorni dalla chiusura non arriva niente: per una raccolta quella
    // soglia non esiste. Non è un giro mancato — è una scala diversa, e il
    // promemoria dei sette giorni l'hai già ricevuto.
    expect(await sendWatchlistReminders({ store, tg, now: new Date("2026-12-17T10:00:00.000Z") })).toEqual({ sent: 0 });

    // E il giorno prima, come per tutti: è l'ultimo momento utile.
    expect(await sendWatchlistReminders({ store, tg, now: new Date("2026-12-19T10:00:00.000Z") })).toEqual({ sent: 1 });
    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("chiude domani");
  });

  it("un premio da richiedere si ricorda prima, e il messaggio dice perché", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [
      { title: "Vinci una e-bike e riscattala entro trenta giorni", tags: ["premio_da_richiedere"], deadline: "2026-12-20" },
    ]);
    await store.recordDelivery(CHAT, ids[0], "saved", NOW.toISOString());
    const { tg, calls } = makeTg();

    expect(await sendWatchlistReminders({ store, tg, now: NOW })).toEqual({ sent: 1 });
    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("🎫 <b>Premio da richiedere</b> · chiude tra 30 giorni");
    expect(testo).toContain("va richiesto");
    // Non è una raccolta punti: il consiglio sugli scontrini qui non c'entra.
    expect(testo).not.toContain("bollini");
  });

  it("un articolo non fa scattare un avviso immediato, anche se ha il punteggio più alto", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs({ minScoreInstant: 60 }));
    await seed(store, [{ title: "Articolo sui concorsi", kind: "news", score: 99, sourceId: "news-brand" }]);
    const { tg, calls } = makeTg();

    expect(await sendInstantAlerts({ store, tg, now: NOW })).toEqual({ sent: 0 });
    expect(calls).toHaveLength(0);
  });

  it("un concorso di una marca seguita avvisa anche sotto la soglia", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(
      prefs({
        minScoreInstant: 80,
        filters: { ...defaultFilters(), favoriteBrands: ["ferrero"] },
      }),
    );
    // Punteggio basso: premio piccolo e scadenza lontana. Con la sola soglia non
    // arriverebbe mai, ed è esattamente il caso che "seguo Ferrero" chiedeva.
    await seed(store, [
      { title: "Concorso Ferrero Nutella: vinci 10 euro di spesa", brand: "ferrero", score: 30 },
    ]);
    const { tg, calls } = makeTg();

    expect(await sendInstantAlerts({ store, tg, now: NOW })).toEqual({ sent: 1 });

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("Concorso Ferrero Nutella");
    // La riga dice perché è arrivato senza il punteggio alto: senza, sembra un errore.
    expect(testo).toContain("🏷 <b>Ferrero</b> · marca che segui");
  });

  it("una marca che non segui resta sotto la soglia: la regola è solo per le tue", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(
      prefs({
        minScoreInstant: 80,
        filters: { ...defaultFilters(), favoriteBrands: ["ferrero"] },
      }),
    );
    await seed(store, [{ title: "Concorso Barilla", brand: "barilla", score: 30 }]);
    const { tg, calls } = makeTg();

    expect(await sendInstantAlerts({ store, tg, now: NOW })).toEqual({ sent: 0 });
    expect(calls).toHaveLength(0);
  });

  it("la marca seguita non scavalca il silenzio notturno né le fonti spente", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(
      prefs({
        minScoreInstant: 80,
        filters: { ...defaultFilters(), favoriteBrands: ["ferrero"], mutedSources: ["premieconcorsi"] },
      }),
    );
    await seed(store, [
      { title: "Concorso Ferrero di notte", brand: "ferrero", score: 30 },
    ]);
    const { tg } = makeTg();
    // 00:30 a Roma: la fascia di silenzio (23-7) vale anche per le marche seguite.
    expect(await sendInstantAlerts({ store, tg, now: new Date("2026-11-20T23:30:00.000Z") })).toEqual({ sent: 0 });
    // Di giorno sì, ma la fonte è spenta: quello è un "non lo voglio vedere".
    expect(await sendInstantAlerts({ store, tg, now: NOW })).toEqual({ sent: 0 });
  });

  it("gli articoli non finiscono nel digest: si leggono nella sezione news", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await seed(store, [{ title: "Concorso vero", kind: "contest", score: 95 }]);
    await seed(store, [{ title: "Articolo sui concorsi", kind: "news", score: 99, sourceId: "news-brand" }]);
    const { tg, calls } = makeTg();

    await sendDigests({ store, tg, now: NOW });
    const testo = calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => String(call.payload.text))
      .join("\n");
    expect(testo).toContain("Concorso vero");
    expect(testo).not.toContain("Articolo sui concorsi");
  });

  it("il digest porta i bottoni per aprire i concorsi, senza essere cancellato", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [{ title: "Concorso da digest" }]);
    const { tg, calls } = makeTg();

    const result = await sendDigests({ store, tg, now: NOW });
    expect(result.messages).toBe(1);

    const inviato = lastWith(calls, "sendMessage");
    const keyboard = inviato?.payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] };
    expect(keyboard.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([`d:open:${ids[0]}`, "d:home"]);
  });
});

describe("promemoria · la raccolta ferma non resta invisibile", () => {
  /** Una riga di `runs`: ore fa rispetto a NOW, con l'eventuale nota del tick. */
  const run = (trigger: string, oreFa: number, note: string | null = null): RunRow => ({
    startedAt: new Date(NOW.getTime() - oreFa * 3_600_000).toISOString(),
    trigger,
    sourcesOk: 1,
    sourcesFail: 0,
    itemsNew: 0,
    ms: 100,
    note,
    log: null,
  });

  /** Il tick del Worker, che gira anche quando GitHub tace. */
  const tick = (oreFa: number, note: string | null = null): RunRow => run(NOTIFY_CRON, oreFa, note);

  it("avvisa l'admin, dicendo da quanto tace GitHub e chi sta coprendo", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const { tg, calls } = makeTg();

    const result = await sendCollectionReminder({
      store,
      tg,
      now: NOW,
      adminChatId: CHAT,
      runs: [tick(0.25), run("actions", 4)],
      fallback: { ok: 2, due: 4 },
    });

    expect(result.sent).toBe(1);
    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("Raccolta ferma da 4 ore");
    expect(testo).toContain("L'ultima raccolta su GitHub è girata 4 ore fa");
    expect(testo).toContain("2 fonti su 4");
    expect(testo).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("con una raccolta recente non dice niente", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const { tg, calls } = makeTg();

    const result = await sendCollectionReminder({
      store,
      tg,
      now: NOW,
      adminChatId: CHAT,
      runs: [tick(0.25), run("actions", 1)],
      fallback: null,
    });

    expect(result.sent).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("non ripete lo stesso guasto a ogni tick", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const { tg, calls } = makeTg();

    const result = await sendCollectionReminder({
      store,
      tg,
      now: NOW,
      adminChatId: CHAT,
      // Il promemoria di due ore fa è nella nota del tick: è così che il giro
      // successivo sa di aver già avvisato.
      runs: [tick(0.25, COLLECTION_REMINDER_MARK), run("actions", 4)],
      fallback: null,
    });

    expect(result.sent).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("non sveglia nessuno nella fascia di silenzio, ma la rispetta solo se c'è", async () => {
    const store = createMemoryStore();
    const notte = new Date("2026-11-20T22:30:00.000Z"); // 23:30 a Roma
    const runs = (): RunRow[] => [
      { ...tick(0.25), startedAt: new Date(notte.getTime() - 15 * 60_000).toISOString() },
      { ...run("actions", 4), startedAt: new Date(notte.getTime() - 4 * 3_600_000).toISOString() },
    ];

    await store.upsertPrefs(prefs());
    const zitto = makeTg();
    expect(
      await sendCollectionReminder({ store, tg: zitto.tg, now: notte, adminChatId: CHAT, runs: runs(), fallback: null }),
    ).toEqual({ sent: 0 });
    expect(zitto.calls).toHaveLength(0);

    await store.upsertPrefs(prefs({ quietHours: "" }));
    const sveglio = makeTg();
    expect(
      await sendCollectionReminder({ store, tg: sveglio.tg, now: notte, adminChatId: CHAT, runs: runs(), fallback: null }),
    ).toEqual({ sent: 1 });
  });

  it("senza admin configurato non manda niente", async () => {
    const store = createMemoryStore();
    const { tg, calls } = makeTg();
    expect(
      await sendCollectionReminder({
        store, tg, now: NOW, adminChatId: null, runs: [run("actions", 10)], fallback: null,
      }),
    ).toEqual({ sent: 0 });
    expect(calls).toHaveLength(0);
  });

  it("se anche i tick del Worker sono vecchi lo dice: è un altro guasto", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const { tg, calls } = makeTg();

    const result = await sendCollectionReminder({
      store,
      tg,
      now: NOW,
      adminChatId: CHAT,
      runs: [tick(5), run("actions", 6)],
      fallback: null,
    });

    expect(result.sent).toBe(1);
    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("anche i tick del Worker sono fermi da 5 ore");
    expect(testo).toContain("niente di nuovo entra");
  });

  it("se la raccolta non è nella finestra non inventa una data", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const { tg, calls } = makeTg();

    await sendCollectionReminder({
      store,
      tg,
      now: NOW,
      adminChatId: CHAT,
      // Solo tick: della raccolta su GitHub non resta niente in questa finestra.
      runs: [tick(0.25), tick(12)],
      fallback: null,
    });

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("Raccolta ferma da più di 12 ore");
    expect(testo).toContain("Su GitHub non risulta nessuna raccolta in questo periodo");
  });
});

describe("vantaggio di tempistica · comando /vantaggio", () => {
  /** Una vista di una fonte su un concorso: la riga che alimenta la misura. */
  const vista = (itemId: number, sourceId: string, seenAt: string, kept = true) => ({
    urlKey: `vista-${itemId}-${sourceId}`,
    sourceId,
    itemId,
    kind: "contest" as const,
    channel: channelOf(sourceId),
    seenAt,
    kept,
  });

  it("senza viste registrate dichiara che la misura parte da adesso", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/vantaggio"), deps(store, tg));

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("Vantaggio di tempistica");
    expect(testo).toContain("Ancora nessun concorso visto da entrambi i canali");
  });

  it("mostra mediana, verso e i due casi censurati", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [
      { title: "Concorso Barilla", sourceId: "premieconcorsi" },
      { title: "Concorso Conad", sourceId: "sitemap-conad" },
      { title: "Concorso Findus", sourceId: "premieconcorsi" },
    ]);
    // Il primo l'abbiamo visto prima noi di sei ore, il secondo solo dalle fonti
    // dirette, il terzo solo dagli aggregatori: i tre casi che il comando separa.
    await store.recordSighting(vista(ids[0], "premieconcorsi", "2026-11-20T08:00:00.000Z"));
    await store.recordSighting(vista(ids[0], "sitemap-conad", "2026-11-20T02:00:00.000Z"));
    await store.recordSighting(vista(ids[1], "sitemap-conad", "2026-11-20T03:00:00.000Z"));
    await store.recordSighting(vista(ids[2], "soldissimi", "2026-11-20T04:00:00.000Z"));
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/vantaggio"), deps(store, tg));

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("Su <b>1</b> concorso visto da entrambi i canali");
    expect(testo).toContain("Mediana <b>6 ore prima</b>");
    expect(testo).toContain("Prima noi: <b>1</b>");
    expect(testo).toContain("Solo da fonti dirette: <b>1</b>");
    expect(testo).toContain("Solo dagli aggregatori: <b>1</b>");
    expect(testo).toContain("Misuro da <b>1</b> giorno");
    expect((await store.getUiState(CHAT))?.section).toBe("vantaggio");
  });

  it("con viste da una sola parte dice che il confronto non esiste", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [
      { title: "Concorso Conad", sourceId: "sitemap-conad" },
      { title: "Concorso Barilla", sourceId: "premieconcorsi" },
    ]);
    // Il caso vero del primo giorno in produzione: la sitemap di un brand porta un
    // concorso che nessun aggregatore ha ancora ripreso.
    await store.recordSighting(vista(ids[0], "sitemap-conad", "2026-11-20T04:00:00.000Z"));
    await store.recordSighting(vista(ids[1], "premieconcorsi", "2026-11-20T04:00:00.000Z"));
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/vantaggio"), deps(store, tg));

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("Nessun concorso visto sia da una fonte diretta sia da un aggregatore");
    expect(testo).toContain("Solo da fonti dirette: <b>1</b>");
    expect(testo).toContain("Solo dagli aggregatori: <b>1</b>");
  });

  it("la scheda di un concorso porta il suo anticipo", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [{ title: "Concorso Barilla", sourceId: "premieconcorsi" }]);
    await store.recordSighting(vista(ids[0], "premieconcorsi", "2026-11-20T08:00:00.000Z"));
    await store.recordSighting(vista(ids[0], "sitemap-conad", "2026-11-20T02:00:00.000Z"));
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, `open:${ids[0]}`, 100), deps(store, tg));

    const testo = String(lastWith(calls, "editMessageText")?.payload.text ?? "");
    expect(testo).toContain("Visto <b>6 ore</b> prima degli aggregatori");
  });

  it("sulla scheda dice anche quando siamo arrivati dopo", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [{ title: "Concorso Barilla", sourceId: "premieconcorsi" }]);
    // L'aggregatore lo ha pubblicato alle 2, la pagina del brand alle 9: qui siamo
    // arrivati dopo, ed è la riga che dice quanto.
    await store.recordSighting(vista(ids[0], "premieconcorsi", "2026-11-20T02:00:00.000Z"));
    await store.recordSighting(vista(ids[0], "sitemap-conad", "2026-11-20T09:00:00.000Z"));
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, `open:${ids[0]}`, 100), deps(store, tg));

    const testo = String(lastWith(calls, "editMessageText")?.payload.text ?? "");
    expect(testo).toContain("Gli aggregatori l'hanno visto <b>7 ore</b> prima");
  });
});

describe("coupon e rimborsi · la sezione", () => {
  it("💶 Coupon e rimborsi mostra le offerte e non i concorsi", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await seed(store, [
      { title: "Concorso Barilla: vinci una cucina", kind: "contest" },
      { title: "Buono sconto Aia Spinacine da stampare", kind: "coupon", sourceId: "scontrinofelice-coupon" },
      { title: "Cashback Ymea: richiedi 25 euro di rimborso", kind: "coupon", sourceId: "scontrinofelice-cashback" },
    ]);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/coupon"), deps(store, tg));

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("Coupon e rimborsi");
    expect(testo).toContain("2 coupon");
    expect(testo).toContain("si spende meno, non si vince");
    const bottoni = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    const offerta = bottoni.find((bottone) => bottone.text.includes("Buono sconto Aia"));
    expect(offerta?.text).toContain("💶");
    expect(bottoni.some((bottone) => bottone.text.includes("Concorso Barilla"))).toBe(false);
    expect((await store.getUiState(CHAT))?.section).toBe("coupon");
  });

  it("un coupon con la validità finita non resta in elenco", async () => {
    // NOW è il 20 novembre: il codice Lidl era valido fino al 22 ottobre. Un buono
    // del genere non si può più spendere, e in 💶 Coupon sarebbe una riga da
    // toccare per niente — mentre chi non dichiara una validità resta, perché
    // "non lo so" non è una prova (il taglio lo fa COUPON_TTL_DAYS).
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await seed(store, [
      { title: "Buono sconto Crema Novi da stampare", kind: "coupon", deadline: null },
      { title: "Riscatta Codice Lidl per sfoglie gratis", kind: "coupon", deadline: "2026-10-22" },
    ]);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/coupon"), deps(store, tg));

    const bottoni = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(bottoni.some((bottone) => bottone.text.includes("Novi"))).toBe(true);
    expect(bottoni.some((bottone) => bottone.text.includes("Lidl"))).toBe(false);
    // Il numero sul bottone e in testa conta la stessa query: 1, non 2.
    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("1 coupon");
  });

  it("il coupon si conta nel menù e nell'archivio, ma non fra i concorsi", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await seed(store, [
      { title: "Concorso Findus", kind: "contest" },
      { title: "Buono sconto Novi", kind: "coupon" },
      { title: "Buono sconto Aia", kind: "coupon" },
    ]);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));

    const bottoni = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(bottoni.some((bottone) => bottone.text === "💶 Coupon e rimborsi (2)")).toBe(true);
    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("1</b> concorsi");
    expect(testo).toContain("2</b> coupon");
    // E nelle sezioni dei concorsi non entrano: 📋 Oggi conta un concorso solo.
    await handleUpdate(tap(2, "s:oggi", 100), deps(store, tg));
    const elenco = String(lastWith(calls, "editMessageText")?.payload.text ?? "");
    expect(elenco).toContain("1 concorso");
  });

  it("la scheda di un coupon dice che non si vince niente", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const ids = await seed(store, [{ title: "Buono sconto Président", kind: "coupon", score: 24 }]);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, `open:${ids[0]}`, 100), deps(store, tg));

    const testo = String(lastWith(calls, "editMessageText")?.payload.text ?? "");
    expect(testo).toContain("💶");
    expect(testo).toContain("qui non si vince niente, si spende meno");
    // Il punteggio non compare: su un buono sconto sarebbe un numero inventato.
    expect(testo).not.toContain("/100");
  });

  /** Un archivio con un coupon e un concorso, entrambi appetibili. */
  async function archivioMisto(): Promise<MemoryStore> {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs({ minScoreInstant: 80 }));
    await seed(store, [
      { title: "Buono sconto Novi Fondente", kind: "coupon", score: 99 },
      { title: "Concorso gratis con premio certo", kind: "contest", score: 99 },
    ]);
    return store;
  }

  it("un coupon non fa scattare gli avvisi: partono solo per i concorsi", async () => {
    // Le notifiche sono per le pagine su cui si partecipa: un buono sconto non
    // merita una sveglia alle 7 del mattino, e il punteggio alto non cambia
    // niente (qui è 99 per costruzione).
    const { tg, calls } = makeTg();

    const avvisi = await sendInstantAlerts(deps(await archivioMisto(), tg));

    expect(avvisi.sent).toBe(1);
    const testi = calls.filter((call) => call.method === "sendMessage").map((call) => String(call.payload.text));
    expect(testi.join("\n")).toContain("Concorso gratis con premio certo");
    expect(testi.join("\n")).not.toContain("Buono sconto Novi");
  });

  it("un coupon non entra nel digest", async () => {
    const { tg, calls } = makeTg();

    const digest = await sendDigests(deps(await archivioMisto(), tg));

    expect(digest.messages).toBe(1);
    const testi = calls.filter((call) => call.method === "sendMessage").map((call) => String(call.payload.text));
    expect(testi.join("\n")).toContain("Concorso gratis con premio certo");
    expect(testi.join("\n")).not.toContain("Buono sconto Novi");
  });
});

describe("solo gratis · la sezione", () => {
  /** Archivio con dentro tutto: gratis, a pagamento, coupon e articoli. */
  async function archivio(): Promise<MemoryStore> {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await seed(store, [
      { title: "Concorso Barilla senza obbligo di acquisto", requiresPurchase: false },
      { title: "Concorso Findus con scontrino", requiresPurchase: true },
      { title: "Buono sconto Aia gratis", kind: "coupon", requiresPurchase: false },
      { title: "Articolo: i concorsi gratis del mese", kind: "news", requiresPurchase: false },
    ]);
    return store;
  }

  it("/gratis tiene i concorsi senza acquisto e lascia fuori scontrini, coupon e news", async () => {
    const store = await archivio();
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/gratis"), deps(store, tg));

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("Solo gratis (senza acquisto)");
    expect(testo).toContain("1 concorso");
    // La riga in testa spiega perché quell'elenco è corto: è il punto della sezione.
    expect(testo).toContain("niente scontrino, niente codice, niente spesa minima");
    const bottoni = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(bottoni.some((b) => b.text.includes("senza obbligo di acquisto"))).toBe(true);
    expect(bottoni.some((b) => b.text.includes("con scontrino"))).toBe(false);
    // Un coupon senza acquisto e un articolo sui concorsi gratis non sono concorsi
    // su cui si partecipa: la sezione non li mostra.
    expect(bottoni.some((b) => b.text.includes("Buono sconto"))).toBe(false);
    expect(bottoni.some((b) => b.text.includes("Articolo"))).toBe(false);
    expect((await store.getUiState(CHAT))?.section).toBe("gratis");
  });

  it("🆓 Gratis sta dentro 🎁 Tipi di premio, non nel menù", async () => {
    // Una sezione sola, una porta sola: il menù non deve avere due modi per
    // arrivare alla stessa domanda ("quali posso fare senza comprare?"), con due
    // conteggi da tenere allineati.
    const store = await archivio();
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    const menu = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(menu.some((b) => b.callback_data === "s:gratis")).toBe(false);

    await handleUpdate(tap(2, "s:premi", 100), deps(store, tg));
    const bottoni = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    const gratis = bottoni.find((b) => b.callback_data === "s:gratis");
    // Un solo concorso senza acquisto in archivio: il numero è quello, non 3.
    expect(gratis?.text).toBe("🆓 Gratis (1)");

    await handleUpdate(tap(3, "s:gratis", 100), deps(store, tg));
    const elenco = String(lastWith(calls, "editMessageText")?.payload.text ?? "");
    expect(elenco).toContain("1 concorso");
  });

  it("è una domanda secca: non accende il filtro \"solo senza acquisto\" in 🎛 Cosa vedi", async () => {
    const store = await archivio();
    const { tg } = makeTg();

    await handleUpdate(command(1, "/gratis"), deps(store, tg));

    // Il filtro personale cambia tutte le sezioni e resta acceso; questa sezione
    // non deve toccare le preferenze di chi la apre.
    expect((await store.getPrefs(CHAT))?.filters.freeOnly).toBe(false);
  });

  it("rispetta i filtri della chat: con le stelle alzate l'elenco si accorcia", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs({ filters: { ...defaultFilters(), minScore: 50 } }));
    await seed(store, [
      { title: "Concorso gratis che vale", requiresPurchase: false, score: 90 },
      { title: "Concorso gratis mediocre", requiresPurchase: false, score: 20 },
    ]);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/gratis"), deps(store, tg));

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("1 concorso");
    const bottoni = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(bottoni.some((b) => b.text.includes("che vale"))).toBe(true);
    expect(bottoni.some((b) => b.text.includes("mediocre"))).toBe(false);
    // Il numero sul bottone nasce dalla stessa query: anche lui dice 1 — e sta in
    // 🎁 Tipi di premio, che è l'unica porta a questa sezione.
    await handleUpdate(tap(2, "s:premi", 100), deps(store, tg));
    const premi = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(premi.find((b) => b.callback_data === "s:gratis")?.text).toBe("🆓 Gratis (1)");
  });

  it("senza nessun concorso senza acquisto lo dice, invece di sembrare vuota per caso", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await seed(store, [{ title: "Concorso Findus con scontrino", requiresPurchase: true }]);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/gratis"), deps(store, tg));

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("Nessun concorso senza acquisto");
    expect(testo).toContain("chiedono uno scontrino");
  });
});

describe("tipi di premio · le porte dal menù", () => {
  /** Archivio con un esemplare per tipo di premio, più uno che non c'entra. */
  async function archivio(): Promise<MemoryStore> {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await seed(store, [
      // Tutti con acquisto, tranne nessuno: così 🆓 Gratis resta a 0 e si vede
      // che una porta può essere vuota senza che la schermata si rompa.
      { title: "Concorso con gift card da 500 euro", tags: ["giftcard"], score: 80, requiresPurchase: true },
      { title: "Vinci una Fiat Panda nuovo modello", tags: ["auto"], score: 70, requiresPurchase: true },
      { title: "Weekend per due in Sardegna", tags: ["viaggio"], score: 60, requiresPurchase: true },
      { title: "Buoni spesa da 100 euro al supermercato", tags: ["buoni_spesa"], score: 50, requiresPurchase: true },
      { title: "Vinci una cucina moderna", tags: ["casa"], score: 40, requiresPurchase: true },
    ]);
    return store;
  }

  it("il menù apre 🎁 Tipi di premio, con le cinque porte e i loro conteggi", async () => {
    const store = await archivio();
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    const menu = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(menu.find((b) => b.callback_data === "s:premi")?.text).toBe("🎁 Tipi di premio");

    await handleUpdate(tap(2, "s:premi", 100), deps(store, tg));
    const testo = String(lastWith(calls, "editMessageText")?.payload.text ?? "");
    expect(testo).toContain("Tipi di premio");
    expect(testo).toContain("Non sono filtri");

    // Un numero per porta, contato ADESSO: 1 per tipo, e 0 dove non c'è niente.
    const bottoni = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(bottoni.map((b) => b.text)).toEqual([
      "💳 Gift card (1)", "🚗 Auto e moto (1)", "✈️ Viaggi (1)", "🛒 Buoni spesa (1)", "🆓 Gratis (0)",
      "🔄 Aggiorna", "🏠 Menù",
    ]);
    // Quattro porte su cinque hanno un tag; 🆓 Gratis riapre la sezione che il
    // menù ha già, invece di duplicarla.
    expect(bottoni.map((b) => b.callback_data)).toEqual([
      "s:premi:giftcard", "s:premi:auto", "s:premi:viaggio", "s:premi:buoni_spesa", "s:gratis",
      "refresh", "home",
    ]);

    // Ogni porta legge la sua sezione: si apre l'elenco, non si resta sulla
    // schermata delle porte.
    await handleUpdate(tap(3, "s:premi:viaggio", 100), deps(store, tg));
    const elenco = lastWith(calls, "editMessageText")?.payload.text ?? "";
    expect(elenco).toContain("✈️ Viaggi");
    expect((await store.getUiState(CHAT))?.section).toBe("premi:viaggio");
  });

  it("una porta mostra solo quel tipo di premio, e nessun altro", async () => {
    const store = await archivio();
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:premi:giftcard", 100), deps(store, tg));

    const testo = String(lastWith(calls, "editMessageText")?.payload.text ?? "");
    expect(testo).toContain("1 concorso");
    const righe = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(righe.some((b) => b.text.includes("gift card da 500"))).toBe(true);
    // Il concorso con una casa in palio ha il punteggio più basso, ma non è per
    // quello che manca: la porta filtra sul TIPO, non sul punteggio.
    expect(righe.some((b) => b.text.includes("Fiat Panda"))).toBe(false);
    expect(righe.some((b) => b.text.includes("Sardegna"))).toBe(false);
    expect(righe.some((b) => b.text.includes("cucina moderna"))).toBe(false);
  });

  it("una porta rispetta i filtri della chat, e il suo numero lo dice", async () => {
    const store = createMemoryStore();
    // Stelle minime a 60: la gift card da 80 resta, quella da 40 no.
    await store.upsertPrefs(prefs({ filters: { ...defaultFilters(), minScore: 60 } }));
    await seed(store, [
      { title: "Gift card che vale", tags: ["giftcard"], score: 80 },
      { title: "Gift card mediocre", tags: ["giftcard"], score: 40 },
    ]);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:premi", 100), deps(store, tg));
    const porte = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    // Il numero sul bottone e l'elenco nascono dalla stessa query: 1, non 2.
    expect(porte.find((b) => b.callback_data === "s:premi:giftcard")?.text).toBe("💳 Gift card (1)");

    await handleUpdate(tap(3, "s:premi:giftcard", 100), deps(store, tg));
    const elenco = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(elenco.some((b) => b.text.includes("che vale"))).toBe(true);
    expect(elenco.some((b) => b.text.includes("mediocre"))).toBe(false);
  });

  it("non accende nessun filtro: è una porta, non un interruttore", async () => {
    const store = await archivio();
    const { tg } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:premi", 100), deps(store, tg));
    await handleUpdate(tap(3, "s:premi:auto", 100), deps(store, tg));

    // Nessun `cfg:` è stato toccato e i filtri sono ancora quelli di partenza.
    expect((await store.getPrefs(CHAT))?.filters).toEqual(defaultFilters());
    expect(activeFilterCount((await store.getPrefs(CHAT))!.filters)).toBe(0);
  });

  it("🆓 Gratis nella schermata delle porte è la sezione che c'è già", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await seed(store, [{ title: "Concorso gratis senza obbligo di acquisto", requiresPurchase: false }]);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:premi", 100), deps(store, tg));
    const porte = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(porte.find((b) => b.text === "🆓 Gratis (1)")?.callback_data).toBe("s:gratis");

    await handleUpdate(tap(3, "s:gratis", 100), deps(store, tg));
    const elenco = String(lastWith(calls, "editMessageText")?.payload.text ?? "");
    expect(elenco).toContain("Solo gratis (senza acquisto)");
    expect((await store.getUiState(CHAT))?.section).toBe("gratis");
  });
});

describe("diagnostica delle fonti · quali valgono e quali no", () => {
  /** Riga di fonte completa: i test ne toccano solo i campi che contano. */
  const fonte = (overrides: Partial<SourceRow> & Pick<SourceRow, "id" | "name">): SourceRow => ({
    kind: "rss",
    url: `https://${overrides.id}.example/feed`,
    category: "online",
    tags: ["aggregatore"],
    cadenceMin: 30,
    enabled: true,
    etag: null,
    lastModified: null,
    lastRunAt: "2026-11-20T09:00:00.000Z",
    lastOkAt: "2026-11-20T09:00:00.000Z",
    failStreak: 0,
    lastStatus: 200,
    lastError: null,
    lastItems: 25,
    ...overrides,
  });

  /** Una fonte rotta, una che porta solo catalogo scartato, una che lavora. */
  const treFonti = (store: MemoryStore): void => {
    store.seedSources([
      fonte({ id: "premieconcorsi", name: "Premi e Concorsi" }),
      fonte({
        id: "dimmicosacerchi",
        name: "DimmiCosaCerchi · concorsi a premi",
        failStreak: 3,
        lastStatus: 403,
        lastError: "HTTP 403",
        lastOkAt: "2026-11-18T09:00:00.000Z",
      }),
      fonte({ id: "sitemap-conad", name: "Conad · carte e premi", lastItems: 20 }),
    ]);
  };

  const guarda = async (store: MemoryStore): Promise<string> => {
    const { tg, calls } = makeTg();
    await handleUpdate(command(1, "/diagnostica"), deps(store, tg));
    return String(lastWith(calls, "sendMessage")?.payload.text ?? "");
  };

  it("dice chi fallisce, chi non porta concorsi e chi lavora", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    treFonti(store);
    await seed(store, [{ sourceId: "premieconcorsi", title: "Concorso Esselunga" }]);
    // Conad ha guardato una pagina e l'ha scartata: nessun concorso per prima.
    await store.recordSighting({
      urlKey: "key-scartata",
      sourceId: "sitemap-conad",
      itemId: null,
      kind: "contest",
      channel: "brand",
      seenAt: "2026-11-20T09:00:00.000Z",
      kept: false,
    });

    const testo = await guarda(store);
    expect(testo).toContain("Diagnostica delle fonti");
    expect(testo).toContain("<b>2</b> fonti da guardare su <b>3</b> accese");
    expect(testo).toContain("<b>Falliscono</b> (1)");
    expect(testo).toContain("<code>dimmicosacerchi</code>");
    expect(testo).toContain("3 giri di fila a vuoto");
    expect(testo).toContain("<b>Rispondono ma non portano concorsi</b> (1)");
    expect(testo).toContain("<code>sitemap-conad</code>");
    // Una sola pagina scartata: è un catalogo, non un elenco di concorsi.
    expect(testo).toContain("una pagina scartata e nessun concorso");
    // Le fonti che lavorano si contano, non si elencano una per una.
    expect(testo).toContain("Le altre <b>1</b> fonti portano concorsi nuovi");
    // E in fondo c'è come toglierle davvero, e come nasconderle solo a sé.
    expect(testo).toContain("sources.ts");
    expect(testo).toContain("Scegli le fonti");
    expect((await store.getUiState(CHAT))?.section).toBe("diagnostica");
  });

  it("ci si arriva da 📡 Fonti, e da lì si può spegnere una fonte solo per sé", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    treFonti(store);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:fonti", 100), deps(store, tg));
    // La schermata delle fonti porta alla domanda successiva.
    expect(lastKeyboard(calls)?.inline_keyboard.flat().map((b) => b.callback_data)).toContain("s:diagnostica");

    await handleUpdate(tap(3, "s:diagnostica", 100), deps(store, tg));
    expect(lastWith(calls, "editMessageText")?.payload.text).toContain("Diagnostica delle fonti");
    const porte = lastKeyboard(calls)?.inline_keyboard.flat().map((b) => b.callback_data) ?? [];
    expect(porte).toContain("s:filtri-fonti");
    expect(porte).toContain("s:fonti");

    // Da qui si spegne una fonte per sé: è la cosa che si può fare senza toccare
    // il codice, ed è quella che il bottone promette.
    await handleUpdate(tap(4, "s:filtri-fonti", 100), deps(store, tg));
    await handleUpdate(tap(5, "cfg:src:dimmicosacerchi", 100), deps(store, tg));
    expect((await store.getPrefs(CHAT))?.filters.mutedSources).toEqual(["dimmicosacerchi"]);
  });

  it("con tutte le fonti sane lo dice in una riga, senza elenchi", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    store.seedSources([fonte({ id: "premieconcorsi", name: "Premi e Concorsi" })]);
    await seed(store, [{ sourceId: "premieconcorsi", title: "Concorso Esselunga" }]);

    const testo = await guarda(store);
    expect(testo).toContain("Nessuna delle <b>1</b> fonti accese ha qualcosa che non va");
    expect(testo).not.toContain("Falliscono");
  });

  it("con più fonti da guardare di quante ne stiano, elenca comunque tutti gli id", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    // Ventidue fonti rotte: più di quelle che si raccontano per esteso in un
    // messaggio. Quello che non ci sta per esteso deve comunque comparire, perché
    // l'id è la parte su cui si agisce.
    store.seedSources(
      Array.from({ length: 22 }, (_, index) =>
        fonte({
          id: `rotta-${index + 1}`,
          name: `Fonte rotta numero ${index + 1} con un nome lungo`,
          failStreak: 3,
          lastStatus: 403,
          lastError: "HTTP 403",
        }),
      ),
    );

    const testo = await guarda(store);
    expect(testo).toContain("<b>Falliscono</b> (22)");
    expect(testo).toContain("… e altre 10:");
    // Tutte e ventidue, raccontate o no: è il punto della riga finale.
    for (let numero = 1; numero <= 22; numero++) {
      expect(testo).toContain(`<code>rotta-${numero}</code>`);
    }
    // E la schermata resta dentro il limite di Telegram: è un messaggio solo, che
    // si modifica sul posto, quindi non si può spezzare in due.
    expect(testo.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });
});

describe("📋 Oggi · il giorno di calendario", () => {
  it("non è una finestra di 24 ore: alle 01:00 non contiene più la giornata di ieri", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    // NOW = 20/11/2026 11:00 a Roma, quindi la mezzanotte italiana è le 23:00Z del
    // 19/11: il concorso arrivato alle 00:30 di oggi c'è, quello delle 23:30 di ieri
    // no. Con la finestra che scorreva ci sarebbero stati tutti e due.
    await seed(store, [
      { title: "Concorso di stanotte", firstSeenAt: "2026-11-19T23:30:00.000Z" },
      { title: "Concorso di ieri sera", firstSeenAt: "2026-11-19T22:30:00.000Z" },
    ]);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/oggi"), deps(store, tg));

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    // Gli item stanno nei bottoni (il messaggio è la testata + la spiegazione).
    const bottoni = etichette(calls);
    expect(testo).toContain("Oggi (dalle 00:00)");
    expect(testo).toContain("· 1 concorso");
    expect(bottoni).toContain("Concorso di stanotte");
    expect(bottoni).not.toContain("Concorso di ieri sera");
  });

  it("a notte fonda lo dice: vuota è la risposta giusta, non una sezione rotta", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    // Solo roba di ieri: alle 11:00 del 20/11 la sezione è piena, alle 01:00 di
    // oggi sarebbe vuota — ed è quello che deve spiegare, invece di rimandare a
    // 🔄 Aggiorna come se mancasse qualcosa.
    await seed(store, [{ title: "Concorso di ieri sera", firstSeenAt: "2026-11-19T22:30:00.000Z" }]);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/oggi"), deps(store, tg));

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("Oggi (dalle 00:00)");
    expect(testo).toContain("riparte da zero a mezzanotte");
    expect(testo).toContain("📅 7 giorni");
    expect(testo).not.toContain("Tocca 🔄 Aggiorna più tardi");
  });

  it("mezzanotte è quella italiana, e d'estate si sposta di un'ora", () => {
    // 20/11/2026 11:00 a Roma (CET, +1) → il giorno è cominciato alle 23:00Z del 19.
    expect(startOfLocalDay(NOW)).toBe("2026-11-19T23:00:00.000Z");
    // 1/7/2026 14:00 a Roma (CEST, +2) → mezzanotte italiana = 22:00Z del 30/6.
    expect(startOfLocalDay(new Date("2026-07-01T12:00:00.000Z"))).toBe("2026-06-30T22:00:00.000Z");
  });
});

describe("📚 Archivio · tutto quello che il bot ha visto", () => {
  /** Un concorso aperto, uno chiuso, un coupon scaduto e un articolo vecchio. */
  async function popolato(store: MemoryStore): Promise<void> {
    await seed(store, [
      { title: "Concorso aperto", status: "new", deadline: "2026-12-31" },
      { title: "Concorso chiuso", status: "expired", deadline: "2026-11-01" },
      { title: "Coupon scaduto", kind: "coupon", status: "expired", deadline: "2026-11-10" },
      { title: "Articolo vecchio", kind: "news", status: "expired", deadline: null },
    ]);
  }

  it("tiene anche chiusi e coupon scaduti, che dalle altre sezioni escono", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await popolato(store);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/archivio"), deps(store, tg));
    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    const bottoni = etichette(calls);
    expect(testo).toContain("📚 Archivio</b> · 4 item");
    expect(bottoni).toContain("Concorso aperto");
    expect(bottoni).toContain("Concorso chiuso");
    expect(bottoni).toContain("Coupon scaduto");
    expect(bottoni).toContain("Articolo vecchio");
    // E il segno che dice "non si partecipa più": senza, un concorso chiuso in
    // mezzo agli altri sembra una cosa da fare adesso.
    expect(bottoni).toContain("⛔");

    // La prova che serve a qualcosa: 💶 Coupon non lo mostra più.
    await handleUpdate(tap(2, "s:coupon", 100), deps(store, tg));
    const coupon = String(lastWith(calls, "editMessageText")?.payload.text ?? "");
    expect(coupon).toContain("Nessun coupon valido adesso");
    expect(coupon).toContain("📚 Archivio");
  });

  it("si restringe a un tipo senza toccare niente, e i filtri della chat qui non valgono", async () => {
    const store = createMemoryStore();
    // La fonte di tutti gli item del test è spenta per questa chat: negli elenchi
    // filtrati il concorso non compare, in archivio sì — altrimenti quello che
    // non trovi è proprio quello che stavi cercando.
    await store.upsertPrefs({ ...prefs(), filters: { ...defaultFilters(), mutedSources: ["premieconcorsi"] } });
    await popolato(store);
    const { tg, calls } = makeTg();

    await handleUpdate(tap(1, "s:archivio:coupon", 100), deps(store, tg));
    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    const bottoniFetta = etichette(calls);
    expect(testo).toContain("📚 Archivio · Coupon</b> · 1 item");
    expect(testo).toContain("qui non valgono");
    expect(bottoniFetta).toContain("Coupon scaduto");
    expect(bottoniFetta).not.toContain("Concorso chiuso");
    // La fetta attiva è segnata, come nelle altre schermate di scelta.
    const bottoni = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(bottoni.find((voce) => voce.callback_data === "s:archivio:coupon")?.text).toBe("• 💶 Coupon (1)");

    await handleUpdate(tap(2, "s:archivio", 100), deps(store, tg));
    expect(etichette(calls)).toContain("Concorso chiuso");

    // Una fetta inventata non è una sezione: non legge tutto per sbaglio.
    expect(parseCallback("s:archivio:pippo")).toEqual({ kind: "none" });
  });

  it("la ricerca guarda anche il passato, e dice che quello è chiuso", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await seed(store, [
      { title: "Buono sconto Caffè Vergnano", kind: "coupon", status: "expired", deadline: "2026-11-01" },
    ]);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/cerca"), deps(store, tg));
    await handleUpdate(command(2, "vergnano"), deps(store, tg));

    const bottoni = etichette(calls);
    expect(bottoni).toContain("Buono sconto Caffè Vergnano");
    // E il bottone dice che è chiuso: cercare non deve far sembrare aperto quello
    // che non lo è.
    expect(bottoni).toContain("⛔");
  });

  it("la porta sta in 🗂 Storico, con il numero di tutto quello che c'è", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await popolato(store);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/storico"), deps(store, tg));

    const bottoni = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    expect(bottoni.find((voce) => voce.callback_data === "s:archivio")?.text).toBe("📚 Archivio (4)");
    expect(String(lastWith(calls, "sendMessage")?.payload.text ?? "")).toContain("📚 <b>4</b> in archivio");
  });
});

describe("🧾 Log delle raccolte · la schermata dell'admin", () => {
  /** L'altra persona in chat: non è l'admin, quindi non vede il log. */
  const AMICA = 777;

  /**
   * Un tocco di un'ALTRA chat: `tap` scrive sempre CHAT, e qui la cosa da
   * verificare è proprio quello che NON arriva all'altra persona.
   */
  function tapDi(chatId: number, updateId: number, data: string, messageId: number): TelegramUpdate {
    return {
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        data,
        message: { message_id: messageId, chat: { id: chatId } },
        from: { id: chatId },
      },
    };
  }

  /** L'altra persona è autorizzata ma non è l'admin. */
  const conAmica = (store: MemoryStore, tg: TelegramClient) => ({
    store, tg, now: NOW, adminChatId: CHAT, allowedChatIds: [CHAT, AMICA],
  });

  /**
   * I bottoni dell'ultimo messaggio NUOVO. Serve perché `lastKeyboard` guarda
   * l'ultima modifica in assoluto: la schermata dell'altra persona è un messaggio
   * nuovo (non ha ancora una chat sua), e una modifica dell'admin la coprirebbe.
   */
  function bottoniInviati(calls: Call[]): string[] {
    const keyboard = lastWith(calls, "sendMessage")?.payload.reply_markup as InlineKeyboardMarkup | undefined;
    return keyboard?.inline_keyboard.flat().map((b) => b.callback_data ?? "") ?? [];
  }

  /**
   * Due raccolte raccontate e un tick in mezzo: tre righe in `runs`, ma solo due
   * log. Il tick c'è di proposito — è la riga che non deve comparire nella storia.
   */
  async function conDueLog(store: MemoryStore): Promise<void> {
    await store.recordRun({
      startedAt: "2026-11-20T09:30:00.000Z", trigger: "actions", sourcesOk: 3, sourcesFail: 1,
      itemsNew: 22, ms: 4000, note: "actions | 4 fonti",
      log: "🧪 <b>Raccolta su GitHub</b> · 10:30\n\n<b>Non hanno risposto</b>\n🔴 Tiscali · HTTP 403",
    });
    await store.recordRun({
      startedAt: "2026-11-20T09:45:00.000Z", trigger: NOTIFY_CRON, sourcesOk: 0, sourcesFail: 0,
      itemsNew: 0, ms: 30, note: "tick", log: null,
    });
    await store.recordRun({
      startedAt: "2026-11-20T10:30:00.000Z", trigger: "local", sourcesOk: 2, sourcesFail: 0,
      itemsNew: 1, ms: 900, note: "local | 2 fonti",
      log: "🧪 <b>Raccolta lanciata a mano</b> · 11:30\n🟢 Vincimi · HTTP 200 · 2 item",
    });
  }

  it("il bottone c'è per l'admin, e per l'altra persona non esiste", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const { tg, calls } = makeTg();
    await conDueLog(store);

    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:fonti", 100), deps(store, tg));
    expect(lastKeyboard(calls)?.inline_keyboard.flat().map((b) => b.callback_data)).toContain("s:log");

    // L'altra persona: stessa schermata, nessun 🧾 in tastiera.
    const amica = conAmica(store, tg);
    await handleUpdate(tapDi(AMICA, 3, "s:fonti", 200), amica);
    const porte = bottoniInviati(calls);
    expect(porte).not.toContain("s:log");
    // ...e le porte che le spettano restano: non è una schermata impoverita.
    expect(porte).toContain("s:diagnostica");

    // Il secondo cancello: un callback vecchio (o scritto a mano) non gliela apre
    // nemmeno, perché il gate non può essere solo il bottone che non c'è.
    await handleUpdate(tapDi(AMICA, 4, "s:log", 200), amica);
    expect((await store.getUiState(AMICA))?.section).toBe("menu");
    expect(lastWith(calls, "editMessageText")?.payload.text ?? "").not.toContain("Log delle raccolte");
  });

  it("mostra l'ultima raccolta per intero, e le frecce scorrono la storia", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    await conDueLog(store);
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(command(2, "/log"), deps(store, tg));
    expect((await store.getUiState(CHAT))?.section).toBe("log");

    const prima = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    // Il più recente per primo, con da dove viene e com'è finito.
    expect(prima).toContain("🧾 <b>Log delle raccolte</b> · 1/2");
    expect(prima).toContain("questo PC · 20/11 11:30 · 2 ok / 0 errori · 1 nuovi");
    expect(prima).toContain("Raccolta lanciata a mano");
    expect(prima).toContain("🟢 Vincimi · HTTP 200 · 2 item");
    // Il tick non è un lancio: due log, non tre esecuzioni.
    expect(prima).toContain("1/2");

    await handleUpdate(tap(3, "page:1", 100), deps(store, tg));
    const secondo = String(lastWith(calls, "editMessageText")?.payload.text ?? "");
    expect(secondo).toContain("🧾 <b>Log delle raccolte</b> · 2/2");
    expect(secondo).toContain("GitHub · 20/11 10:30 · 3 ok / 1 errori · 22 nuovi");
    expect(secondo).toContain("🔴 Tiscali · HTTP 403");
    expect((await store.getUiState(CHAT))?.page).toBe(1);
  });

  it("un log più lungo di un messaggio si taglia sulla coda, invece di non aprirsi", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    // Un giro con ottanta fonti dal nome lungo: il racconto non ci sta in un
    // messaggio, e questa schermata non si può spezzare in due (è lo stesso
    // messaggio che si modifica).
    const lungo = Array.from(
      { length: 80 },
      (_, index) => `🟢 Fonte numero ${index + 1} delle fonti di concorsi italiani · HTTP 200 · 12 item`,
    ).join("\n");
    await store.recordRun({
      startedAt: "2026-11-20T09:30:00.000Z", trigger: "actions", sourcesOk: 80, sourcesFail: 0,
      itemsNew: 400, ms: 60_000, note: "actions | 80 fonti", log: lungo,
    });
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/log"), deps(store, tg));

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    // La testa del log resta (i guasti stanno lì), la coda tagliata si vede.
    expect(testo).toContain("Fonte numero 1 ");
    expect(testo).toContain("…");
    expect(testo).not.toContain("Fonte numero 80");
  });

  it("senza nessuna raccolta raccontata lo dice, invece di mostrare il vuoto", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    // Solo tick del Worker: nessun log da leggere.
    await store.recordRun({
      startedAt: "2026-11-20T09:45:00.000Z", trigger: NOTIFY_CRON, sourcesOk: 0, sourcesFail: 0,
      itemsNew: 0, ms: 30, note: "tick", log: null,
    });
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/log"), deps(store, tg));

    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("Ancora nessun log");
    // Nessuna freccia: non c'è una storia da scorrere.
    expect(lastKeyboard(calls)?.inline_keyboard.flat().map((b) => b.callback_data)).not.toContain("page:1");
  });
});

describe("📊 punteggio trasparente · la scheda spiega il voto", () => {
  /** Il testo dell'ultima schermata, comunque sia stata mandata. */
  const ultimoTesto = (calls: Call[]): string =>
    String((lastWith(calls, "editMessageText") ?? lastWith(calls, "sendMessage"))?.payload.text ?? "");

  it("mostra le voci che hanno fatto il voto, non solo il numero", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const [id] = await seed(store, [{ score: 72 }]);
    const { tg, calls } = makeTg();

    await handleUpdate(tap(2, `open:${id}`, 100), deps(store, tg));

    const testo = ultimoTesto(calls);
    expect(testo).toContain("Come nasce il 72");
    // Le voci del corpo, coi loro massimi: sono quelle che spiegano un voto
    // basso ("premio 0/30" dice più di "20").
    expect(testo).toContain("🏆 Premio");
    expect(testo).toContain("/30");
    expect(testo).toContain("💪 Sforzo");
    expect(testo).toContain("⏳ Scadenza");
    expect(testo).toContain("🕐 Freschezza");
    expect(testo).toContain("🆓 Senza acquisto");
    // Con la soglia spenta lo dice: niente sta tagliando niente.
    expect(testo).toContain("Nessuna soglia accesa");
    // Il voto salvato e quello ricalcolato coi gusti di adesso possono divergere:
    // la scheda lo dichiara, perché il filtro usa il primo.
    expect(testo).toContain("Alla raccolta <b>72</b>");
    expect(testo).toContain("con i gusti di adesso");
  });

  it("con la soglia delle stelle dice quanti punti mancano, o di quanto la passa", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs({ filters: { ...defaultFilters(), minScore: 80 } }));
    const [sotto, sopra] = await seed(store, [
      { score: 72, title: "Concorso sotto soglia" },
      { score: 90, title: "Concorso sopra soglia" },
    ]);

    const { tg, calls } = makeTg();
    await handleUpdate(tap(2, `open:${sotto}`, 100), deps(store, tg));
    expect(ultimoTesto(calls)).toContain("Soglia <b>80</b>");
    expect(ultimoTesto(calls)).toContain("mancano <b>8</b> punti");

    const { tg: tg2, calls: calls2 } = makeTg();
    await handleUpdate(tap(3, `open:${sopra}`, 100), deps(store, tg2));
    expect(ultimoTesto(calls2)).toContain("la passa di <b>10</b> punti");
  });

  it("i gusti della chat entrano nella spiegazione, e si vedono", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs({ weights: { giftcard: 5 } }));
    const [id] = await seed(store, [{ score: 72 }]);
    const { tg, calls } = makeTg();

    await handleUpdate(tap(2, `open:${id}`, 100), deps(store, tg));

    // Cinque tocchi ✅ su gift card = +15 punti, e la voce lo dice: senza, la
    // differenza fra il voto salvato e quello di adesso sarebbe un mistero.
    expect(ultimoTesto(calls)).toContain("I tuoi gusti <b>+15</b>");
  });

  it("su un coupon non c'è nessun punteggio da spiegare", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const [id] = await seed(store, [{ kind: "coupon", title: "Buono sconto Novi" }]);
    const { tg, calls } = makeTg();

    await handleUpdate(tap(2, `open:${id}`, 100), deps(store, tg));

    const testo = ultimoTesto(calls);
    expect(testo).toContain("qui non si vince niente");
    expect(testo).not.toContain("Come nasce");
    expect(testo).not.toContain("Soglia");
  });
});

describe("testata del menù · quando ha raccolto il bot", () => {
  it("mostra l'ora della raccolta, non quella dell'ultimo tocco", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    // La raccolta vera è di ieri sera; il tick del Worker è di un minuto fa. La
    // testata deve dire la prima: un tick che consegna non è una raccolta, e
    // leggere la seconda come "aggiornato" è il malinteso da evitare.
    await store.recordRun({
      startedAt: "2026-11-19T20:09:00.000Z", trigger: "actions", sourcesOk: 31, sourcesFail: 1,
      itemsNew: 4, ms: 300_000, note: "actions", log: null,
    });
    await store.recordRun({
      startedAt: "2026-11-20T09:59:00.000Z", trigger: "*/15 * * * *", sourcesOk: 0, sourcesFail: 0,
      itemsNew: 0, ms: 30, note: "tick", log: null,
    });
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));

    const testo = String(lastWith(calls, "sendMessage")?.payload.text ?? "");
    expect(testo).toContain("Ultima raccolta: 19/11 21:09");
  });

  it("senza nessuna raccolta lo dice, invece di stampare una data inventata", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));

    expect(lastWith(calls, "sendMessage")?.payload.text).toContain("Nessuna raccolta ancora");
  });
});

describe("❓ Aiuto · la wiki", () => {
  it("si apre dal menù, una pagina alla volta, con le frecce che si fermano ai bordi", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const { tg, calls } = makeTg();

    // Il primo messaggio lo manda /start: da lì in poi la schermata è quella
    // sola che si modifica, e i tocchi sono editMessageText.
    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:aiuto", 100), deps(store, tg));

    expect(lastWith(calls, "editMessageText")?.payload.text).toContain("❓ <b>Aiuto · Come funziona</b>");
    const prima = lastKeyboard(calls)?.inline_keyboard.flat() ?? [];
    // All'inizio non c'è una pagina precedente, e la pagina è la prima.
    expect(prima.some((b) => b.callback_data === "page:0")).toBe(false);
    expect(prima.map((b) => b.callback_data)).toContain("page:1");

    await handleUpdate(tap(3, "page:1", 100), deps(store, tg));

    const seconda = String(lastWith(calls, "editMessageText")?.payload.text ?? "");
    expect(seconda).toContain("❓ <b>Aiuto · 🆕 Nuovi</b>");
    // Ogni pagina si spiega in poche righe: una wiki che si scorre non si legge.
    expect(seconda.split("\n").length).toBeLessThanOrEqual(8);
    expect(seconda).toContain("Pagina 2 di");
  });

  it("una pagina inventata non apre il vuoto", async () => {
    const store = createMemoryStore();
    await store.upsertPrefs(prefs());
    const { tg, calls } = makeTg();

    await handleUpdate(command(1, "/start"), deps(store, tg));
    await handleUpdate(tap(2, "s:aiuto:inventata", 100), deps(store, tg));

    // Il callback non è una sezione nota: nessuna pagina di aiuto si apre.
    const testo = String((lastWith(calls, "editMessageText") ?? lastWith(calls, "sendMessage"))?.payload.text ?? "");
    expect(testo).not.toContain("❓ <b>Aiuto");
  });
});
