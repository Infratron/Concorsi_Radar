import { describe, expect, it } from "vitest";
import {
  DISPATCH_MARK,
  dispatchCheck,
  dispatchIfSilent,
  dispatchWorkflow,
  dispatchConfig,
} from "../src/collect/dispatch.ts";
import type { RunRow } from "../src/types.ts";

const NOW = new Date("2026-10-17T09:00:00.000Z");

function run(partial: Partial<RunRow>): RunRow {
  return {
    startedAt: NOW.toISOString(),
    trigger: "*/15 * * * *",
    sourcesOk: 0,
    sourcesFail: 0,
    itemsNew: 0,
    ms: 30,
    note: "tick",
    log: null,
    ...partial,
  };
}

const azioni = (minutiFa: number, note: string | null = null): RunRow =>
  run({
    startedAt: new Date(NOW.getTime() - minutiFa * 60_000).toISOString(),
    trigger: "actions",
    sourcesOk: 31,
    note,
  });

interface Chiamata {
  url: string;
  init: RequestInit | undefined;
}

function fetcher(risposta: () => Response): { fetch: (url: string, init?: RequestInit) => Promise<Response>; chiamate: Chiamata[] } {
  const chiamate: Chiamata[] = [];
  return {
    chiamate,
    fetch: async (url: string, init?: RequestInit) => {
      chiamate.push({ url, init });
      return risposta();
    },
  };
}

const ok = (): Response => new Response(null, { status: 204 });
const env = { GITHUB_DISPATCH_TOKEN: "ghp_finto", GITHUB_REPO: "Infratron/Concorsi_Radar" };

describe("sveglia della raccolta · quando suona", () => {
  it("tace se GitHub ha raccolto da poco", () => {
    const check = dispatchCheck([azioni(10)], NOW);
    expect(check.inviare).toBe(false);
    expect(check.oreDaRaccolta).toBeCloseTo(1 / 6, 5);
  });

  it("suona dopo che il silenzio supera i 45 minuti", () => {
    expect(dispatchCheck([azioni(50)], NOW).inviare).toBe(true);
    expect(dispatchCheck([azioni(44)], NOW).inviare).toBe(false);
  });

  it("suona anche quando nella finestra non c'è nessuna raccolta", () => {
    // Solo tick del Worker: il silenzio è lungo almeno quanto la finestra.
    expect(dispatchCheck([run({}), run({})], NOW).inviare).toBe(true);
  });

  it("non ripete la sveglia prima di venti minuti", () => {
    const runs = [azioni(120), run({ startedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), note: DISPATCH_MARK })];
    expect(dispatchCheck(runs, NOW).inviare).toBe(false);
    const vecchia = [azioni(120), run({ startedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(), note: DISPATCH_MARK })];
    expect(dispatchCheck(vecchia, NOW).inviare).toBe(true);
  });
});

describe("sveglia della raccolta · la richiesta", () => {
  it("manda il POST giusto a GitHub e riporta la nota", async () => {
    const f = fetcher(ok);

    const nota = await dispatchIfSilent({ env, runs: [azioni(120)], now: NOW, fetcher: f.fetch });

    expect(nota).toBe(DISPATCH_MARK);
    expect(f.chiamate).toHaveLength(1);
    const [chiamata] = f.chiamate;
    expect(chiamata?.url).toBe(
      "https://api.github.com/repos/Infratron/Concorsi_Radar/actions/workflows/ingest.yml/dispatches",
    );
    expect(chiamata?.init?.method).toBe("POST");
    expect(String(chiamata?.init?.body)).toBe(JSON.stringify({ ref: "main" }));
    const headers = chiamata?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ghp_finto");
    expect(headers["user-agent"]).toBeDefined();
  });

  it("senza token non chiama nessuno e non scrive niente", async () => {
    const f = fetcher(ok);

    const nota = await dispatchIfSilent({ env: {}, runs: [azioni(120)], now: NOW, fetcher: f.fetch });

    // Niente nota: un "sveglia non inviata" ogni quarto d'ora sarebbe rumore.
    expect(nota).toBeNull();
    expect(f.chiamate).toHaveLength(0);
  });

  it("se GitHub risponde con un errore la nota lo dice, senza far fallire il giro", async () => {
    const f = fetcher(() => new Response("{}", { status: 401 }));

    const nota = await dispatchIfSilent({ env, runs: [azioni(120)], now: NOW, fetcher: f.fetch });

    expect(nota).toContain("errore");
    expect(nota).toContain("401");
  });

  it("un errore di rete non lancia", async () => {
    const esito = await dispatchWorkflow(dispatchConfig(env), async () => {
      throw new Error("rete giù");
    });
    expect(esito.ok).toBe(false);
    expect(esito.error).toContain("rete giù");
  });

  it("la configurazione ha valori sensati anche senza variabili", () => {
    const config = dispatchConfig({});
    expect(config.token).toBeNull();
    expect(config.repo).toBeNull();
    expect(config.workflow).toBe("ingest.yml");
    expect(config.ref).toBe("main");
  });
});
