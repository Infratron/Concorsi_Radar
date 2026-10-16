import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { d1HttpOptionsFromEnv, type D1HttpOptions } from "../src/db/d1-http.ts";

/**
 * Le credenziali per far girare la raccolta da un PC, e non da Cloudflare.
 *
 * Perché esiste. La raccolta non può vivere nel Worker: la rete di Cloudflare
 * viene bloccata (403) da alcune fonti italiane, mentre gli stessi URL, con la
 * stessa User-Agent, rispondono da un'altra rete. La via normale per questo
 * secondo esecutore è un token API (`CLOUDFLARE_API_TOKEN` con permesso
 * `D1:Edit`), che è anche l'unico adatto a una raccolta periodica.
 *
 * Quando però serve solo una raccolta a mano, chiedere di creare un token è un
 * attrito inutile: questo file riusa il login di wrangler già presente sulla
 * macchina (`npx wrangler login`, il comando che serve comunque per pubblicare),
 * che wrangler tiene in un file di configurazione fuori dal progetto.
 *
 * Ordine di lettura, dal più esplicito al più comodo:
 *  1. le tre variabili d'ambiente (`CLOUDFLARE_ACCOUNT_ID`,
 *     `CLOUDFLARE_API_TOKEN`, `D1_DATABASE_ID`), lo stesso percorso di GitHub;
 *  2. il login di wrangler: token dal suo file di configurazione, id del
 *     database da `wrangler.toml` (non è un segreto: è nel repository) e id
 *     dell'account chiesto all'API con lo stesso token.
 *
 * Limite dichiarato: il token di wrangler scade in poche ore e lo rinnova
 * wrangler quando lo usa. Se risulta scaduto l'errore dice cosa fare (un
 * `npx wrangler whoami` lo rinnova). Un token API non ha questo problema:
 * per una raccolta che gira da sola, quello è il modo giusto.
 */

/** Nome con cui il workflow e gli script si aspettano le credenziali. */
export const ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "D1_DATABASE_ID"] as const;

/**
 * Dove wrangler tiene il login, nell'ordine in cui ha senso cercarlo: prima il
 * percorso della piattaforma (su Windows è sotto %APPDATA%), poi quello XDG.
 */
export function wranglerConfigPaths(env: Record<string, string | undefined>, home = homedir()): string[] {
  const percorsi: string[] = [];
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const appData = env.APPDATA?.trim();
  if (xdg) percorsi.push(join(xdg, ".wrangler", "config", "default.toml"));
  // Su Windows wrangler usa `%APPDATA%/xdg.config` come HOME.
  if (appData) percorsi.push(join(appData, "xdg.config", ".wrangler", "config", "default.toml"));
  percorsi.push(join(home, ".wrangler", "config", "default.toml"));
  percorsi.push(join(home, ".config", ".wrangler", "config", "default.toml"));
  return percorsi;
}

/** Un valore `chiave = "valore"` di un file TOML, senza dipendere da un parser. */
function tomlValue(text: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n\\r]+?)"?\\s*$`, "m").exec(text);
  return match?.[1]?.trim() ?? null;
}

/** Il token del login di wrangler, se il file ne contiene uno. */
export function oauthTokenFromConfig(text: string): string | null {
  const token = tomlValue(text, "oauth_token");
  return token !== null && token.length > 0 ? token : null;
}

/**
 * Quando scade il token (ISO 8601). Serve solo a scegliere l'errore giusto: un
 * token scaduto non è un token assente, e la cura è diversa — il primo si
 * rinnova con wrangler, il secondo si crea.
 */
export function oauthExpiryFromConfig(text: string): Date | null {
  const value = tomlValue(text, "expiration_time");
  if (value === null) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at) : null;
}

/**
 * L'id del database dal `wrangler.toml` del progetto: è l'unico pezzo che serve
 * alla raccolta e che è già scritto nel repository (non è un segreto, e senza di
 * esso nemmeno la pubblicazione funzionerebbe).
 */
