import { chatAccess } from "../src/config/env.ts";
import { SOURCES, USER_AGENT } from "../src/config/sources.ts";
import { d1HttpOptionsFromEnv, createD1HttpStore } from "../src/db/d1-http.ts";
import { runIngest, type IngestSummary } from "../src/pipeline.ts";
import { TelegramClient } from "../src/telegram/api.ts";
import { INGEST_REPORT_MARK, INGEST_REPORT_SKIP, shouldReportIngest } from "../src/schedule.ts";
import { plainIngestLines, sendIngestReport, type IngestReport } from "../src/telegram/report.ts";

/**
 * Raccolta dei feed per GitHub Actions.
 *
 * Perché non nel Worker: la rete di Cloudflare viene bloccata da diverse fonti
 * italiane (403/503) mentre gli stessi URL, con la stessa User-Agent, rispondono
 * da un runner. Qui la pipeline è la stessa del Worker (`runIngest`) e cambia
 * solo il trasporto del database (`createD1HttpStore`, API HTTP di D1).
 *
 * Differenze volute rispetto al tick del Worker:
 *  - tutte le fonti abilitate in un colpo (`allSources`), perché Actions gira a
 *    cadenza fissa e la rotazione a slot le escluderebbe a turno per sempre;
 *  - nessun freno di CPU: su Actions non esiste il limite di 10 ms del piano
 *    Free, quindi il budget si alza di molto per non rimandare item buoni.
 *
 * Secret richiesti (variabili d'ambiente): CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_API_TOKEN, D1_DATABASE_ID. Facoltativi: TELEGRAM_BOT_TOKEN e
 * ADMIN_CHAT_ID (o ALLOWED_CHAT_IDS) per l'avviso di fonte in errore e per il
 * report delle prime raccolte — quello che dice chi ha risposto e chi no, con
 * l'ora e il codice HTTP, senza aprire la pagina del job (src/telegram/report.ts).
 *
 * Uso locale:  npm run ingest
 */

/** Su Actions il freno di CPU va alzato: è l'unico motivo per cui non è il Worker. */
const ACTIONS_CPU_BUDGET_MS = 600_000;
/**
 * Quanto tempo di parete può spendere la ricerca dei regolamenti in un giro su
 * Actions. Il default della pipeline (8 s) è tarato sul tick del Worker, che ha
 * un tempo massimo di esecuzione; qui quel muro non c'è e le pagine dei concorsi
 * sono decine, quindi il tetto vero resta il numero di ricerche per giro
 * (MAX_RULES_LOOKUPS_PER_RUN).
 */
const ACTIONS_RULES_LOOKUP_MS = 120_000;

function note(summary: IngestSummary, diagnostica: string): string {
  return [
    "actions",
    `${summary.sourcesDue} fonti`,
    `${summary.duplicates} duplicati`,
    `${summary.filtered} fuori tema`,
    `${summary.stale} non attivi`,
    // Il segno della diagnostica: dice al giro successivo se il report è già
    // stato mandato (vedi shouldReportIngest in src/schedule.ts).
    diagnostica,
    ...summary.notes.slice(0, 3),
  ].join(" | ");
}

/** Riga di riepilogo nella pagina del job, quando ci sono le Actions. */
async function writeJobSummary(summary: IngestSummary, report: IngestReport): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const { appendFile } = process.getBuiltinModule("node:fs/promises") as typeof import("node:fs/promises");
  const lines = [
    "## Concorsi Radar — raccolta",
    "",
    `Fonti: **${summary.sourcesOk} ok**, ${summary.sourcesFail} in errore su ${summary.sourcesDue} · item nuovi: **${summary.itemsNew}**` +
      ` · duplicati: ${summary.duplicates} · fuori tema: ${summary.filtered}` +
      ` · non attivi: ${summary.stale} · rimandati: ${summary.deferred}`,
    "",
    // Fonte per fonte, qui come in chat: è la stessa riga che l'admin riceve nei
    // primi giri, e serve a non doverla andare a cercare dentro il log.
    "Fonti di questo giro:",
    ...plainIngestLines(report),
    "",
  ];
  if (summary.notes.length > 0) {
    lines.push("Note:", ...summary.notes.map((entry) => `- ${entry}`), "");
  }
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Con chi parlare, se c'è con chi. Senza token o senza admin chat le notifiche si
 * saltano: la raccolta non deve fallire per un problema di notifica (lo stato
 * resta visibile in 📡 Fonti e in /health).
 */
