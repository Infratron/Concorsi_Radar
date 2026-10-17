import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SOURCES, USER_AGENT } from "../src/config/sources.ts";
import type { D1Like } from "../src/db/d1.ts";
import { createD1HttpBinding } from "../src/db/d1-http.ts";
import { createMemoryStore } from "../src/db/memory.ts";
import { ROBOTS_DENIED_REASON } from "../src/lib/robots.ts";
import { runIngest, type IngestSummary } from "../src/pipeline.ts";
import { esitoTentativo, esitoUltimoTentativo } from "../src/telegram/report.ts";
import { FALLBACK_INGEST_AFTER_MS, isExternalTrigger, runOrigin } from "../src/schedule.ts";
import type { ItemKind, RunRow, SourceConfig, SourceRow } from "../src/types.ts";
import { d1OptionsForLocalRun } from "./wrangler-auth.ts";

/**
 * La checklist di chiusura (README, "Checklist di chiusura") eseguita da un solo
 * comando.
 *
 * Perché esiste. Le quattro caselle del README sono quattro domande diverse — il
 * codice regge, la fonte parla, l'archivio lo conferma, la chat lo mostra — e
 * finora ognuna si apriva a mano, con tre comandi e quattro query SQL da
 * ricopiare. Il rischio non era dimenticarne una: era eseguirle in ordine
 * sbagliato (guardare D1 prima di aver lanciato la raccolta) e leggere un
 * risultato vecchio come se fosse la risposta.
 *
 * Cosa fa, nell'ordine del README:
 *  1. `npm run typecheck` e `npm test` (la suite intera: una categoria cambiata
 *     sposta righe da una sezione all'altra, e il test che se ne accorge spesso è
 *     in un file che non hai aperto);
 *  2. la prova dal vivo con i fetcher veri e robots.txt compreso, su un archivio
 *     in MEMORIA: nessuna scrittura, nessun messaggio. È la stessa selezione
 *     della raccolta esterna (`allSources`), non la rotazione a slot;
 *  3. D1 in produzione, in sola lettura: la riga della fonte (ultimo tentativo,
 *     fail_streak), i tipi degli item, il bilancio per tipo/stato e la nota
 *     lasciata dall'ultima raccolta;
 *  4. la chat, che nessuno script può guardare al posto tuo: la casella resta
 *     `[-]` con le due cose da confrontare.
 *
 * L'esito di ogni casella è il peggiore dei suoi controlli: `[ ]` se qualcosa non
 * torna, `[!]` se torna ma c'è una cosa da guardare, `[x]` se torna tutto, `[-]`
 * se da qui non si può sapere. Il comando esce 1 se c'è almeno un `[ ]` — così
 * può stare in una pipeline o in un controllo pre-deploy senza mentire.
 *
 * Uso:
 *   npm run checklist
 *   npm run checklist -- --fonte scontomaggio-coupon   (la fonte che hai toccato:
 *       la prova dal vivo legge solo lei, e D1 controlla anche i tipi dei suoi item)
 *   npm run checklist -- --senza-rete                  (solo codice e D1)
 *   npm run checklist -- --senza-test                  (salta typecheck e suite)
 *
 * Credenziali D1: le tre variabili d'ambiente oppure il login di wrangler già
 * presente sulla macchina (scripts/wrangler-auth.ts). È lo stesso percorso di
 * `npm run ingest`: se quello funziona, funziona anche questo.
 */

export type BoxState = "ok" | "fail" | "warn" | "todo";

export interface Check {
  state: BoxState;
  /** La riga del controllo, in una frase. */
  text: string;
  /** Righe rientrate sotto il controllo: misure, una per fonte, note. */
  details?: string[];
}

export interface Box {
  /** Numero e titolo, come nel README. */
  title: string;
  /** Calcolato dai controlli (vedi boxState), non deciso a mano. */
  state: BoxState;
  checks: Check[];
}

