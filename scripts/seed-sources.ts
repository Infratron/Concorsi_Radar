import { mkdirSync, writeFileSync } from "node:fs";
import { SOURCES } from "../src/config/sources.ts";
import { sourceSeedStatements } from "../src/db/seeds.ts";

/**
 * Sincronizza l'elenco delle fonti dal file di configurazione al database D1.
 * Le colonne di stato (etag, last_modified, last_run_at, last_ok_at,
 * fail_streak) NON vengono toccate: la semina non deve azzerare la storia.
 *
 * Uso: npm run db:seed  (scrive .wrangler/sources-seed.sql e lo esegue su D1)
 *
 * Lo SQL non si scrive più qui: sta in `src/db/seeds.ts`, perché lo stesso
 * elenco lo esegue anche `npm run db:sync` (che parla con D1 via API HTTP,
 * senza wrangler, così può girare da GitHub Actions).
 */

const OUTPUT = ".wrangler/sources-seed.sql";

const lines: string[] = [
  "-- Generato da scripts/seed-sources.ts: non modificare a mano.",
  "-- Lo stato runtime (etag, ultimo giro, fallimenti) resta invariato.",
  ...sourceSeedStatements(SOURCES).map((sql) => `${sql};`),
];

mkdirSync(".wrangler", { recursive: true });
writeFileSync(OUTPUT, `${lines.join("\n")}\n`, "utf8");
console.log(`Scritte ${SOURCES.length} fonti in ${OUTPUT}`);
console.log(`Abilitate: ${SOURCES.filter((source) => source.enabled).length}`);
