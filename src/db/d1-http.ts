import type { FetchLike } from "../types.ts";
import { createD1Store, type D1Like, type D1LikeStatement } from "./d1.ts";
import type { Store } from "./store.ts";

/**
 * D1 senza il binding: parla con l'API HTTP di Cloudflare.
 *
 * Serve alla raccolta dei feed che gira su GitHub Actions (rete diversa da
 * quella di Workers, dove diverse fonti rispondono 403/503). L'SQL non viene
 * duplicato: questo file implementa solo il *trasporto*, e `createD1Store`
 * esegue le stesse query del Worker.
 *
 * Documentazione: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
 *
 * Risposta dell'API (semplificata):
 *   { success: true, result: [ { results: [ {...} ], meta: { changes: 1 } } ] }
 * con gli errori in `errors: [{ code, message }]` quando success è false.
 */

export interface D1HttpOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  /** Per i test: finto fetch o endpoint diverso. */
  fetcher?: FetchLike;
  /** Base dell'API, sovrascrivibile nei test. */
  apiBase?: string;
}

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";

interface D1ApiResult {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: {
    results?: unknown[];
    meta?: { changes?: number; rows_written?: number };
    success?: boolean;
  }[];
}

/** Un errore dell'API deve dire cosa è andato storto: senza SQL nei log. */
function apiError(status: number, payload: D1ApiResult | null): Error {
  const detail = payload?.errors?.map((entry) => entry.message ?? `codice ${entry.code}`).join("; ");
  return new Error(`D1 API ${status}${detail ? `: ${detail}` : ""}`);
}

function statementFor(sql: string, params: unknown[], options: Required<Pick<D1HttpOptions, "apiBase" | "fetcher">> & D1HttpOptions): D1LikeStatement {
  const execute = async (): Promise<D1ApiResult> => {
    const response = await options.fetcher(
      `${options.apiBase}/accounts/${options.accountId}/d1/database/${options.databaseId}/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiToken}`,
          "content-type": "application/json",
        },
        // I parametri viaggiano separati dall'SQL: nessuna interpolazione.
        body: JSON.stringify({ sql, params }),
      },
    );

    if (!response.ok) {
      let payload: D1ApiResult | null = null;
      try {
        payload = (await response.json()) as D1ApiResult;
      } catch {
        payload = null;
      }
      throw apiError(response.status, payload);
    }

    const payload = (await response.json()) as D1ApiResult;
    if (!payload.success) throw apiError(200, payload);
    return payload;
  };

  const statement: D1LikeStatement = {
    bind(...next: unknown[]): D1LikeStatement {
      return statementFor(sql, next, options);
    },
    async first<T>(): Promise<T | null> {
      const payload = await execute();
      const rows = (payload.result?.[0]?.results ?? []) as T[];
      return rows.length > 0 ? rows[0] : null;
    },
    async all<T>(): Promise<{ results?: T[] }> {
      const payload = await execute();
      return { results: (payload.result?.[0]?.results ?? []) as T[] };
    },
    async run(): Promise<{ meta?: { changes?: number } }> {
      const payload = await execute();
      const meta = payload.result?.[0]?.meta;
      return { meta: meta ? { changes: meta.changes ?? meta.rows_written } : undefined };
    },
  };
  return statement;
}

/** Un `D1Like` che esegue le query via API HTTP. */
export function createD1HttpBinding(options: D1HttpOptions): D1Like {
  const resolved = {
    ...options,
    apiBase: options.apiBase ?? DEFAULT_API_BASE,
    fetcher: options.fetcher ?? ((input: string, init?: RequestInit) => fetch(input, init)),
  };
  return {
    prepare(sql: string): D1LikeStatement {
      return statementFor(sql, [], resolved);
    },
  };
}

/**
 * Store completo per un processo fuori da Workers (script di raccolta).
 * Le credenziali arrivano da variabili d'ambiente nel workflow.
 */
export function createD1HttpStore(options: D1HttpOptions): Store {
  return createD1Store(createD1HttpBinding(options));
}

/**
 * Credenziali dalle variabili d'ambiente, con errore leggibile se mancano.
 * `D1_API_BASE` è facoltativa e serve solo a puntare la raccolta a un finto API
 * (per esempio un server locale che esegue l'SQL su SQLite): in produzione resta
 * l'indirizzo vero di Cloudflare.
 */
export function d1HttpOptionsFromEnv(env: Record<string, string | undefined>): D1HttpOptions {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  const databaseId = env.D1_DATABASE_ID?.trim() ?? "";
  const apiBase = env.D1_API_BASE?.trim() ?? "";
  const missing = [
    accountId.length > 0 ? null : "CLOUDFLARE_ACCOUNT_ID",
    apiToken.length > 0 ? null : "CLOUDFLARE_API_TOKEN",
    databaseId.length > 0 ? null : "D1_DATABASE_ID",
  ].filter((entry): entry is string => entry !== null);
  if (missing.length > 0) {
    throw new Error(`Variabili d'ambiente mancanti: ${missing.join(", ")}`);
  }
  return { accountId, apiToken, databaseId, ...(apiBase.length > 0 ? { apiBase } : {}) };
}