const MARK: Record<BoxState, string> = { ok: "[x]", fail: "[ ]", warn: "[!]", todo: "[-]" };

/**
 * Lo stato di una casella è il peggiore dei suoi controlli. `todo` viene prima di
 * `ok`: una casella con un controllo che da qui non si può fare non è "a posto",
 * è "a posto per la parte che ho potuto guardare".
 */
export function boxState(checks: Check[]): BoxState {
  const states = checks.map((check) => check.state);
  if (states.includes("fail")) return "fail";
  if (states.includes("warn")) return "warn";
  if (states.includes("todo")) return "todo";
  return "ok";
}

/** Le caselle come le legge chi lancia il comando: una per una, con i dettagli. */
export function renderBoxes(boxes: Box[]): string {
  const lines: string[] = [];
  for (const box of boxes) {
    lines.push(`${MARK[box.state]} ${box.title}`);
    for (const check of box.checks) {
      lines.push(`      ${MARK[check.state]} ${check.text}`);
      for (const detail of check.details ?? []) lines.push(`          ${detail}`);
    }
  }
  return lines.join("\n");
}

/** 1 se c'è almeno una casella che non torna, 0 altrimenti. */
export function exitCode(boxes: Box[]): number {
  return boxes.some((box) => box.state === "fail") ? 1 : 0;
}

/** La riga finale: quante caselle per esito, senza doverle contare a occhio. */
export function summaryLine(boxes: Box[]): string {
  const conta = (state: BoxState): number => boxes.filter((box) => box.state === state).length;
  const pezzi = [`${conta("ok")} a posto`, `${conta("warn")} da guardare`, `${conta("fail")} non tornano`];
  if (conta("todo") > 0) pezzi.push(`${conta("todo")} a mano`);
  return `Caselle: ${boxes.map((box) => MARK[box.state]).join(" ")} — ${pezzi.join(", ")}.`;
}

/**
 * I campi di `sources` che servono al giudizio sulla salute. È un sottoinsieme di
 * SourceRow: le righe di D1 arrivano in snake_case e questo è il punto in cui
 * diventano i nomi del progetto.
 */
export interface HealthRow {
  id: string;
  lastStatus: number | null;
  lastError: string | null;
  lastItems: number;
  failStreak: number;
  lastRunAt: string | null;
  lastOkAt: string | null;
}

/**
 * Una fonte è sana in due modi diversi (README): 200 con item, oppure 304 con
 * zero item — il feed non è cambiato, ed è lo stato di regime. Quello che non va
 * bene è un 4xx/5xx, un `fail_streak` sopra zero, o una fonte mai provata: gli
 * ultimi due non si vedono dal codice HTTP, ed è per questo che il controllo
 * legge la riga intera e non solo `last_status`.
 */
export function healthVerdict(row: HealthRow): Check {
  // Il vocabolario è lo stesso di 📡 Fonti: se questo comando dicesse "errore"
  // dove la chat dice 🟢, la checklist diventerebbe una seconda verità.
  const esito = esitoUltimoTentativo(row);
  if (row.failStreak > 0) {
    return {
      state: "fail",
      text: `${row.id}: ${row.failStreak} fallimenti di fila · ${esito.motivo}`,
      details: ["a tre fallimenti di fila arriva l'avviso in chat: guarda /fonti e il log della raccolta"],
    };
  }
  if (row.lastError === ROBOTS_DENIED_REASON) {
    // Il tentativo è tecnicamente riuscito, ma non ha risposto niente: è il
    // rispetto della regola, non un guasto (README, casella 2).
    return { state: "ok", text: `${row.id}: 🚫 ${ROBOTS_DENIED_REASON} (regola rispettata, fonte in elenco)` };
  }
  if (!esito.risposta) {
    return {
      state: "fail",
      text: `${row.id}: ${esito.motivo}`,
      details: ["un 4xx/5xx è un guasto da guardare: URL cambiato, pattern, oppure fonte che blocca la rete"],
    };
  }
  if (row.lastRunAt === null) {
    return { state: "warn", text: `${row.id}: mai provata (nessun tentativo in archivio)` };
  }
  // 200 con zero item è diverso da 304 con zero item: la prima ha risposto con
  // una pagina vuota, la seconda ha detto "non è cambiata". Solo la prima è
  // sospetta, e il numero da solo non le distingue.
  if (row.lastStatus === 200 && row.lastItems === 0) {
    return {
      state: "warn",
      text: `${row.id}: ha risposto ed è vuota (HTTP 200 · 0 item)`,
      details: ["se è una fonte nuova, guarda i motivi degli scarti nella prova dal vivo: può essere il pattern"],
    };
  }
  return { state: "ok", text: `${row.id}: ${esito.motivo} · fail_streak ${row.failStreak}` };
}

