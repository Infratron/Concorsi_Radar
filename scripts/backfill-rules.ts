import { pathToFileURL } from "node:url";
import type { FetchLike, IngestContext, ItemRow } from "../src/types.ts";
import type { Store } from "../src/db/store.ts";
import { USER_AGENT } from "../src/config/sources.ts";
import { createD1HttpStore } from "../src/db/d1-http.ts";
import { robotsAllows } from "../src/ingest/index.ts";
import { contestPageFacts, regulationUrlFromText } from "../src/enrich/regulation.ts";
import { mergePageDeadline } from "../src/enrich/rules.ts";
import { rescoreRow } from "../src/enrich/score.ts";
import { mergedBrands, mergedWeights } from "../src/pipeline.ts";
import { d1OptionsForLocalRun } from "./wrangler-auth.ts";

/**
 * Riempie il regolamento (bando) e la scadenza dei concorsi già in archivio.
 *
 * La scadenza si aggiunge dal 19/10/2026: la pagina del concorso la scrive quasi
 * sempre (103 dei 128 concorsi attivi che non l'avevano), e la riga "Scadenza :"
 * di Scontrino Felice corregge le date d'inizio scambiate per scadenze (Bennet
 * Guzzini risultava aperto fino al 2027, chiudeva il 7 ottobre).
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
 * Non sovrascrive un bando già salvato e non cancella mai una scadenza; il
 * punteggio si rifà solo dove la scadenza cambia (l'urgenza dipende da lei).
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
  /** Bando trovato (null = né il testo né la pagina lo nominano). */
  url: string | null;
  /** La scadenza dopo la lettura: uguale a prima, aggiunta o corretta. */
  deadline: string | null;
  /** true se la pagina è stata davvero letta (i testi si leggono gratis). */
  letto: boolean;
}

/**
 * Cosa cambiare su una riga dopo aver letto la sua pagina. Pura, per i test: la
 * regola della scadenza è quella della raccolta (`mergePageDeadline`), quindi la
 * riga "Scadenza :" del sito corregge, il resto riempie un vuoto, e niente si
 * cancella.
 */
export function patchFor(
  row: ItemRow,
  page: { rulesUrl: string | null; deadline: { deadline: string; explicit: boolean } | null },
): { rulesUrl?: string; deadline?: string } {
  const patch: { rulesUrl?: string; deadline?: string } = {};
  if (row.rulesUrl === null && page.rulesUrl !== null) patch.rulesUrl = page.rulesUrl;
  const scadenza = mergePageDeadline(row.deadline, page.deadline);
  if (scadenza !== null && scadenza !== row.deadline) patch.deadline = scadenza;
  return patch;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limitIndex = process.argv.indexOf("--limite");
  const limite = limitIndex >= 0 ? Number.parseInt(process.argv[limitIndex + 1] ?? "", 10) : DEFAULT_PAGE_LIMIT;
  const pagine = Number.isFinite(limite) && limite > 0 ? Math.min(limite, RULES_PAGE_SIZE) : DEFAULT_PAGE_LIMIT;

  const store: Store = createD1HttpStore(await d1OptionsForLocalRun(process.env));
  const fetcher: FetchLike = (input, init) => fetch(input, init);
  const now = new Date();
  const ctx: IngestContext = { fetcher, userAgent: USER_AGENT, now };

  // Tutti i concorsi attivi, non solo quelli senza bando: la pagina porta anche
  // la scadenza, e la riga "Scadenza :" può correggerne una sbagliata.
  const righe = (
    await store.queryItems({ kinds: ["contest"], statuses: STATI_ATTIVI, limit: RULES_PAGE_SIZE, orderBy: "first_seen" })
  ).filter((row) => STATI_ATTIVI.includes(row.status));
  const daLeggere = righe.slice(0, pagine);
  if (daLeggere.length === 0) {
    console.log("Nessun concorso attivo da rileggere.");
    return;
  }

  const esiti: Esito[] = [];
  for (const row of daLeggere) {
    const dalTesto = textRuleFor(row);
    const pagina = await contestPageFacts(row.url, {
      fetcher,
      userAgent: USER_AGENT,
      allows: (url) => robotsAllows(url, { store, fetcher, userAgent: USER_AGENT }, ctx, now),
      now,
    });
    const patch = patchFor(row, { rulesUrl: dalTesto ?? pagina.rulesUrl, deadline: pagina.deadline });
    esiti.push({ row, url: patch.rulesUrl ?? row.rulesUrl, deadline: patch.deadline ?? row.deadline, letto: pagina.letta });
  }

  const nuoviBandi = esiti.filter((esito) => esito.row.rulesUrl === null && esito.url !== null);
  const aggiunte = esiti.filter((esito) => esito.row.deadline === null && esito.deadline !== null);
  const corrette = esiti.filter((esito) => esito.row.deadline !== null && esito.deadline !== esito.row.deadline);
  console.log(`${daLeggere.length} concorsi attivi riletti (${esiti.filter((e) => e.letto).length} pagine lette):`);
  console.log(`  ${nuoviBandi.length} regolamenti nuovi`);
  console.log(`  ${aggiunte.length} scadenze aggiunte (prima non c'erano)`);
  console.log(`  ${corrette.length} scadenze corrette dalla riga "Scadenza :" della pagina`);
  for (const esito of corrette) console.log(`  · #${esito.row.id} ${esito.row.deadline} → ${esito.deadline} — ${esito.row.title}`);
  for (const esito of aggiunte.slice(0, 15)) console.log(`  + #${esito.row.id} ${esito.deadline} — ${esito.row.title}`);
  if (aggiunte.length > 15) console.log(`  … e altre ${aggiunte.length - 15} scadenze aggiunte`);

  if (!apply) {
    console.log("\nProva a vuoto: non ho cambiato niente. Rilancia con --apply per scrivere.");
    return;
  }

  // Il punteggio dipende dalla scadenza (l'urgenza): si rifà con le preferenze di
  // adesso, con la stessa funzione della raccolta.
  const weights = await mergedWeights(store);
  const favorites = await mergedBrands(store);
  let scritte = 0;
  for (const esito of esiti) {
    const patch: { rulesUrl?: string; deadline?: string; score?: number } = {};
    if (esito.row.rulesUrl === null && esito.url !== null) patch.rulesUrl = esito.url;
    if (esito.deadline !== esito.row.deadline && esito.deadline !== null) {
      patch.deadline = esito.deadline;
      patch.score = rescoreRow({ ...esito.row, deadline: esito.deadline }, weights, favorites, now);
    }
    if (Object.keys(patch).length === 0) continue;
    await store.updateItem(esito.row.id, patch);
    scritte++;
  }
  console.log(`\nAggiornati ${scritte} concorsi.`);
}

// Solo quando il file è il comando eseguito: importarlo da un test non scrive nulla.
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((error) => {
    console.error("Riempimento non riuscito:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
