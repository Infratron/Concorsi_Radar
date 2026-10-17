import { pathToFileURL } from "node:url";
import type { Store } from "../src/db/store.ts";
import { createD1HttpStore } from "../src/db/d1-http.ts";
import { contentClassTagsFor } from "../src/enrich/rules.ts";
import type { ItemRow } from "../src/types.ts";
import { d1OptionsForLocalRun } from "./wrangler-auth.ts";

/**
 * Riempie i tag di contenuto delle righe già in archivio.
 *
 * Perché serve. I tag nascono all'ingestione (src/enrich/rules.ts), ma una riga
 * già in archivio non ripassa da lì: il percorso caldo dei duplicati salta
 * l'arricchimento quando la riga è completa, e una riga entrata ieri non viene
 * riletta oggi. Senza questo comando i due contenuti nuovi — 🎁 premio certo e
 * 🛍️ omaggio con acquisto — resterebbero vuoti finché non arrivano item nuovi,
 * e la porta mentirebbe dicendo 0.
 *
 * Misura del 17/10/2026 sull'archivio di produzione (252 item, 225 attivi):
 *  - premio certo: 25 item, 24 dalla fonte dedicata di Scontrino Felice;
 *  - omaggio con acquisto: 21 item, 20 dei quali sono anche premi certi, più una
 *    raccolta punti. Le altre fonti ne pubblicano uno ciascuna, o nessuno.
 * È il motivo per cui i tag sono due e le porte due: la seconda domanda ("che
 * cosa ricevo comprando?") non è la prima ("il premio è garantito?"), anche se
 * nei dati di oggi si sovrappongono quasi del tutto.
 *
 * Cosa fa: aggiunge i tag mancanti e nient'altro. Non tocca punteggi, date né
 * tag esistenti, e rilanciarlo non cambia niente (i tag mancanti sono zero).
 *
 * Due passaggi, di proposito: prima l'elenco (prova a vuoto), poi la scrittura
 * con --apply. `--limite N` cambia quante righe leggere (default 1000).
 *
 * Credenziali: le tre variabili d'ambiente oppure il login di wrangler
 * (scripts/wrangler-auth.ts), come `npm run ingest`.
 *
 * Uso locale:  npm run tags                 (prova a vuoto: elenca e basta)
 *              npm run tags -- --apply       (aggiunge i tag mancanti)
 */

/** Quante righe leggere in una passata. */
export const TAGS_PAGE_SIZE = 500;

export interface TagRow {
  title: string;
  summary: string;
  requiresPurchase: boolean;
  tags: string[];
}

/**
 * I tag di contenuto che mancano a una riga. È pura: il test la prova senza
 * database, e `--apply` scrive esattamente quello che ha stampato la prova.
 */
export function tagsToAdd(row: TagRow): string[] {
  const trovati = contentClassTagsFor(`${row.title}\n${row.summary}`, {
    tags: row.tags,
    requiresPurchase: row.requiresPurchase,
  });
  return trovati.filter((tag) => !row.tags.includes(tag));
}

async function readAll(store: Store, limit: number): Promise<ItemRow[]> {
  const rows: ItemRow[] = [];
  let offset = 0;
  while (rows.length < limit) {
    const pagina = await store.queryItems({
      kinds: ["contest"],
      limit: Math.min(TAGS_PAGE_SIZE, limit - rows.length),
      offset,
      orderBy: "first_seen",
    });
    rows.push(...pagina);
    if (pagina.length < Math.min(TAGS_PAGE_SIZE, limit - rows.length)) break;
    offset += pagina.length;
  }
  return rows;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limitIndex = process.argv.indexOf("--limite");
  const richieste = limitIndex >= 0 ? Number.parseInt(process.argv[limitIndex + 1] ?? "", 10) : 1000;
  const limite = Number.isFinite(richieste) && richieste > 0 ? richieste : 1000;

  const store = createD1HttpStore(await d1OptionsForLocalRun(process.env));
  const righe = await readAll(store, limite);

  const daScrivere: { row: ItemRow; tags: string[] }[] = [];
  const perTag = new Map<string, number>();
  const perFonte = new Map<string, Map<string, number>>();
  for (const row of righe) {
    const tags = tagsToAdd(row);
    if (tags.length === 0) continue;
    daScrivere.push({ row, tags });
    for (const tag of tags) {
      perTag.set(tag, (perTag.get(tag) ?? 0) + 1);
      const fonti = perFonte.get(tag) ?? new Map<string, number>();
      fonti.set(row.sourceId, (fonti.get(row.sourceId) ?? 0) + 1);
      perFonte.set(tag, fonti);
    }
  }

  console.log(`${righe.length} concorsi letti, ${daScrivere.length} hanno un tag da aggiungere.`);
  for (const [tag, quanti] of perTag) {
    const fonti = [...(perFonte.get(tag) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]);
    console.log(`  ${tag}: ${quanti} — ${fonti.map(([fonte, n]) => `${fonte} ${n}`).join(", ")}`);
  }
  for (const { row, tags } of daScrivere.slice(0, 20)) {
    console.log(`  · #${row.id} +${tags.join(", ")} — ${row.title}`);
  }
  if (daScrivere.length > 20) console.log(`  … e altri ${daScrivere.length - 20}`);

  if (daScrivere.length === 0) {
    console.log("Niente da fare: l'archivio ha già i tag di contenuto.");
    return;
  }
  if (!apply) {
    console.log("\nProva a vuoto: non ho cambiato niente. Rilancia con --apply per aggiungere i tag.");
    return;
  }

  for (const { row, tags } of daScrivere) {
    await store.updateItem(row.id, { tags: [...row.tags, ...tags] });
  }
  console.log(`\nAggiunti ${daScrivere.reduce((somma, entry) => somma + entry.tags.length, 0)} tag su ${daScrivere.length} concorsi.`);
}

// Solo quando il file è il comando eseguito: importarlo da un test non scrive nulla.
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((error) => {
    console.error("Riempimento dei tag non riuscito:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
