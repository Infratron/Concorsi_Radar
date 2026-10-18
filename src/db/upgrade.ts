import type { D1Like } from "./d1.ts";
import { DAILY_PLAY_PHRASES, DAILY_PLAY_TAG, INSTANT_WIN_SPELLINGS, WEEKLY_HINT } from "../enrich/rules.ts";

/**
 * Porta il database allo schema che il codice si aspetta, senza chiedere niente
 * a nessuno e senza mai cancellare.
 *
 * Perché esiste. `src/db/schema.sql` è fatto di `CREATE ... IF NOT EXISTS`, quindi
 * creare tabelle e indici mancanti è già idempotente: si può rieseguire a ogni
 * deploy. Il buco sono le COLONNE: `CREATE TABLE IF NOT EXISTS` su una tabella
 * che esiste già non la tocca, e finora ogni colonna nuova costava una riga di
 * SQL a mano — "eseguila PRIMA di pubblicare il codice che la legge", dicevano i
 * commenti dello schema. Un comando che si dimentica in fretta, e che dimenticato
 * fa fallire ogni scrittura in produzione.
 *
 * L'ordine non è un dettaglio: su un database vecchio gli INDICI di schema.sql
 * citano colonne che ancora non esistono (`items (kind, first_seen_at)`), quindi
 * creare prima gli indici fallirebbe con "no such column". Si fa:
 *   1. tabelle (`CREATE TABLE IF NOT EXISTS`);
 *   2. colonne mancanti (`ALTER TABLE ... ADD COLUMN`);
 *   3. indici (`CREATE INDEX IF NOT EXISTS`).
 *
 * Cosa NON fa: rinominare, cambiare tipo, cancellare. Una migrazione distruttiva
 * resta una decisione da prendere a mano, con il database davanti; questo comando
 * esiste per non doverci pensare quando invece basta aggiungere.
 */

/**
 * Le istruzioni di uno script SQL, una per `prepare` (D1 esegue un statement per
 * volta). I commenti `--` si tolgono riga per riga e le istruzioni si separano sul
 * `;`: è sufficiente per uno schema fatto di CREATE TABLE, CREATE INDEX e ALTER,
 * che non contiene `;` dentro le stringhe né trigger o blocchi BEGIN/END (se un
 * giorno li contenesse, questo split va sostituito con un parser vero).
 */
export function statementsFromSchema(sql: string): string[] {
  const senzaCommenti = sql
    .split(/\r?\n/)
    .filter((riga) => !riga.trim().startsWith("--"))
    .join("\n");
  return senzaCommenti
    .split(";")
    .map((istruzione) => istruzione.trim())
    .filter((istruzione) => istruzione.length > 0);
}

const E_INDICE = /^CREATE\s+(UNIQUE\s+)?INDEX\b/i;

interface ColonnaAttesa {
  tabella: string;
  colonna: string;
  /** Definizione completa: tipo, NOT NULL e DEFAULT come in schema.sql. */
  tipo: string;
  /** Perché c'è: finisce nel messaggio del comando, non nel database. */
  perche: string;
}

/**
 * Le colonne aggiunte DOPO la prima versione dello schema, in ordine di arrivo.
 * Ognuna è una riga di SQL che prima si eseguiva a mano: qui diventa parte del
 * deploy, e su un database già aggiornato il comando non fa nulla.
 */
