import type { Env, FetchLike, RunRow } from "../types.ts";
import { isExternalTrigger } from "../schedule.ts";

/**
 * La sveglia della raccolta.
 *
 * Il cron di GitHub non è un orologio: i workflow programmati arrivano in ritardo
 * di minuti e, quando va male, saltano per ore. Il Worker però scatta ogni
 * quindici minuti e sa leggere la tabella `runs`: se la raccolta esterna tace
 * troppo, è lui a chiedere a GitHub di partire (`workflow_dispatch`). Non
 * sostituisce la raccolta — la sveglia fa partire quella vera, dalla rete che le
 * fonti lasciano passare.
 *
 * Tre regole, perché una sveglia che suona sempre è peggio di nessuna:
 *  - si suona solo dopo DISPATCH_AFTER_MS di silenzio (GitHub può ritardare di
 *    qualche minuto senza che ci sia niente da fare);
 *  - non più di una sveglia ogni DISPATCH_MIN_GAP_MS, altrimenti si martella
 *    l'API e si accodano esecuzioni;
 *  - senza token configurato non si fa niente e non si scrive niente: un avviso
 *    "sveglia non inviata" ogni quarto d'ora sarebbe solo rumore.
 */

/** Dopo quanto silenzio vale la pena svegliare GitHub. */
export const DISPATCH_AFTER_MS = 45 * 60 * 1000;
/** Distanza minima fra due sveglie. */
export const DISPATCH_MIN_GAP_MS = 20 * 60 * 1000;
/** Prefisso comune delle note: è come si riconosce l'ULTIMA sveglia. */
export const DISPATCH_PREFIX = "sveglia GitHub:";
/** Nota scritta quando la sveglia è partita davvero. */
export const DISPATCH_MARK = "sveglia GitHub: inviata";
/** File del workflow da svegliare. */
export const DEFAULT_WORKFLOW = "ingest.yml";
/** Ramo su cui farlo partire. */
export const DEFAULT_REF = "main";

export interface DispatchConfig {
  token: string | null;
  repo: string | null;
  workflow: string;
  ref: string;
}

/** Legge la configurazione; senza token o senza repo la sveglia è spenta. */
export function dispatchConfig(env: Partial<Env>): DispatchConfig {
  const token = (env.GITHUB_DISPATCH_TOKEN ?? "").trim();
  const repo = (env.GITHUB_REPO ?? "").trim();
  return {
    token: token.length > 0 ? token : null,
    repo: repo.length > 0 ? repo : null,
    workflow: (env.GITHUB_WORKFLOW ?? "").trim() || DEFAULT_WORKFLOW,
    ref: (env.GITHUB_REF ?? "").trim() || DEFAULT_REF,
  };
}

/** Ore dall'ultima raccolta esterna; null se non ce n'è nessuna nella finestra. */
function oreDaRaccolta(runs: RunRow[], now: Date): number | null {
  const ultima = runs.find((run) => isExternalTrigger(run.trigger));
  if (!ultima) return null;
  const at = Date.parse(ultima.startedAt);
  return Number.isFinite(at) ? (now.getTime() - at) / 3_600_000 : null;
}

/**
 * Se questa è la volta buona per suonare. `runs` è la finestra che il tick ha
 * già letto per la raccolta di riserva: una lettura per due decisioni.
 */
export function dispatchCheck(runs: RunRow[], now: Date): { inviare: boolean; oreDaRaccolta: number | null } {
  const ore = oreDaRaccolta(runs, now);
  // Nessuna raccolta nella finestra = silenzio lungo almeno quanto la finestra
  // stessa (cinquanta tick da un quarto d'ora, circa dodici ore): si suona.
  const ferma = ore === null || ore * 3_600_000 > DISPATCH_AFTER_MS;
  const sveglia = runs.find((run) => (run.note ?? "").includes(DISPATCH_PREFIX)) ?? null;
  const gia = sveglia !== null && now.getTime() - Date.parse(sveglia.startedAt) < DISPATCH_MIN_GAP_MS;
  return { inviare: ferma && !gia, oreDaRaccolta: ore };
}

/** Il POST che fa partire il workflow. 204 = accettato (non "eseguito"). */
export async function dispatchWorkflow(
  config: DispatchConfig,
  fetcher: FetchLike,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  if (!config.token || !config.repo) return { ok: false, status: null, error: "non configurata" };
  const url = `https://api.github.com/repos/${config.repo}/actions/workflows/${config.workflow}/dispatches`;
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        // GitHub vuole una User-Agent; senza, risponde 403.
        "user-agent": "ConcorsiRadar/1.0",
      },
      body: JSON.stringify({ ref: config.ref }),
      signal: AbortSignal.timeout(8_000),
    });
    return {
      ok: response.status === 204,
      status: response.status,
      error: response.status === 204 ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Il passo del tick: se serve, sveglia GitHub. Restituisce la nota da scrivere
 * nell'esecuzione (o null se non c'era niente da fare). Non lancia mai: una
 * sveglia che non parte non deve far fallire il giro del Worker.
 */
export async function dispatchIfSilent(deps: {
  env: Partial<Env>;
  runs: RunRow[];
  now: Date;
  fetcher: FetchLike;
}): Promise<string | null> {
  const config = dispatchConfig(deps.env);
  if (!config.token || !config.repo) return null;
  const check = dispatchCheck(deps.runs, deps.now);
  if (!check.inviare) return null;
  const esito = await dispatchWorkflow(config, deps.fetcher);
  return esito.ok ? DISPATCH_MARK : `${DISPATCH_PREFIX} errore ${esito.error ?? esito.status}`;
}
