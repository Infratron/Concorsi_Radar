import { chatAccess } from "../src/config/env.ts";
import { SOURCES, USER_AGENT } from "../src/config/sources.ts";
import { createD1HttpStore } from "../src/db/d1-http.ts";
import { runIngest, type IngestSummary } from "../src/pipeline.ts";
import { refreshFlyers } from "../src/volantini.ts";
import { TelegramClient } from "../src/telegram/api.ts";
import { isExternalTrigger } from "../src/schedule.ts";
import { d1OptionsForLocalRun } from "./wrangler-auth.ts";
import { ingestLog, plainIngestLines, type IngestReport } from "../src/telegram/report.ts";

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
 * Credenziali (variabili d'ambiente): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
 * (permesso D1:Edit), D1_DATABASE_ID. Facoltativi: TELEGRAM_BOT_TOKEN e
 * ADMIN_CHAT_ID (o ALLOWED_CHAT_IDS) per l'avviso di fonte in errore.
 *
 * In chat non arriva NESSUN riepilogo: il racconto fonte per fonte (chi ha
 * risposto, con che codice, quanti item) si salva come log dell'esecuzione
 * (`runs.log`) e si legge in 🧾 Log delle raccolte, che vede solo l'admin — così
 * un giro ogni mezz'ora non diventa rumore in chat
 * (src/telegram/report.ts, `ingestLog`).
 *
 * Uso locale:  npm run ingest
 *
 * Da un PC le credenziali si possono anche non dichiarare: se le variabili non
 * ci sono, la raccolta usa il login di wrangler già presente sulla macchina
 * (scripts/wrangler-auth.ts). Quella comodità vale per una raccolta a mano — il
 * token di wrangler scade in poche ore; per una raccolta periodica serve un
 * token API, che non scade.
 *
 * L'esecuzione si registra per quello che è: `actions` sotto GitHub,
 * `local` quando la lancia un PC. Il Worker usa questo nome per decidere se la
 * raccolta è viva (src/schedule.ts): non importa dove gira, importa che giri.
 */

/**
 * Chi sta eseguendo questa raccolta. La variabile è quella che GitHub imposta da
 * sé nei job: nessun altro ambiente la definisce, quindi non serve un flag da
 * passare a mano (e una raccolta a mano resta etichettata come tale invece di
 * fingere di essere il workflow).
 */
const TRIGGER = process.env.GITHUB_ACTIONS ? "actions" : "local";

/** Fuori dal Worker il freno di CPU va alzato: è l'unico motivo per cui non è il Worker. */
const EXTERNAL_CPU_BUDGET_MS = 600_000;
/**
 * Quanto tempo di parete può spendere la ricerca dei regolamenti in una raccolta
 * esterna. Il default della pipeline (8 s) è tarato sul tick del Worker, che ha
 * un tempo massimo di esecuzione; qui quel muro non c'è e le pagine dei concorsi
 * sono decine, quindi il tetto vero resta il numero di ricerche per giro
 * (MAX_RULES_LOOKUPS_PER_RUN).
 */
const EXTERNAL_RULES_LOOKUP_MS = 120_000;

function note(summary: IngestSummary): string {
  return [
    // La prima parola è l'esecutore, e si legge in 🕒 Ultime raccolte: "actions"
    // sotto GitHub, "local" per una raccolta lanciata da un PC (src/schedule.ts).
    TRIGGER,
    `${summary.sourcesDue} fonti`,
    `${summary.duplicates} duplicati`,
    `${summary.filtered} fuori tema`,
    `${summary.stale} non attivi`,
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
  const store = createD1HttpStore(await d1OptionsForLocalRun(process.env));
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
      cpuBudgetMs: EXTERNAL_CPU_BUDGET_MS,
      rulesLookupMs: EXTERNAL_RULES_LOOKUP_MS,
    },
  );
  const avvisi = await alertDeadSources(summary);
  // 📰 I volantini delle insegne di Lecce: una pagina per catena, al massimo ogni
  // dodici ore. Un guasto qui non deve far fallire la raccolta dei concorsi.
  const volantini = await refreshFlyers({ store, fetcher: (input, init) => fetch(input, init), userAgent: USER_AGENT }, now)
    .catch((error: unknown) => ({ checked: 0, changed: 0, failed: [`errore: ${error instanceof Error ? error.message : String(error)}`] }));
  if (volantini.checked > 0) {
    summary.notes.push(
      `volantini: ${volantini.checked} letti, ${volantini.changed} cambiati${volantini.failed.length > 0 ? `, non letti: ${volantini.failed.join(", ")}` : ""}`,
    );
  }

  const manuale = eventName === "workflow_dispatch";
  const precedenti = runs.filter((run) => isExternalTrigger(run.trigger)).length;
  const dove = TRIGGER === "actions" ? "su GitHub" : "da questo PC";
  const report: IngestReport = {
    attempts: summary.attempts,
    itemsSeen: summary.itemsSeen,
    itemsNew: summary.itemsNew,
    deferred: summary.deferred,
    titolo: manuale
      ? "Raccolta lanciata a mano"
      : precedenti === 0 ? `Prima raccolta ${dove}` : `Raccolta ${dove}`,
  };
  // Il racconto del giro si salva con l'esecuzione: in chat non parte niente, il
  // log si apre quando lo si vuole leggere (🧾 Log delle raccolte, solo admin).
  // `manuale` non serve più a decidere se mandare il report — non si manda mai —
  // ma il titolo del log dice comunque da dove viene questo giro.
  const log = ingestLog(report, summary.notes);

  await store.recordRun({
    startedAt: now.toISOString(),
    trigger: TRIGGER,
    sourcesOk: summary.sourcesOk,
    sourcesFail: summary.sourcesFail,
    itemsNew: summary.itemsNew,
    ms: summary.ms,
    note: note(summary),
    log,
  });
  await writeJobSummary(summary, report);

  console.log(
    `Raccolta: ${summary.sourcesOk} ok / ${summary.sourcesFail} errori su ${summary.sourcesDue} fonti · ` +
      `${summary.itemsSeen} item letti, ${summary.itemsNew} nuovi, ${summary.duplicates} duplicati, ` +
      `${summary.filtered} fuori tema, ${summary.stale} non attivi, ${summary.deferred} rimandati, ${summary.ms} ms`,
  );
  for (const nota of summary.notes) console.log(`  ! ${nota}`);
  if (avvisi > 0) console.log(`  → ${avvisi} avvisi di fonte in errore inviati all'admin`);
  console.log(log === null ? "  → nessun log (nessuna fonte provata)" : "  → log salvato: si legge in 🧾 Log delle raccolte");

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
