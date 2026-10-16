import { mkdirSync, writeFileSync } from "node:fs";
import { SOURCES } from "../src/config/sources.ts";

/**
 * Sincronizza l'elenco delle fonti dal file di configurazione al database D1.
 * Le colonne di stato (etag, last_modified, last_run_at, last_ok_at,
 * fail_streak) NON vengono toccate: la semina non deve azzerare la storia.
 *
 * Uso: npm run db:seed  (scrive .wrangler/sources-seed.sql e lo esegue su D1)
 */

const OUTPUT = ".wrangler/sources-seed.sql";

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

const lines: string[] = [
  "-- Generato da scripts/seed-sources.ts: non modificare a mano.",
  "-- Lo stato runtime (etag, ultimo giro, fallimenti) resta invariato.",
];

for (const source of SOURCES) {
  const columns = [
    `'${esc(source.id)}'`,
    `'${esc(source.name)}'`,
    `'${esc(source.kind)}'`,
    `'${esc(source.url)}'`,
    `'${esc(source.category)}'`,
    `'${esc(JSON.stringify(source.tags))}'`,
    String(source.cadenceMin),
    source.enabled ? "1" : "0",
  ].join(", ");

  lines.push(
    `INSERT INTO sources (id, name, kind, url, category, tags, cadence_min, enabled) VALUES (${columns})` +
      " ON CONFLICT(id) DO UPDATE SET" +
      " name = excluded.name, kind = excluded.kind, url = excluded.url, category = excluded.category," +
      " tags = excluded.tags, cadence_min = excluded.cadence_min, enabled = excluded.enabled;",
  );
}

mkdirSync(".wrangler", { recursive: true });
writeFileSync(OUTPUT, `${lines.join("\n")}\n`, "utf8");
console.log(`Scritte ${SOURCES.length} fonti in ${OUTPUT}`);
console.log(`Abilitate: ${SOURCES.filter((source) => source.enabled).length}`);