const COLONNE_ATTESE: ColonnaAttesa[] = [
  {
    tabella: "sources",
    colonna: "include_pattern",
    tipo: "TEXT",
    perche: "filtro sugli URL della fonte, seminato in D1 per non dipendere dal commit del runner",
  },
  {
    tabella: "sources",
    colonna: "max_items",
    tipo: "INTEGER",
    perche: "tetto di item per giro, seminato in D1 accanto al pattern",
  },
  { tabella: "sources", colonna: "last_status", tipo: "INTEGER", perche: "codice HTTP dell'ultimo tentativo" },
  { tabella: "sources", colonna: "last_error", tipo: "TEXT", perche: "motivo dell'ultimo fallimento" },
  { tabella: "sources", colonna: "last_items", tipo: "INTEGER NOT NULL DEFAULT 0", perche: "item grezzi letti nell'ultimo giro" },
  { tabella: "items", colonna: "kind", tipo: "TEXT NOT NULL DEFAULT 'contest'", perche: "concorso, coupon o articolo" },
  { tabella: "items", colonna: "brand", tipo: "TEXT", perche: "marca riconosciuta: preferiti e sezione per marca" },
  { tabella: "items", colonna: "rules_url", tipo: "TEXT", perche: "bando trovato leggendo la pagina del concorso" },
  { tabella: "prefs", colonna: "filters", tipo: "TEXT NOT NULL DEFAULT '{}'", perche: "filtri personali della chat" },
  {
    tabella: "prefs",
    colonna: "instant_alerts",
    tipo: "INTEGER NOT NULL DEFAULT 0",
    perche: "avvisi per punteggio: spenti finché la chat non li accende",
  },
  { tabella: "runs", colonna: "log", tipo: "TEXT", perche: "racconto fonte per fonte di una raccolta" },
  { tabella: "prefs", colonna: "giro_hour", tipo: "INTEGER", perche: "ora del promemoria del giro di oggi (NULL = spento)" },
  {
    tabella: "ui",
    colonna: "history",
    tipo: "TEXT",
    perche: "storia di navigazione per il ritorno alla pagina di prima",
  },
];

/**
 * Un passo di DATI, da eseguire una volta sola.
 *
 * Perché non basta lo schema: cambiare il DEFAULT di una colonna non tocca le
 * righe che ci sono già. Il caso vero è il digest: le righe nate con
 * `digest_hours = '[8,19]'` continuerebbero a ricevere due riepiloghi al giorno
 * anche dopo che il default è diventato `'[]'` — e chi li riceve non li ha mai
 * chiesti. La riga in `migrations` è il "già fatto": senza, ogni deploy
 * risvuoterebbe la scelta di chi il digest l'ha acceso davvero.
 */
interface MigrazioneDati {
  /** Chiave stabile: è la riga in `migrations`, quindi non si cambia più. */
  id: string;
  /** Perché esiste: finisce nel messaggio del comando, non nel database. */
  perche: string;
  sql: string[];
}

const MIGRAZIONI_DATI: MigrazioneDati[] = [
  {
    id: "2026-10-17-notifiche-opt-in",
    perche: "toglie i digest che le righe vecchie avevano ereditato dal default [8,19]",
    sql: ["UPDATE prefs SET digest_hours = '[]' WHERE digest_hours <> '[]'"],
  },
  {
    // La raccolta assegna il tag ai concorsi nuovi; quelli già in archivio non
    // ripassano dall'arricchimento, e senza questo passo il giro partirebbe
    // vuoto. Le frasi sono le stesse della regola (DAILY_PLAY_PHRASES).
    id: "2026-10-19-tag-giornaliero",
    perche: "assegna il tag del giro di oggi ai concorsi già in archivio che si giocano ogni giorno",
    sql: [dailyPlayBackfillSql()],
  },
  {
    // Lo stesso riempimento con la regola allargata agli instant win gratuiti:
    // un passo nuovo perché quello di prima risulta già fatto in produzione.
    id: "2026-10-19-tag-giornaliero-instant-win",
    perche: "aggiunge al giro gli instant win gratuiti già in archivio",
    sql: [dailyPlayBackfillSql()],
  },
];

/**
 * Il riempimento del tag del giro, in SQL: una LIKE per frase della regola, più
 * l'instant win senza acquisto e non settimanale — le stesse liste della
 * raccolta (src/enrich/rules.ts), quindi le due strade dicono la stessa cosa.
 */
export function dailyPlayBackfillSql(): string {
  const testo = "LOWER(title || ' ' || summary || ' ' || COALESCE(participation, ''))";
  const frasi = DAILY_PLAY_PHRASES.map((frase) => `${testo} LIKE '%${frase}%'`).join(" OR ");
  const instantWin = INSTANT_WIN_SPELLINGS.map((grafia) => `${testo} LIKE '%${grafia}%'`).join(" OR ");
  return `UPDATE items SET tags = json_insert(tags, '$[#]', '${DAILY_PLAY_TAG}')
    WHERE kind = 'contest'
      AND NOT EXISTS (SELECT 1 FROM json_each(items.tags) WHERE value = '${DAILY_PLAY_TAG}')
      AND ((${frasi})
        OR (requires_purchase = 0 AND (${instantWin}) AND ${testo} NOT LIKE '%${WEEKLY_HINT}%'))`;
}