/**
 * Gli item sono nella sezione giusta? La prova è il TIPO, non il titolo: una
 * fonte dichiarata `coupon` che non produce nemmeno un coupon sta dicendo due
 * cose diverse di sé, e una fonte di concorsi che ne produce troppi sta
 * rubando righe a 💶 Coupon. Non è un fallimento secco: `news` è la risposta
 * giusta per i contenitori, e una fonte può essere legittimamente vuota di
 * coupon (SpesaBack pubblica la guida, non le offerte) — per questo `[!]`.
 */
export function kindVerdict(category: string, counts: Partial<Record<ItemKind, number>>): Check {
  const coupon = counts.coupon ?? 0;
  const contest = counts.contest ?? 0;
  const news = counts.news ?? 0;
  const totale = coupon + contest + news;
  const text = `coupon ${coupon} · contest ${contest} · news ${news}`;
  if (totale === 0) {
    return {
      state: "warn",
      text: `nessun item in archivio per questa fonte (${text})`,
      details: ["la prova dal vivo dice cosa ha letto: se legge item e qui non ne resta nessuno, il cancello li scarta"],
    };
  }
  if (category === "coupon" && coupon === 0) {
    return {
      state: "warn",
      text: `${text} — fonte di offerte senza coupon`,
      details: ["la categoria è dichiarata male, oppure il cancello scarta le offerte: i due casi si distinguono dalle note"],
    };
  }
  if (category !== "coupon" && coupon > 0) {
    return {
      state: "warn",
      text: `${text} — ${coupon} coupon da una fonte che non è di offerte`,
      details: [`category è "${category}": se la fonte pubblica offerte, dichiarala coupon`],
    };
  }
  return { state: "ok", text: `${text} — coerenti con category "${category}"` };
}

export function tempoFa(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "data illeggibile";
  const minuti = Math.max(0, Math.round((now.getTime() - at) / 60_000));
  if (minuti < 1) return "adesso";
  if (minuti < 60) return `${minuti} min fa`;
  const ore = Math.round(minuti / 60);
  if (ore < 48) return `${ore} ${ore === 1 ? "ora" : "ore"} fa`;
  return `${Math.round(ore / 24)} giorni fa`;
}

/**
 * L'ultima raccolta esterna ha lasciato la sua nota in `runs`? La soglia è
 * quella della raccolta di riserva (`FALLBACK_INGEST_AFTER_MS`): oltre due ore
 * di silenzio il Worker riprende a raccogliere da solo, e questo è il segnale
 * che il giro che stavi aspettando non è ancora passato.
 */
