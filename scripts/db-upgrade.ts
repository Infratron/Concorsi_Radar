import { readFileSync } from "node:fs";
import { createD1HttpBinding } from "../src/db/d1-http.ts";
import { SOURCES } from "../src/config/sources.ts";
import { sourceSeedStatements } from "../src/db/seeds.ts";
import { colonneAttese, migrazioniDiDati, upgradeDatabase } from "../src/db/upgrade.ts";
import { d1OptionsForLocalRun } from "./wrangler-auth.ts";

/**
 * Porta il database D1 allo stato che il codice si aspetta: tabelle e indici
 * mancanti, colonne aggiunte dopo, e — con `--seed` — l'elenco delle fonti.
 *
 * Uso:
 *   npm run db:upgrade        # solo schema e colonne (idempotente)
 *   npm run db:sync           # schema + fonti (è quello che gira nel workflow)
 *
 * Credenziali: le tre variabili d'ambiente (CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_API_TOKEN con D1:Edit, D1_DATABASE_ID) oppure il login di wrangler
 * su questo PC, esattamente come la raccolta (scripts/wrangler-auth.ts).
 *
 * Sta qui, e non in un comando wrangler, perché così può girare da GitHub
 * Actions: `wrangler d1 execute` avrebbe bisogno di wrangler installato e di un
 * file SQL generato a ogni passo, mentre lo schema lo leggiamo dal repository e
 * lo eseguiamo con lo stesso trasporto della raccolta.
 */

const conFonti = process.argv.includes("--seed");
const schemaSql = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");

try {
  const db = createD1HttpBinding(await d1OptionsForLocalRun(process.env));
  const risultato = await upgradeDatabase(db, schemaSql);

  console.log(
    `Schema: ${risultato.istruzioni} istruzioni (CREATE ... IF NOT EXISTS) · ` +
      `${risultato.colonne.length === 0 ? "nessuna colonna mancante" : `${risultato.colonne.length} colonne aggiunte`} · ` +
      `${risultato.indici.length === 0 ? "nessun indice mancante" : `indici creati: ${risultato.indici.join(", ")}`}`,
  );
  // Una colonna aggiunta è una notizia: dice che il codice nuovo era pubblicato
  // prima che il database sapesse rispondere. Si stampa cosa e perché.
  for (const nome of risultato.colonne) {
    const attesa = colonneAttese().find((voce) => voce.colonna === nome);
    console.log(`  + ${nome}${attesa ? ` — ${attesa.perche}` : ""}`);
  }
  // Un passo di dati tocca righe esistenti: si racconta sempre, perché è
  // l'unica cosa di questo comando che può cambiare quello che l'utente vede.
  for (const id of risultato.migrazioni) {
    const passo = migrazioniDiDati().find((voce) => voce.id === id);
    console.log(`  ~ dati: ${id}${passo ? ` — ${passo.perche}` : ""}`);
  }

  if (conFonti) {
    const istruzioni = sourceSeedStatements(SOURCES);
    for (const sql of istruzioni) await db.prepare(sql).run();
    console.log(
      `Fonti: ${istruzioni.length} sincronizzate dalla configurazione ` +
        `(${SOURCES.filter((source) => source.enabled).length} accese) — lo stato runtime è rimasto dov'era`,
    );
  }
} catch (error) {
  console.error(`Allineamento del database non riuscito: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
