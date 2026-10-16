import { SOURCES, USER_AGENT } from "../src/config/sources.ts";
import {
  SAFE_CPU_BUDGET_MS,
  benchDedupeLookup,
  benchSource,
  downloadBodies,
  summarise,
} from "../src/debug/bench.ts";
import { MAX_SOURCES_PER_RUN } from "../src/config/sources.ts";
import type { SourceRow } from "../src/types.ts";

/**
 * Quanto costa in CPU un'esecuzione del cron? Il limite del piano Free è 10 ms
 * per invocazione e riguarda solo il codice eseguito: le attese di rete non
 * contano, quindi si cronometrano solo le parti pure.
 *
 * Uso:  npm run bench:cpu [-- --fonti 6] [-- --runs 15]
 *
 * Il numero da guardare è TOTALE per invocazione (peggiore dei casi): se sfonda,
 * si abbassa MAX_SOURCES_PER_RUN in src/config/sources.ts invece di sperare.
 *
 * Nota: questo script gira su Node (stesso motore V8 di workerd, ma non è lo
 * stesso isolamento). La misura autorevole è la rotta /bench del Worker, che
 * gira dentro workerd.
 */

const args = process.argv.slice(2);
function numero(flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  const value = index >= 0 ? Number(args[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const quanteFonti = numero("--fonti", 6);
const runs = numero("--runs", 9);

function toRow(config: (typeof SOURCES)[number]): SourceRow {
  return {
    ...config, etag: null, lastModified: null, lastRunAt: null, lastOkAt: null, failStreak: 0,
    lastStatus: null, lastError: null, lastItems: 0,
  };
}

function ms(value: number): string {
  return `${value.toFixed(2).padStart(7)} ms`;
}

async function main(): Promise<void> {
  const abilitate = SOURCES.filter((config) => config.enabled).map(toRow);
  const scelte = abilitate.slice(0, quanteFonti);
  console.log(`Scarico ${scelte.length} fonti (fuori dalla misura)...`);
  const bodies = await downloadBodies(scelte, (input, init) => fetch(input, init), USER_AGENT);
  console.log(`Corpi scaricati: ${bodies.length} · runs per misura: ${runs}\n`);

  const results = [];
  for (const { source, body } of bodies) {
    const result = await benchSource(source, body, runs);
    results.push(result);
    console.log(
      `${result.sourceId.padEnd(28)} ${String(result.bytes).padStart(7)} B · ${String(result.items).padStart(3)} item · ` +
        `parse ${ms(result.stages[0]?.ms ?? 0)} · ${result.msPerItem.toFixed(3)} ms/item` +
        (result.error ? ` · ERRORE ${result.error}` : ""),
    );
  }

  console.log("\nDettaglio per fase (mediana su più esecuzioni):");
  for (const result of results) {
    for (const stage of result.stages) {
      console.log(`  ${result.sourceId.padEnd(28)} ${stage.stage.padEnd(28)} ${ms(stage.ms)}${stage.items ? ` (${stage.items} item)` : ""}`);
    }
  }

  const dedupe = await benchDedupeLookup(300, 20, runs);
  const report = summarise(results, dedupe, 300);

  console.log("\n=== PEGGIORE DEI CASI (fonti più care, tutti gli item nuovi) ===");
  console.log(`  fonti nel tick (regola del freno, tetto ${MAX_SOURCES_PER_RUN}): ${report.sourcesInInvocation} · item: ${report.itemsInInvocation}`);
  console.log(`  deduplica, CPU client per item (archivio 300): ${ms(report.dedupeClientMs)} · ${dedupe.candidates} candidati`);
  console.log(`  deduplica, lato archivio locale (emula la WHERE di D1, non è CPU): ${ms(report.dedupeStoreMs)}`);
  console.log(`  costo per item: ${report.perItemMs.toFixed(3)} ms · fonte più cara: ${ms(report.worstSourceMs)}`);
  console.log(`  TOTALE per invocazione: ${ms(report.invocationMs)}`);
  if (report.extraSourceId) {
    console.log(`  con una fonte in più (${report.extraSourceId}): ${ms(report.withExtraSourceMs)}`);
  }
  console.log(`  fonti piene che entrano nel budget di ${SAFE_CPU_BUDGET_MS} ms: ${report.sourcesFittingBudget}`);
  console.log(`\n${report.verdict}`);
  console.log(
    "\nAttenzione: la misura autorevole è la rotta /bench del Worker (workerd). " +
      "Qui su Node manca la contabilità CPU di Cloudflare (errori 1102, cold start).",
  );
}

main().catch((error) => {
  console.error("bench fallito:", error);
  process.exitCode = 1;
});
