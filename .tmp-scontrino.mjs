// Sonda dal vivo su Scontrino Felice: solo le sue fonti, sitemap per PRIMA (è
// l'ordine che rovinava i titoli), due giri per vedere i duplicati.
import { SOURCES, USER_AGENT } from "./src/config/sources.ts";
import { createMemoryStore } from "./src/db/memory.ts";
import { ingestSource } from "./src/ingest/index.ts";
import { runIngest } from "./src/pipeline.ts";

const now = new Date();
const store = createMemoryStore();
const fonti = SOURCES.filter((s) => s.id.includes("scontrinofelice"))
  .sort((a, b) => Number(b.kind === "sitemap") - Number(a.kind === "sitemap"))
  .map((s) => ({ ...s, etag: null, lastModified: null, lastRunAt: null, lastOkAt: null, failStreak: 0 }));

console.log("ordine delle fonti:", fonti.map((s) => s.id).join(", "));
for (const source of fonti) {
  const result = await ingestSource(source, { store, fetcher: fetch, userAgent: USER_AGENT }, now);
  console.log(`\n=== ${source.id} (${source.kind}) http=${result.httpStatus} error=${result.error ?? "-"} item=${result.items.length} parse=${result.parseMs}ms`);
}

store.seedSources(fonti);
const opts = { allSources: true, maxSources: fonti.length, includeSynthesized: false, cpuBudgetMs: 30000 };

const primo = await runIngest({ store, ai: null, fetcher: fetch, userAgent: USER_AGENT }, now, opts);
console.log(`\n=== PRIMO GIRO: letti ${primo.itemsSeen}, nuovi ${primo.itemsNew}, duplicati ${primo.duplicates}, scartati ${primo.filtered + primo.stale}`);
for (const nota of primo.notes) console.log(`  ! ${nota}`);

const secondo = await runIngest({ store, ai: null, fetcher: fetch, userAgent: USER_AGENT }, new Date(now.getTime() + 1800000), opts);
console.log(`\n=== SECONDO GIRO: letti ${secondo.itemsSeen}, nuovi ${secondo.itemsNew}, duplicati ${secondo.duplicates}`);

const items = await store.queryItems({ limit: 200 });
const perUrl = new Map();
for (const item of items) perUrl.set(item.url, (perUrl.get(item.url) ?? 0) + 1);
console.log(`\n=== ARCHIVIO: ${items.length} righe, ${perUrl.size} URL distinti`);
const doppi = [...perUrl.entries()].filter(([, quante]) => quante > 1);
console.log(doppi.length === 0 ? "nessun URL ripetuto" : `URL ripetuti: ${JSON.stringify(doppi)}`);

const mozzi = items.filter((item) => item.title.length < 30);
console.log(`titoli corti (possibili slug): ${mozzi.length}`);
for (const item of mozzi) console.log(`   · ${item.title} → ${item.url}`);

const sezioni = new Map();
for (const item of items) {
  const sezione = new URL(item.url).pathname.split("/").filter(Boolean)[0] ?? "-";
  sezioni.set(sezione, (sezioni.get(sezione) ?? 0) + 1);
}
console.log("\nrighe per sezione:");
for (const [sezione, quante] of [...sezioni.entries()].sort((a, b) => b[1] - a[1])) console.log(`  /${sezione}/ → ${quante}`);
console.log("\nprimi 12 titoli:");
for (const item of items.slice(0, 12)) console.log(`  #${item.id} ${item.score} | ${item.title}`);
