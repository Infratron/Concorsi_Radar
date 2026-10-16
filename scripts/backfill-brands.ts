import { pathToFileURL } from "node:url";
import type { ItemRow } from "../src/types.ts";
import type { Store } from "../src/db/store.ts";
import { brandFor, brandLabel } from "../src/config/brands.ts";
import { createD1HttpStore, d1HttpOptionsFromEnv } from "../src/db/d1-http.ts";

/**
 * Riempie la marca dei concorsi già in archivio.
 *
 * Serve una volta per la migrazione (la colonna `brand` nasce vuota: vedi
 * src/db/schema.sql), e serve di nuovo ogni volta che il registro delle marche
 * impara una parola nuova: una marca aggiunta oggi non riconosce da sola le
 * righe raccolte ieri, perché il riconoscimento avviene all'ingestione.
 *
 * Il conto è lo STESSO dell'ingestione (brandFor, la funzione che usa
 * src/dedupe.ts): qui non c'è una seconda verità da tenere allineata.
 *
 * Non tocca i punteggi: il bonus della marca seguita si applica quando la chat
 * accende la marca (src/telegram/bot.ts, rescoreBrand), e prima di allora non
 * c'è nessun bonus da applicare.
 *
 * Due passaggi, di proposito: prima l'elenco (prova a vuoto), poi la scrittura
 * con --apply. Scrivere su tutto l'archivio è irreversibile, e un comando che
 * scrive per default è un comando che prima o poi scrive la cosa sbagliata.
 *
 * Secret richiesti (variabili d'ambiente): CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_API_TOKEN, D1_DATABASE_ID.
 *
 * Uso locale:  npm run brands             (prova a vuoto: elenca e basta)
 *              npm run brands -- --apply (scrive le marche)
 */

/** Quanti item leggere per passata: è anche il tetto massimo di queryItems. */
export const BRANDS_PAGE_SIZE = 200;

export interface BrandChange {
  id: number;
  title: string;
  /** Marca in archivio adesso (null = la colonna è ancora vuota). */
  from: string | null;
  /** Marca riconosciuta adesso. */
  to: string;
}

/**
 * Selezione pura: quali righe hanno una marca da scrivere. È esportata perché il
 * test la provi senza database e senza eseguire il comando.
 *
 * Solo le marche riconosciute si scrivono: una riga senza marca resta senza
 * (non si cancella niente), e una riga che ha già la stessa marca non si tocca.
 */
export function selectBrandChanges(rows: ItemRow[]): BrandChange[] {
  const changes: BrandChange[] = [];
  for (const row of rows) {
    const brand = brandFor({ sourceId: row.sourceId, title: row.title, summary: row.summary, url: row.url });
    if (brand === null || brand === row.brand) continue;
    changes.push({ id: row.id, title: row.title, from: row.brand, to: brand });
  }
  return changes;
}

/** Tutte le righe dell'archivio, una pagina per volta. */
async function allItems(store: Store): Promise<ItemRow[]> {
  const rows: ItemRow[] = [];
  for (let offset = 0; ; offset += BRANDS_PAGE_SIZE) {
    const pagina = await store.queryItems({ limit: BRANDS_PAGE_SIZE, offset, orderBy: "first_seen" });
    rows.push(...pagina);
    if (pagina.length < BRANDS_PAGE_SIZE) break;
  }
  return rows;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const store = createD1HttpStore(d1HttpOptionsFromEnv(process.env));

  const righe = await allItems(store);
  const changes = selectBrandChanges(righe);
  if (changes.length === 0) {
    console.log(`Nessuna marca da scrivere: le ${righe.length} righe in archivio sono a posto.`);
    return;
  }

  const perMarca = new Map<string, number>();
  for (const change of changes) perMarca.set(change.to, (perMarca.get(change.to) ?? 0) + 1);
  console.log(`${changes.length} righe su ${righe.length} hanno una marca da scrivere:`);
  for (const [brand, quanti] of [...perMarca].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${quanti} → ${brandLabel(brand)} (${brand})`);
  }
  for (const change of changes.slice(0, 20)) {
    console.log(`  · #${change.id} ${change.from ?? "—"} → ${change.to} · ${change.title}`);
  }
  if (changes.length > 20) console.log(`  … e altre ${changes.length - 20}`);
  const senzaMarca = righe.length - changes.length;
  if (senzaMarca > 0) console.log(`${senzaMarca} righe restano senza marca (non è riconoscibile).`);

  if (!apply) {
    console.log("\nProva a vuoto: non ho cambiato niente. Rilancia con --apply per scrivere.");
    return;
  }

  let scritte = 0;
  for (const change of changes) {
    await store.updateItem(change.id, { brand: change.to });
    scritte++;
  }
  console.log(`\nScritte ${scritte} marche.`);
}

// Solo quando il file è il comando eseguito: importarlo da un test non scrive nulla.
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((error) => {
    console.error("Riempimento non riuscito:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