function notifier(): { tg: TelegramClient; chatId: number } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const access = chatAccess({
    ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID ?? "",
    ALLOWED_CHAT_IDS: process.env.ALLOWED_CHAT_IDS ?? "",
  });
  const chatId = access.adminChatId;
  if (!token || chatId === null) return null;
  return { tg: new TelegramClient(token, (input, init) => fetch(input, init)), chatId };
}

async function alertDeadSources(summary: IngestSummary): Promise<number> {
  if (summary.deadSources.length === 0) return 0;
  const notifica = notifier();
  if (!notifica) return 0;
  let sent = 0;
  for (const sourceId of summary.deadSources) {
    const result = await notifica.tg.sendMessage(
      notifica.chatId,
      `⚠️ <b>Fonte in errore</b>: ${sourceId} ha fallito 3 volte di fila. Controlla /fonti.`,
    );
    if (result.ok) sent++;
  }
  return sent;
}

async function main(): Promise<void> {
  const now = new Date();
  const store = createD1HttpStore(d1HttpOptionsFromEnv(process.env));
  const enabled = SOURCES.filter((config) => config.enabled).length;
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";

  // Le esecuzioni precedenti si leggono PRIMA di registrare questa: servono a
  // sapere se il report fonte-per-fonte tocca a questo giro.
  const runs = await store.recentRuns(50);

  const summary = await runIngest(
    { store, fetcher: (input, init) => fetch(input, init), ai: null, userAgent: USER_AGENT },
    now,
    {
      allSources: true,
      maxSources: Math.max(enabled, 1),
      cpuBudgetMs: ACTIONS_CPU_BUDGET_MS,
      rulesLookupMs: ACTIONS_RULES_LOOKUP_MS,
    },
  );
  const avvisi = await alertDeadSources(summary);

  const manuale = eventName === "workflow_dispatch";
  const precedenti = runs.filter((run) => run.trigger === "actions").length;
  const report: IngestReport = {
    attempts: summary.attempts,
    itemsSeen: summary.itemsSeen,
    itemsNew: summary.itemsNew,
    deferred: summary.deferred,
    titolo: manuale
      ? "Raccolta lanciata a mano"
      : precedenti === 0 ? "Prima raccolta su GitHub" : "Raccolta su GitHub",
  };
  // Il report in chat vale per le prime raccolte e per quelle chieste a mano;
  // negli altri giri lo stato delle fonti si legge in 📡 Fonti, che non fa
  // rumore. Il segno va nella nota SOLO se il messaggio è partito davvero: se la
  // notifica fallisce, il giro dopo ci riprova invece di considerarlo fatto.
  let diagnostica = INGEST_REPORT_SKIP;
  if (shouldReportIngest(runs, eventName)) {
    const notifica = notifier();
    const inviato = notifica
      ? await sendIngestReport({ tg: notifica.tg, chatId: notifica.chatId, report })
      : false;
    diagnostica = inviato ? INGEST_REPORT_MARK : INGEST_REPORT_SKIP;
  }

  await store.recordRun({
    startedAt: now.toISOString(),
    trigger: "actions",
    sourcesOk: summary.sourcesOk,
    sourcesFail: summary.sourcesFail,
    itemsNew: summary.itemsNew,
    ms: summary.ms,
    note: note(summary, diagnostica),
  });
  await writeJobSummary(summary, report);

  console.log(
    `Raccolta: ${summary.sourcesOk} ok / ${summary.sourcesFail} errori su ${summary.sourcesDue} fonti · ` +
      `${summary.itemsSeen} item letti, ${summary.itemsNew} nuovi, ${summary.duplicates} duplicati, ` +
      `${summary.filtered} fuori tema, ${summary.stale} non attivi, ${summary.deferred} rimandati, ${summary.ms} ms`,
  );
  for (const nota of summary.notes) console.log(`  ! ${nota}`);
  if (avvisi > 0) console.log(`  → ${avvisi} avvisi di fonte in errore inviati all'admin`);
  if (diagnostica === INGEST_REPORT_MARK) console.log("  → report delle fonti inviato all'admin");

  // Se nessuna fonte ha risposto il job deve diventare rosso: è la spia che
  // qualcosa è cambiato (token scaduto, rete, API di D1) e va guardata subito.
  if (summary.sourcesDue > 0 && summary.sourcesOk === 0) {
    console.error("Nessuna fonte raccolta: controlla i log qui sopra.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Raccolta fallita:", error);
  process.exitCode = 1;
});