export function runVerdict(runs: RunRow[], now: Date): Check {
  const ultima = runs.find((run) => isExternalTrigger(run.trigger));
  if (ultima === undefined) {
    return {
      state: "warn",
      text: "nessuna raccolta esterna nelle ultime esecuzioni",
      details: ["lancia `npm run ingest`, oppure aspetta GitHub Actions: il tick del Worker non scrive questo log"],
    };
  }
  const eta = now.getTime() - Date.parse(ultima.startedAt);
  const quando = `${runOrigin(ultima.trigger)} · ${tempoFa(ultima.startedAt, now)}`;
  const nota = ultima.note === null ? "(nessuna nota)" : ultima.note;
  if (!Number.isFinite(eta) || eta > FALLBACK_INGEST_AFTER_MS) {
    return {
      state: "warn",
      text: `l'ultima raccolta esterna è vecchia: ${quando}`,
      details: [nota, "se hai appena cambiato la config, il giro che la conferma deve ancora partire"],
    };
  }
  return { state: "ok", text: `il giro ha lasciato la sua nota: ${quando}`, details: [nota] };
}

/** Una riga per tipo: `contest: new 12 · sent 60 · …`, nell'ordine delle sezioni. */
export function balanceLines(rows: { kind: string; status: string; n: number }[]): string[] {
  const ordine: string[] = ["contest", "coupon", "news"];
  const perKind = new Map<string, { status: string; n: number }[]>();
  for (const row of rows) {
    const elenco = perKind.get(row.kind) ?? [];
    elenco.push({ status: row.status, n: row.n });
    perKind.set(row.kind, elenco);
  }
  const kinds = [...ordine.filter((kind) => perKind.has(kind)), ...[...perKind.keys()].filter((kind) => !ordine.includes(kind)).sort()];
  return kinds.map((kind) => {
    const parti = (perKind.get(kind) ?? []).map((entry) => `${entry.status} ${entry.n}`);
    const totale = (perKind.get(kind) ?? []).reduce((somma, entry) => somma + entry.n, 0);
    return `${kind} (${totale}): ${parti.join(" · ")}`;
  });
}

// ---------------------------------------------------------------------------
// Esecuzione

interface RunResult {
  status: number | null;
  output: string;
  error: string | null;
}

/**
 * Comandi figli con l'output a schermo mentre girano: la suite non è muta.
 *
 * La riga intera passa dalla shell (su Windows `npm` è un `npm.cmd`, che senza
 * shell non si trova) e gli argomenti stanno dentro la stringa: nessun valore
 * arriva da fuori — sono i nomi fissi degli script di package.json.
 */
function run(commandLine: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(commandLine, { env: process.env, shell: true });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", (error) => resolve({ status: null, output, error: error.message }));
    child.on("close", (code) => resolve({ status: code, output, error: null }));
  });
}