export interface UpgradeResult {
  /** Istruzioni dello schema eseguite (idempotenti: CREATE ... IF NOT EXISTS). */
  istruzioni: number;
  /** Colonne che MANCAVANO e sono state aggiunte, come "items.brand". */
  colonne: string[];
  /** Indici che mancavano e sono stati creati. */
  indici: string[];
  /** Passi di dati eseguiti ADESSO (le chiavi); quelli già fatti non compaiono. */
  migrazioni: string[];
}

/**
 * Applica lo schema e allinea le colonne. Si può eseguire quante volte si vuole:
 * su un database già in pari il risultato è `colonne: []` e `indici: []`.
 */
export async function upgradeDatabase(db: D1Like, schemaSql: string): Promise<UpgradeResult> {
  const istruzioni = statementsFromSchema(schemaSql);
  // Tabelle prima, indici dopo: vedi il commento in testa al file.
  for (const sql of istruzioni.filter((istruzione) => !E_INDICE.test(istruzione))) {
    await db.prepare(sql).run();
  }

  const colonne: string[] = [];
  // Una lettura per tabella, non una per colonna: `pragma_table_info` è una
  // funzione tabellare, quindi si interroga come una tabella normale (e il nome
  // arriva come parametro, mai concatenato nell'SQL).
  const presenti = new Map<string, Set<string>>();
  for (const attesa of COLONNE_ATTESE) {
    let nomi = presenti.get(attesa.tabella);
    if (nomi === undefined) {
      const righe = await db
        .prepare("SELECT name FROM pragma_table_info(?)")
        .bind(attesa.tabella)
        .all<{ name: string }>();
      nomi = new Set((righe.results ?? []).map((riga) => riga.name));
      presenti.set(attesa.tabella, nomi);
    }
    if (nomi.has(attesa.colonna)) continue;
    // Nomi di tabella e colonna vengono da questo file, non dagli input: qui non
    // c'è niente da bindare.
    await db.prepare(`ALTER TABLE ${attesa.tabella} ADD COLUMN ${attesa.colonna} ${attesa.tipo}`).run();
    nomi.add(attesa.colonna);
    colonne.push(`${attesa.tabella}.${attesa.colonna}`);
  }

  const migrazioni: string[] = [];
  // Tabella dei passi già fatti: la crea schema.sql, ma il comando deve poter
  // partire anche con uno schema più vecchio di questa riga (DB di test, o
  // chiamata diretta): `IF NOT EXISTS` costa niente e toglie il caso.
  await db.prepare("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)").run();
  for (const passo of MIGRAZIONI_DATI) {
    const fatto = await db.prepare("SELECT 1 AS hit FROM migrations WHERE id = ?").bind(passo.id).first<{ hit: number }>();
    if (fatto !== null && fatto !== undefined) continue;
    for (const sql of passo.sql) await db.prepare(sql).run();
    await db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").bind(passo.id, new Date().toISOString()).run();
    migrazioni.push(passo.id);
  }

  const indici: string[] = [];
  // `CREATE INDEX IF NOT EXISTS` è già idempotente: si esegue e si guarda se
  // l'indice c'era, solo per poterlo raccontare.
  // Un solo elenco di indici, quello di schema.sql: due copie divergerebbero, e
  // l'indice dimenticato è quello che rende lenta una query che funziona.
  for (const sql of istruzioni.filter((istruzione) => E_INDICE.test(istruzione))) {
    const nome = /INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i.exec(sql)?.[1] ?? null;
    const esistente =
      nome === null
        ? null
        : await db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
            .bind(nome)
            .first<{ name: string }>();
    await db.prepare(sql).run();
    if (esistente === null && nome !== null) indici.push(nome);
  }

  return { istruzioni: istruzioni.length, colonne, indici: [...new Set(indici)], migrazioni };
}

/** L'elenco delle colonne attese, per il comando che le racconta. */
export function colonneAttese(): Array<{ colonna: string; perche: string }> {
  return COLONNE_ATTESE.map((voce) => ({ colonna: `${voce.tabella}.${voce.colonna}`, perche: voce.perche }));
}

/** I passi di dati, per il comando che li racconta. */
export function migrazioniDiDati(): Array<{ id: string; perche: string }> {
  return MIGRAZIONI_DATI.map((passo) => ({ id: passo.id, perche: passo.perche }));
}
