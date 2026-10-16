import { pathToFileURL } from "node:url";
import type { ItemRow } from "../src/types.ts";
import type { Store } from "../src/db/store.ts";
import { createD1HttpStore, d1HttpOptionsFromEnv } from "../src/db/d1-http.ts";
import { indexPageUrls, staleItemReason } from "../src/enrich/freshness.ts";

/**
 * Pulizia dell'archivio dai non-concorsi.
 *
 * Il cancello di "concorso ancora attivo" (src/enrich/freshness.ts) impedisce che
 * le pagine di catalogo e le promozioni chiuse entrino adesso, e il digest non le
 * manda più. Questo comando serve alla parte che il cancello non può fare da solo:
 * togliere dall'archivio quello che era già entrato prima, quando le fonti di
 * elenco venivano prese così com'erano (il caso reale: le pagine di tazze e borse
 * della sitemap Conad e una promo del 2024).
 *
 * Guarda SOLO gli item senza scadenza: uno con una scadenza è un concorso aperto,
 * e non si tocca. Per il resto decide lo stesso cancello della raccolta, quindi
 * qui non c'è una seconda verità da tenere allineata.
 *
 * Due passaggi, di proposito: prima l'elenco (prova a vuoto), poi la
 * cancellazione con --apply. Cancellare è irreversibile, e un comando che cancella
 * per default è un comando che prima o poi cancella la cosa sbagliata.
 *
 * Secret richiesti (variabili d'ambiente): CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_API_TOKEN, D1_DATABASE_ID.
 *
 * Uso locale:  npm run prune             (prova a vuoto: elenca e basta)
 *              npm run prune -- --apply (cancella davvero)
 */

/** Quanti item leggere per passata: è anche il tetto massimo di queryItems. */
export const PRUNE_PAGE_SIZE = 200;

export interface StaleRow {
  row: ItemRow;
  /** Motivo leggibile, lo stesso che finisce nelle note della raccolta. */
  reason: string;
}

/**
 * Selezione pura: quali righe non sono concorsi attivi. È esportata perché il
 * test la provi senza toccare il database e senza eseguire il comando.
 */
export function selectStale(rows: ItemRow[], now: Date): StaleRow[] {
  const stale: StaleRow[] = [];
  for (const row of rows) {
    const reason = staleItemReason(row, now);
    if (reason !== null) stale.push({ row, reason });
  }
  return stale;
}

/**
 * Candidati veri dell'archivio: solo gli item senza scadenza, che sono l'unica
 * categoria in cui il cancello ha qualcosa da dire (una scadenza futura è la
 * prova che il concorso è aperto).
 */
export async function findStale(store: Store, now: Date, pageSize = PRUNE_PAGE_SIZE): Promise<StaleRow[]> {
  const rows = await store.queryItems({ withoutDeadline: true, limit: pageSize, orderBy: "first_seen" });
  const stale = selectStale(rows, now);

  // Pagine indice: nel giro di raccolta si riconosce una pagina che è la cartella
  // di altre pagine raccolte, e la stessa prova si può rifare qui sull'archivio —
  // è così che la pagina di sezione "Collezioni E Concorsi" viene via anche se il
  // suo nome contiene la parola concorsi.
  const gia = new Set(stale.map((entry) => entry.row.id));
  const indice = indexPageUrls(rows.map((row) => row.url));
  for (const row of rows) {
    if (indice.has(row.url) && !gia.has(row.id)) stale.push({ row, reason: "pagina indice" });
  }
  return stale;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const now = new Date();
  const store = createD1HttpStore(d1HttpOptionsFromEnv(process.env));

  const stale = await findStale(store, now);
  if (stale.length === 0) {
    console.log("Archivio pulito: nessun item da togliere.");
    return;
  }

  console.log(`${stale.length} item in archivio non sono concorsi attivi:`);
  for (const { row, reason } of stale) {
    console.log(`  ✗ [${reason}] #${row.id} ${row.title} — ${row.url}`);
  }

  if (!apply) {
    console.log("\nProva a vuoto: non ho cambiato niente. Rilancia con --apply per cancellarli.");
    return;
  }

  const deleted = await store.deleteItems(stale.map((entry) => entry.row.id));
  console.log(`\nCancellati ${deleted} item, con le loro consegne per chat.`);
}

// Solo quando il file è il comando eseguito: importarlo da un test non cancella nulla.
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((error) => {
    console.error("Pulizia non riuscita:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
