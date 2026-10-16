import { chatAccess } from "../src/config/env.ts";
import { SOURCES, USER_AGENT } from "../src/config/sources.ts";
import { d1HttpOptionsFromEnv, createD1HttpStore } from "../src/db/d1-http.ts";
import { runIngest, type IngestSummary } from "../src/pipeline.ts";
import { TelegramClient } from "../src/telegram/api.ts";

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
 * ADMIN_CHAT_ID (o ALLOWED_CHAT_IDS) per l'avviso di fonte in errore.
 *
 * Uso locale:  npm run ingest
 */

/** Su Actions il freno di CPU va alzato: è l'unico motivo per cui non è il Worker. */
const ACTIONS_CPU_BUDGET_MS = 600_000;

function note(summary: IngestSummary): string {
  return [
    "actions",
    `${summary.sourcesDue} fonti`,
    `${summary.duplicates} duplicati`,
    `${summary.filtered} fuori tema`,
    ...summary.notes.slice(0, 3),
  ].join(" | ");
}

/** Riga di riepilogo nella pagina del job, quando ci sono le Actions. */
async function writeJobSummary(summary: IngestSummary): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const { appendFile } = process.getBuiltinModule("node:fs/promises") as typeof import("node:fs/promises");
  const lines = [
    "## Concorsi Radar — raccolta",
    "",
    `Fonti: **${summary.sourcesOk} ok**, ${summary.sourcesFail} in errore su ${summary.sourcesDue} · item nuovi: **${summary.itemsNew}**` +
      ` · duplicati: ${summary.duplicates} · fuori tema: ${summary.filtered} · rimandati: ${summary.deferred}`,
    "",
  ];
  if (summary.notes.length > 0) {
    lines.push("Note:", ...summary.notes.map((entry) => `- ${entry}`), "");
  }
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function alertDeadSources(summary: IngestSummary): Promise<number> {
  if (summary.deadSources.length === 0) return 0;
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const access = chatAccess({
    ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID ?? "",
    ALLOWED_CHAT_IDS: process.env.ALLOWED_CHAT_IDS ?? "",
  });
  const adminChatId = access.adminChatId;
  // Senza token o senza admin l'avviso si salta: la raccolta non deve fallire
  // per un problema di notifica (lo stato resta visibile in /fonti e /health).
  if (!token || adminChatId === null) return 0;

  const tg = new TelegramClient(token, (input, init) => fetch(input, init));
  let sent = 0;
  for (const sourceId of summary.deadSources) {
    const result = await tg.sendMessage(
      adminChatId,
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

  const summary = await runIngest(
    { store, fetcher: (input, init) => fetch(input, init), ai: null, userAgent: USER_AGENT },
    now,
    { allSources: true, maxSources: Math.max(enabled, 1), cpuBudgetMs: ACTIONS_CPU_BUDGET_MS },
  );
  const avvisi = await alertDeadSources(summary);

  await store.recordRun({
    startedAt: now.toISOString(),
    trigger: "actions",
    sourcesOk: summary.sourcesOk,
    sourcesFail: summary.sourcesFail,
    itemsNew: summary.itemsNew,
    ms: summary.ms,
    note: note(summary),
  });
  await writeJobSummary(summary);

  console.log(
    `Raccolta: ${summary.sourcesOk} ok / ${summary.sourcesFail} errori su ${summary.sourcesDue} fonti · ` +
      `${summary.itemsSeen} item letti, ${summary.itemsNew} nuovi, ${summary.duplicates} duplicati, ` +
      `${summary.filtered} fuori tema, ${summary.deferred} rimandati, ${summary.ms} ms`,
  );
  for (const nota of summary.notes) console.log(`  ! ${nota}`);
  if (avvisi > 0) console.log(`  → ${avvisi} avvisi di fonte in errore inviati all'admin`);

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
