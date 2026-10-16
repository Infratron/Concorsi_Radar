import { SOURCES, USER_AGENT } from "../src/config/sources.ts";
import { createMemoryStore } from "../src/db/memory.ts";
import { dueSources, runIngest } from "../src/pipeline.ts";
import { formatDigest, formatItemCard } from "../src/telegram/format.ts";
import { DIGEST_MAX_ITEMS } from "../src/telegram/digest.ts";
import type { SourceRow, ItemRow } from "../src/types.ts";

/**
 * Prova generale senza inviare nulla: scarica le fonti vere, applica
 * deduplica, arricchimento e punteggio, e stampa esattamente i messaggi che
 * il bot manderebbe. Nessun token, nessun messaggio reale.
 *
 * Uso:  npm run dry-run              (tutte le fonti abilitate, una esecuzione)
 *       npm run dry-run -- --fonti 5 (limita il numero di fonti)
 */

const args = process.argv.slice(2);
const fontiIndex = args.indexOf("--fonti");
const maxSources = fontiIndex >= 0 ? Number(args[fontiIndex + 1]) : 4;

function toSourceRow(config: (typeof SOURCES)[number]): SourceRow {
  return { ...config, etag: null, lastModified: null, lastRunAt: null, lastOkAt: null, failStreak: 0 };
}

function itemsForDigest(items: ItemRow[], now: Date): ItemRow[] {
  const scadenza = items.filter((item) => {
    if (!item.deadline) return false;
    const days = (Date.parse(`${item.deadline}T00:00:00Z`) - now.getTime()) / 86_400_000;
    return days >= 0 && days <= 7;
  });
  const alto = items.filter((item) => item.score >= 70 && !scadenza.includes(item));
  const altri = items.filter((item) => !scadenza.includes(item) && !alto.includes(item));
  return [...scadenza, ...alto, ...altri].slice(0, DIGEST_MAX_ITEMS);
}

async function main(): Promise<void> {
  const now = new Date();
  const store = createMemoryStore();
  const abilitate = SOURCES.filter((config) => config.enabled).map(toSourceRow);
  store.seedSources(abilitate);

  const limite = Number.isFinite(maxSources) ? maxSources : 4;
  const due = dueSources(abilitate, now, limite);
  console.log(`Fonti abilitate: ${abilitate.length} · fonti in questa esecuzione: ${due.length}`);
  for (const item of due) console.log(`  - ${item.name} (${item.kind})`);

  const summary = await runIngest(
    {
      store,
      fetcher: (input, init) => fetch(input, init),
      ai: null,
      userAgent: USER_AGENT,
    },
    now,
    // Stesso tetto usato qui sopra: altrimenti la lista mostrata non è quella letta.
    { maxSources: limite },
  );

  console.log(
    `\nEsito: ${summary.sourcesOk} fonti ok, ${summary.sourcesFail} in errore, ` +
      `${summary.itemsSeen} item letti, ${summary.itemsNew} nuovi, ${summary.duplicates} duplicati, ` +
      `${summary.filtered} fuori tema, ${summary.ms} ms`,
  );
  for (const nota of summary.notes) console.log(`  ! ${nota}`);

  const archivio = await store.queryItems({ limit: 200, orderBy: "score" });
  // Il bot tiene separate le due cose: i concorsi su cui si partecipa e gli
  // articoli che ne parlano. La prova generale deve mostrare la stessa
  // divisione, altrimenti non è una prova generale.
  const items = archivio.filter((item) => item.kind === "contest");
  const news = archivio.filter((item) => item.kind === "news");
  console.log(`\nArchivio di questa esecuzione: ${items.length} concorsi, ${news.length} news.`);
  for (const articolo of news) console.log(`  📰 ${articolo.title} → ${articolo.url}`);
  if (items.length === 0) {
    console.log("\nNessun concorso nuovo da mostrare.");
    return;
  }

  console.log("\n================ AVVISO ISTANTANEO (esempio, non inviato) ================");
  const istantaneo = items.find((item) => item.score >= 80);
  console.log(
    istantaneo
      ? formatItemCard(istantaneo, now)
      : "(nessun item sopra la soglia istantanea 80 in questa esecuzione)",
  );

  console.log("\n================ DIGEST (esempio, non inviato) ================");
  const selezionati = itemsForDigest(items, now);
  const scadenza = selezionati.filter((item) => {
    if (!item.deadline) return false;
    const days = (Date.parse(`${item.deadline}T00:00:00Z`) - now.getTime()) / 86_400_000;
    return days >= 0 && days <= 7;
  });
  const alto = selezionati.filter((item) => item.score >= 70 && !scadenza.includes(item));
  const altri = selezionati.filter((item) => !scadenza.includes(item) && !alto.includes(item));
  const messaggi = formatDigest(
    [
      { title: "⏳ In scadenza", items: scadenza },
      { title: "🔥 Alto valore", items: alto },
      { title: "📋 Altri", items: altri },
    ],
    now,
    items.length > selezionati.length ? [`…e altri ${items.length - selezionati.length} su /oggi`] : [],
  );
  console.log(messaggi.join("\n\n----- messaggio successivo -----\n\n"));
  console.log(`\n(${items.length} concorsi in archivio, ${selezionati.length} nel digest)`);
}

main().catch((error) => {
  console.error("dry-run fallito:", error);
  process.exitCode = 1;
});