function npmRun(script: string): Promise<RunResult> {
  return run(`${process.platform === "win32" ? "npm.cmd" : "npm"} run ${script}`);
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** I numeri della suite dalle righe di riepilogo di vitest. */
export function parseVitestSummary(output: string): { tests: number | null; failed: number | null; files: number | null } {
  const pulito = output.replace(ANSI, "");
  const tests = /^\s*Tests\s+(.+)$/m.exec(pulito)?.[1] ?? "";
  const files = /^\s*Test Files\s+(.+)$/m.exec(pulito)?.[1] ?? "";
  const numero = (re: RegExp, testo: string): number | null => {
    const trovato = re.exec(testo);
    return trovato === null ? null : Number(trovato[1]);
  };
  return {
    tests: numero(/(\d+)\s+passed/, tests),
    failed: numero(/(\d+)\s+failed/, tests) ?? (tests.length > 0 ? 0 : null),
    files: numero(/(\d+)\s+passed/, files),
  };
}

function toSourceRow(config: SourceConfig): SourceRow {
  return {
    ...config,
    etag: null,
    lastModified: null,
    lastRunAt: null,
    lastOkAt: null,
    failStreak: 0,
    lastStatus: null,
    lastError: null,
    lastItems: 0,
  };
}

async function quickBox(fonte: string | null): Promise<Box> {
  const checks: Check[] = [];

  const typecheck = await npmRun("typecheck");
  if (typecheck.status === 0) checks.push({ state: "ok", text: "typecheck (tsc --noEmit) — esce 0" });
  else {
    checks.push({
      state: "fail",
      text: `typecheck — esce ${typecheck.status ?? "senza codice"}${typecheck.error === null ? "" : ` (${typecheck.error})`}`,
      details: ["gli errori sono qui sopra: si correggono prima di guardare qualsiasi altra casella"],
    });
  }

  const suite = await npmRun("test");
  const numeri = parseVitestSummary(suite.output);
  const testi = [
    numeri.tests === null ? null : `${numeri.tests} test`,
    numeri.files === null ? null : `${numeri.files} file`,
    `${numeri.failed ?? "?"} falliti`,
  ].filter((entry): entry is string => entry !== null);
  if (suite.status === 0) {
    checks.push({ state: "ok", text: `suite intera — ${testi.join(" · ")}` });
  } else {
    checks.push({
      state: "fail",
      text: `suite intera — ${testi.join(" · ")} (esce ${suite.status ?? "senza codice"})`,
      details: ["la suite è intera apposta: una categoria o un pattern cambiati spostano righe anche fuori dai file che hai aperto"],
    });
  }

  if (fonte !== null) checks.push({ state: "ok", text: `fonte in esame: ${fonte}` });
  return { title: "1. Il codice regge", state: boxState(checks), checks };
}

async function liveBox(fonte: string | null): Promise<Box> {
  const abilitate = SOURCES.filter((config) => config.enabled && (fonte === null || config.id === fonte));
  if (abilitate.length === 0) {
    const check: Check = { state: "fail", text: `nessuna fonte abilitata da provare${fonte === null ? "" : ` (${fonte})`}` };
    return { title: "2. La fonte parla davvero", state: "fail", checks: [check] };
  }

  const store = createMemoryStore();
  store.seedSources(abilitate.map(toSourceRow));
  process.stdout.write(`\nLeggo ${abilitate.length} fonti con i fetcher veri (robots.txt compreso), su un archivio in memoria…\n`);

  let summary: IngestSummary;
  try {
    summary = await runIngest(
      { store, fetcher: (input, init) => fetch(input, init), ai: null, userAgent: USER_AGENT },
      new Date(),
      {
        allSources: true,
        maxSources: abilitate.length,
        // Fuori dal Worker il freno di CPU non ha senso: è un processo qualunque,
        // e la prova deve arrivare in fondo invece di rimandare metà delle fonti.
        includeSynthesized: false,
        cpuBudgetMs: 600_000,
        rulesLookupMs: 120_000,
      },
    );
  } catch (error) {
    const messaggio = error instanceof Error ? error.message : String(error);
    return {
      title: "2. La fonte parla davvero",
      state: "fail",
      checks: [{ state: "fail", text: `la prova dal vivo non è partita: ${messaggio}` }],
    };
  }

  const righe = summary.attempts.map((attempt) => {
    const esito = esitoTentativo(attempt);
    return `${esito.emoji} ${attempt.sourceId} · ${esito.motivo}`;
  });
  const guasti = summary.attempts.filter((attempt) => !attempt.robotsDenied && attempt.error !== null);
  const robots = summary.attempts.filter((attempt) => attempt.robotsDenied);

  const checks: Check[] = [];
  checks.push({
    state: guasti.length === 0 ? "ok" : "fail",
    text:
      `${abilitate.length} ${abilitate.length === 1 ? "fonte letta" : "fonti lette"} · ` +
      `${summary.itemsSeen} item, ${summary.itemsNew} nuovi, ${summary.filtered} fuori tema, ${summary.stale} non attivi, ` +
      `${guasti.length} in errore · ${summary.ms} ms`,
    details: righe,
  });
  if (guasti.length > 0) {
    checks[checks.length - 1]?.details?.push("un 4xx/5xx qui è un guasto: la fonte ha cambiato URL, oppure il pattern non trova più niente");
  }

  checks.push({
    // Un 🚫 non è un guasto: è la regola rispettata, e la fonte resta in elenco.
    state: "ok",
    text:
      robots.length === 0
        ? "robots.txt — nessuna fonte fermata dalla regola"
        : `robots.txt — ${robots.length} ${robots.length === 1 ? "fonte fermata" : "fonti fermate"} (rispetto della regola, non un guasto)`,
    details: robots.map((attempt) => `🚫 ${attempt.sourceId}: resta in elenco con quello stato`),
  });

  if (summary.notes.length > 0) {
    checks[0]?.details?.push(...summary.notes.map((nota) => `! ${nota}`));
  }

  checks.push({
    state: "todo",
    text: "cosa entra: lo dice solo l'occhio, non il conteggio",
    details: [
      "una sitemap con tutti gli scarti a \"nessun segnale di concorso\" ha il pattern troppo largo",
      "un feed con tutti gli scarti a \"offerta vecchia\" è un arretrato di mesi",
      "i 403 della rete di Cloudflare non si misurano da qui: questa prova gira sulla tua rete",
    ],
  });

  return { title: "2. La fonte parla davvero (prova dal vivo, senza scrivere niente)", state: boxState(checks), checks };
}

interface SourceDbRow {
  id: string;
  name: string;
  category: string;
  enabled: number;
  last_status: number | null;
  last_error: string | null;
  last_items: number;
  fail_streak: number;
  last_run_at: string | null;
  last_ok_at: string | null;
}

function healthRow(row: SourceDbRow): HealthRow {
  return {
    id: row.id,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastItems: row.last_items,
    failStreak: row.fail_streak,
    lastRunAt: row.last_run_at,
    lastOkAt: row.last_ok_at,
  };
}

async function all<T>(binding: D1Like, sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await binding.prepare(sql).bind(...params).all<T>();
  return result.results ?? [];
}

/** D1 in sola lettura: nessun insert, nessun update, nessun delete. */
async function archiveBox(fonte: string | null, now: Date): Promise<Box> {
  const titolo = "3. L'archivio lo conferma (D1, in produzione)";

  let binding: D1Like;
  try {
    binding = createD1HttpBinding(await d1OptionsForLocalRun(process.env));
  } catch (error) {
    const messaggio = error instanceof Error ? error.message : String(error);
    const check: Check = {
      state: "fail",
      text: `D1 non raggiungibile: ${messaggio}`,
      details: ["la casella 3 non si può chiudere senza archivio: la prova dal vivo (casella 2) non scrive niente"],
    };
    return { title: titolo, state: "fail", checks: [check] };
  }

  const checks: Check[] = [];

  let fonti: SourceDbRow[];
  try {
    fonti = await all<SourceDbRow>(
      binding,
      "select id, name, category, enabled, last_status, last_error, last_items, fail_streak, last_run_at, last_ok_at from sources " +
        (fonte === null ? "where enabled = 1 order by id" : "where id = ?"),
      ...(fonte === null ? [] : [fonte]),
    );
  } catch (error) {
    const messaggio = error instanceof Error ? error.message : String(error);
    const check: Check = { state: "fail", text: `D1 risponde ma la query sulle fonti è fallita: ${messaggio}` };
    return { title: titolo, state: "fail", checks: [check] };
  }

  const bilanci = await all<{ kind: string; status: string; n: number }>(
    binding,
    "select kind, status, count(*) as n from items group by kind, status",
  );
  const totaleItem = bilanci.reduce((somma, riga) => somma + riga.n, 0);

  checks.push({
    state: "ok",
    text:
      fonte === null
        ? `D1 risponde — ${fonti.length} ${fonti.length === 1 ? "fonte abilitata" : "fonti abilitate"}, ${totaleItem} item in archivio`
        : `D1 risponde — ${fonte}: ${fonti.length > 0 ? "riga trovata" : "nessuna riga"}, ${totaleItem} item in archivio`,
    details: ["in sola lettura: questo comando non scrive niente"],
  });

  if (fonte !== null) {
    if (fonti.length === 0) {
      checks.push({
        state: "fail",
        text: `${fonte} non è in D1`,
        details: ["lo stato in D1 comanda a runtime: senza una riga sua la fonte non esiste per il bot", "esegui `npm run db:seed`"],
      });
    } else {
      const riga = fonti[0];
      if (riga === undefined) throw new Error("riga della fonte sparita fra la query e la lettura");
      const salute = healthVerdict(healthRow(riga));
      // Una fonte disabilitata in D1 non viene raccolta: la riga può essere
      // perfettamente sana e il bot ignorarla lo stesso. È un "da guardare",
      // non un guasto — e non va nascosto sotto un [x].
      const spenta = riga.enabled === 0;
      checks.push({
        ...salute,
        state: spenta ? "warn" : salute.state,
        text: `la riga della fonte è sana? ${salute.text}${spenta ? " — ma è disabilitata in D1" : ""}`,
        details: [
          ...(salute.details ?? []),
          spenta ? "la fonte è DISABILITATA in D1: il bot non la raccoglie (config e archivio dicono cose diverse)" : "la fonte è abilitata",
          riga.last_run_at === null ? "nessun tentativo registrato" : `ultimo tentativo ${tempoFa(riga.last_run_at, now)}`,
        ],
      });

      const kinds = await all<{ kind: string; n: number }>(binding, "select kind, count(*) as n from items where source_id = ? group by kind", fonte);
      const conteggi: Partial<Record<ItemKind, number>> = {};
      for (const rigaKind of kinds) conteggi[rigaKind.kind as ItemKind] = rigaKind.n;
      const tipi = kindVerdict(riga.category, conteggi);
      checks.push({ ...tipi, text: `gli item sono nella sezione giusta? ${tipi.text}` });
    }
  } else {
    const guasti: Check[] = [];
    for (const riga of fonti) {
      const salute = healthVerdict(healthRow(riga));
      if (salute.state !== "ok") guasti.push(salute);
    }
    checks.push({
      state: guasti.some((check) => check.state === "fail") ? "fail" : guasti.length > 0 ? "warn" : "ok",
      text:
        guasti.length === 0
          ? `tutte le ${fonti.length} fonti abilitate sono sane`
          : `${guasti.length} ${guasti.length === 1 ? "fonte" : "fonti"} da guardare su ${fonti.length} abilitate`,
      // Solo le fonti che hanno qualcosa da dire: l'elenco completo sta in 📡 Fonti.
      details: guasti.map((check) => `${MARK[check.state]} ${check.text}`),
    });
    checks.push({
      state: "todo",
      text: "gli item sono nella sezione giusta? passa --fonte <id> per vedere i tipi di una fonte",
    });
  }

  checks.push({
    state: totaleItem > 0 ? "ok" : "warn",
    text: totaleItem > 0 ? "il bilancio per tipo/stato non si è spostato di lato" : "l'archivio è vuoto: nessun item da bilanciare",
    details: [
      ...balanceLines(bilanci),
      "se i coupon sono raddoppiati senza una fonte di coupon accesa, la classificazione sta rubando concorsi",
    ],
  });

  let runs: RunRow[] = [];
  try {
    const righe = await all<{ trigger: string; note: string | null; started_at: string; sources_ok: number; sources_fail: number; items_new: number; ms: number; log: string | null }>(
      binding,
      "select trigger, note, started_at, sources_ok, sources_fail, items_new, ms, log from runs order by started_at desc limit 5",
    );
    runs = righe.map((riga) => ({
      trigger: riga.trigger,
      note: riga.note,
      startedAt: riga.started_at,
      sourcesOk: riga.sources_ok,
      sourcesFail: riga.sources_fail,
      itemsNew: riga.items_new,
      ms: riga.ms,
      log: riga.log,
    }));
  } catch {
    // Se la tabella manca, la casella sulle fonti resta comunque leggibile: il
    // controllo che non si può fare diventa `[-]`, non un errore del comando.
  }
  checks.push(
    runs.length === 0
      ? { state: "warn", text: "nessuna esecuzione in runs: il giro non ha ancora lasciato la sua nota" }
      : runVerdict(runs, now),
  );

  return { title: titolo, state: boxState(checks), checks };
}

function chatBox(): Box {
  const check: Check = {
    state: "todo",
    text: "la sezione toccata si apre e conta quello che ti aspetti",
    details: [
      "apri il bot: /coupon per le offerte, 📡 Fonti per l'esito dell'ultimo tentativo di ogni fonte, 🌡 Diagnostica per quelle che rispondono senza portare niente",
      "un numero che non corrisponde all'elenco è un filtro applicato a una sola delle due query: sezione e contatore devono nascere dalla stessa query",
    ],
  };
  return { title: "4. La chat lo mostra", state: boxState([check]), checks: [check] };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fonteIndex = args.indexOf("--fonte");
  const fonte = fonteIndex >= 0 ? (args[fonteIndex + 1] ?? null) : null;
  const senzaTest = args.includes("--senza-test");
  const senzaRete = args.includes("--senza-rete");
  const now = new Date();

  if (fonte !== null) {
    const config = SOURCES.find((entry) => entry.id === fonte);
    if (config === undefined) {
      console.error(`Fonte sconosciuta: ${fonte}. Gli id stanno in src/config/sources.ts.`);
      process.exitCode = 1;
      return;
    }
    if (!config.enabled) {
      console.error(`La fonte ${fonte} è dichiarata enabled: false in src/config/sources.ts: non viene raccolta.`);
      process.exitCode = 1;
      return;
    }
  }

  console.log("Concorsi Radar · checklist di chiusura");
  console.log("=====================================");
  console.log("Le stesse caselle del README, una per una. Nessuna scrittura: la prova dal vivo usa un archivio");
  console.log("in memoria, D1 si legge soltanto.");
  console.log("");
  console.log("[x] torna · [!] torna, ma c'è da guardare · [ ] non torna · [-] da fare a mano");
  console.log("");

  const boxes: Box[] = [];

  const codice = senzaTest
    ? { title: "1. Il codice regge", state: "todo" as BoxState, checks: [{ state: "todo" as BoxState, text: "saltata (--senza-test)" }] }
    : await quickBox(fonte);
  boxes.push(codice);
  console.log(renderBoxes([codice]));
  console.log("");

  if (senzaRete) {
    const saltata: Box = {
      title: "2. La fonte parla davvero (prova dal vivo, senza scrivere niente)",
      state: "todo",
      checks: [{ state: "todo", text: "saltata (--senza-rete): la fonte non è stata provata dal vivo" }],
    };
    boxes.push(saltata);
    console.log(renderBoxes([saltata]));
    console.log("");
  } else {
    const vivo = await liveBox(fonte);
    boxes.push(vivo);
    console.log(renderBoxes([vivo]));
    console.log("");
  }

  const archivio = await archiveBox(fonte, now);
  boxes.push(archivio);
  console.log(renderBoxes([archivio]));
  console.log("");

  const chat = chatBox();
  boxes.push(chat);
  console.log(renderBoxes([chat]));
  console.log("");

  console.log(summaryLine(boxes));
  if (fonte === null) console.log("Per la casella 3 di una fonte sola: npm run checklist -- --fonte <id>");
  process.exitCode = exitCode(boxes);
}

// Solo quando il file è il comando eseguito: importarlo da un test non deve
// lanciare typecheck, suite, rete e query su D1.
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((error) => {
    console.error("Checklist non riuscita:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
