import { pathToFileURL } from "node:url";
import type { FetchLike, IngestContext, ItemRow } from "../src/types.ts";
import type { Store } from "../src/db/store.ts";
import { USER_AGENT } from "../src/config/sources.ts";
import { createD1HttpStore, d1HttpOptionsFromEnv } from "../src/db/d1-http.ts";
import { robotsAllows } from "../src/ingest/index.ts";
import { regulationUrlFromPage, regulationUrlFromText } from "../src/enrich/regulation.ts";

/**
 * Riempie il regolamento (bando) dei concorsi già in archivio.
 *
 * Il bando lo cerca la raccolta, all'ingestione, sulla pagina del concorso
 * (src/enrich/regulation.ts) — ma solo per i concorsi NUOVI e al massimo per
 * MAX_RULES_LOOKUPS_PER_RUN pagine a giro. Due conseguenze, ed è per queste che
 * esiste questo comando:
 *  - l'archivio raccolto prima di questa funzione non ha nessun bando salvato, e
 *    una riga già in archivio non viene più riletta dalla pipeline;
 *  - in un giro con molti concorsi nuovi la coda resta senza, e il giro dopo non
 *    la ripesca (l'item è già dentro).
 *
 * Cerca con lo STESSO codice della raccolta — `regulationUrlFromText` e
 * `regulationUrlFromPage` — così non c'è una seconda definizione di "regolamento"
 * da tenere allineata, e rispetta robots.txt come la raccolta.
 *
 * Non tocca niente altro: né punteggi né date. Non sovrascrive un bando già
 * salvato (una riga che ce l'ha non è un candidato).
 *
 * Due passaggi, di proposito: prima l'elenco (prova a vuoto), poi la scrittura
 * con --apply. `--limite N` cambia quante pagine leggere al massimo (default 60).
 *
 * Secret richiesti (variabili d'ambiente): CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_API_TOKEN, D1_DATABASE_ID.
 *
 * Uso locale:  npm run rules                    (prova a vuoto: elenca e basta)
 *              npm run rules -- --apply         (scrive i bandi trovati)
 *              npm run rules -- --apply --limite 20
 */

/** Quanti item leggere per passata: è anche il tetto massimo di queryItems. */
export const RULES_PAGE_SIZE = 200;

/** Quante pagine leggere al massimo per esecuzione (--limite). */
export const DEFAULT_PAGE_LIMIT = 60;

/**
 * Gli stati in cui un concorso lo si sta ancora guardando. Un concorso chiuso o
 * scartato non merita una richiesta: il bando serve a chi partecipa, non
 * all'archivio.
 */
const STATI_ATTIVI: ItemRow["status"][] = ["new", "sent", "saved"];

/**
 * Selezione pura: quali righe hanno un bando da cercare. È esportata perché il
 * test la provi senza database e senza eseguire il comando.
 */
export function candidatesForRules(rows: ItemRow[]): ItemRow[] {
  return rows.filter(
    (row) => row.kind === "contest" && row.rulesUrl === null && STATI_ATTIVI.includes(row.status),
  );
}

/** Il bando già scritto nel testo dell'item: gratis, nessuna richiesta. */
export function textRuleFor(row: ItemRow): string | null {
  return regulationUrlFromText(`${row.summary} ${row.participation ?? ""}`, row.url);
}

interface Esito {
  row: ItemRow;
  /** URL trovato, o null se né il testo né la pagina lo nominano. */
  url: string | null;
  /** true se la pagina è stata davvero letta (i testi si leggono gratis). */
  letto: boolean;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limitIndex = process.argv.indexOf("--limite");
  const limite = limitIndex >= 0 ? Number.parseInt(process.argv[limitIndex + 1] ?? "", 10) : DEFAULT_PAGE_LIMIT;
  const pagine = Number.isFinite(limite) && limite > 0 ? Math.min(limite, RULES_PAGE_SIZE) : DEFAULT_PAGE_LIMIT;

  const store: Store = createD1HttpStore(d1HttpOptionsFromEnv(process.env));
  const fetcher: FetchLike = (input, init) => fetch(input, init);
  const now = new Date();
  const ctx: IngestContext = { fetcher, userAgent: USER_AGENT, now };

  // La query filtra in SQL (`rules_url IS NULL`), quindi la pagina letta è fatta
  // di candidati veri: niente giri a vuoto sull'archivio già riempito.
  const righe = await store.queryItems({
    kinds: ["contest"],
    withoutRules: true,
    statuses: STATI_ATTIVI,
    limit: RULES_PAGE_SIZE,
    orderBy: "first_seen",
  });
  const candidati = candidatesForRules(righe).slice(0, pagine);

  if (candidati.length === 0) {
    console.log("Nessun concorso senza regolamento: l'archivio è a posto.");
    return;
  }

  const esiti: Esito[] = [];
  for (const row of candidati) {
    const dalTesto = textRuleFor(row);
    if (dalTesto !== null) {
      esiti.push({ row, url: dalTesto, letto: false });
      continue;
    }
    const dallaPagina = await regulationUrlFromPage(row.url, {
      fetcher,
      userAgent: USER_AGENT,
      allows: (url) => robotsAllows(url, { store, fetcher, userAgent: USER_AGENT }, ctx, now),
      now,
    });
    esiti.push({ row, url: dallaPagina, letto: true });
  }

  const trovati = esiti.filter((esito) => esito.url !== null);
  console.log(`${candidati.length} concorsi senza regolamento (su ${righe.length} letti):`);
  console.log(`  ${trovati.length} hanno un bando (${trovati.filter((e) => !e.letto).length} già nel testo, senza richieste)`);
  for (const esito of trovati.slice(0, 20)) {
    console.log(`  · #${esito.row.id} ${esito.url} ${esito.letto ? "" : "(dal testo)"} — ${esito.row.title}`);
  }
  if (trovati.length > 20) console.log(`  … e altri ${trovati.length - 20}`);
  const mancanti = esiti.length - trovati.length;
  if (mancanti > 0) {
    console.log(`${mancanti} non nominano il bando da nessuna parte (nessun bottone, invece di un link inventato).`);
  }

  if (!apply) {
    console.log("\nProva a vuoto: non ho cambiato niente. Rilancia con --apply per scrivere.");
    return;
  }

  let scritte = 0;
  for (const esito of trovati) {
    await store.updateItem(esito.row.id, { rulesUrl: esito.url });
    scritte++;
  }
  console.log(`\nScritti ${scritte} regolamenti.`);
}

// Solo quando il file è il comando eseguito: importarlo da un test non scrive nulla.
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((error) => {
    console.error("Riempimento non riuscito:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