export function databaseIdFromToml(text: string): string | null {
  const match = /^\s*database_id\s*=\s*"([^"]+)"/m.exec(text);
  return match?.[1]?.trim() ?? null;
}

export interface LocalAuthDeps {
  /** Lettura di un file, `null` se non c'è. Iniettabile per i test. */
  readTextFile?: (path: string) => string | null;
  /** Percorsi candidati del login di wrangler. */
  configPaths?: string[];
  /** Percorso del `wrangler.toml` del progetto. */
  projectToml?: string;
  fetcher?: typeof fetch;
  now?: Date;
}

function defaultRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * L'id dell'account con quel token: l'unica cosa che il file di configurazione
 * di wrangler non contiene. Si chiede all'API, che è la stessa che accetta il
 * token per scrivere su D1 — se la risposta non arriva, l'errore lo dice invece
 * di inventare un id.
 */
async function accountIdFromApi(token: string, fetcher: typeof fetch): Promise<string | null> {
  const response = await fetcher("https://api.cloudflare.com/client/v4/accounts", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { result?: { id?: string }[] };
  const id = payload.result?.find((entry) => typeof entry.id === "string" && entry.id.length > 0)?.id;
  return id ?? null;
}

/**
 * Le credenziali con cui la raccolta scrive su D1: quelle dichiarate, o quelle
 * del login di wrangler. L'errore, quando non si trova niente, elenca i due modi
 * di procurarsele invece di lamentarsi e basta.
 */
export async function d1OptionsForLocalRun(
  env: Record<string, string | undefined>,
  deps: LocalAuthDeps = {},
): Promise<D1HttpOptions> {
  const mancanti = ENV_KEYS.filter((key) => (env[key] ?? "").trim().length === 0);
  if (mancanti.length === 0) return d1HttpOptionsFromEnv(env);

  const leggi = deps.readTextFile ?? defaultRead;
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? new Date();

  let configText: string | null = null;
  for (const path of deps.configPaths ?? wranglerConfigPaths(env)) {
    configText = leggi(path);
    if (configText !== null) break;
  }
  const token = configText === null ? null : oauthTokenFromConfig(configText);
  const databaseId = env.D1_DATABASE_ID?.trim() ?? databaseIdFromToml(leggi(deps.projectToml ?? "wrangler.toml") ?? "");
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? (token === null ? null : await accountIdFromApi(token, fetcher));

  const nonTrovati = [
    accountId === null ? "CLOUDFLARE_ACCOUNT_ID" : null,
    token === null ? "CLOUDFLARE_API_TOKEN" : null,
    databaseId === null ? "D1_DATABASE_ID" : null,
  ].filter((entry): entry is string => entry !== null);
  if (nonTrovati.length > 0) {
    throw new Error(
      `Credenziali D1 mancanti: ${nonTrovati.join(", ")}. ` +
        "Due modi: esporta le tre variabili (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN con permesso D1:Edit, " +
        "D1_DATABASE_ID), oppure accedi con `npx wrangler login` e lascia che la raccolta usi quel login.",
    );
  }

  const scadenza = configText === null ? null : oauthExpiryFromConfig(configText);
  if (env.CLOUDFLARE_API_TOKEN === undefined && scadenza !== null && scadenza.getTime() <= now.getTime()) {
    throw new Error(
      `Il login di wrangler è scaduto (${scadenza.toISOString()}): esegui \`npx wrangler whoami\` per rinnovarlo, ` +
        "oppure usa un token API in CLOUDFLARE_API_TOKEN.",
    );
  }

  // Il token è quello scelto sopra: variabile d'ambiente se c'è, altrimenti il
  // login di wrangler. Non è un segreto da stampare, quindi non compare in
  // nessun messaggio di questo file.
  return {
    accountId: accountId as string,
    apiToken: (env.CLOUDFLARE_API_TOKEN?.trim() ?? token) as string,
    databaseId: databaseId as string,
  };
}
