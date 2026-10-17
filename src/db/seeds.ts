/**
 * La semina delle fonti, come SQL riusabile.
 *
 * Stava dentro `scripts/seed-sources.ts`, che la scriveva in un file per farla
 * eseguire a wrangler. Il comando di allineamento del database (`npm run db:sync`)
 * deve fare la stessa cosa senza passare da un file e senza wrangler: due copie
 * della stessa UPSERT sono due copie che divergono al primo campo nuovo, quindi la
 * generazione vive qui e i due esecutori la importano.
 *
 * Due regole non negoziabili, che erano già nel commento dello script e che
 * restano qui perché è qui che si può sbagliare:
 *  - la UPSERT aggiorna la DEFINIZIONE della fonte (nome, url, categoria, tag,
 *    cadenze, acceso/spento) e non tocca lo stato runtime (etag, last_modified,
 *    ultimo giro, esiti, fallimenti): una semina non deve cancellare la storia;
 *  - le fonti spente restano in tabella con `enabled = 0` invece di sparire, così
 *    riaccenderle non le ricrea da zero e i loro item in archivio restano
 *    attribuiti a qualcuno.
 */

/** Quello che serve alla semina: solo i campi di configurazione, non lo stato. */
export interface FonteDaSeminare {
  id: string;
  name: string;
  kind: string;
  url: string;
  category: string;
  tags: readonly string[];
  cadenceMin: number;
  enabled: boolean;
  /**
   * Come si legge la fonte, non solo dove sta: senza questi due campi la semina
   * lascerebbe in D1 una fonte "nuda", e il runner — che esegue il codice del
   * commit, non il working tree — non avrebbe nessun pattern da applicare.
   */
  includePattern?: string;
  maxItems?: number;
}

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

/** Una UPSERT per fonte, idempotente sull'id. */
export function sourceSeedStatements(sources: readonly FonteDaSeminare[]): string[] {
  return sources.map((source) => {
    const colonne = [
      `'${esc(source.id)}'`,
      `'${esc(source.name)}'`,
      `'${esc(source.kind)}'`,
      `'${esc(source.url)}'`,
      `'${esc(source.category)}'`,
      `'${esc(JSON.stringify(source.tags))}'`,
      String(source.cadenceMin),
      source.enabled ? "1" : "0",
      source.includePattern === undefined ? "NULL" : `'${esc(source.includePattern)}'`,
      source.maxItems === undefined ? "NULL" : String(source.maxItems),
    ].join(", ");

    return (
      `INSERT INTO sources (id, name, kind, url, category, tags, cadence_min, enabled, include_pattern, max_items)` +
      ` VALUES (${colonne})` +
      " ON CONFLICT(id) DO UPDATE SET" +
      " name = excluded.name, kind = excluded.kind, url = excluded.url, category = excluded.category," +
      " tags = excluded.tags, cadence_min = excluded.cadence_min, enabled = excluded.enabled," +
      " include_pattern = excluded.include_pattern, max_items = excluded.max_items"
    );
  });
}
