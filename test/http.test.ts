import { describe, expect, it } from "vitest";
import { fetchText, jsonResponse } from "../src/lib/http.ts";
import type { FetchLike, IngestContext } from "../src/types.ts";

/** Il comportamento di rete è dove i cron si rompono in silenzio: qui lo blocchiamo. */

function context(fetcher: FetchLike): IngestContext {
  return { fetcher, userAgent: "ConcorsiRadarBot/test", now: new Date("2026-10-16T12:00:00.000Z") };
}

describe("fetchText", () => {
  it("ritenta una volta un errore 5xx e riesce al secondo tentativo", async () => {
    let calls = 0;
    const fetcher: FetchLike = async () => {
      calls++;
      return calls === 1 ? new Response("boom", { status: 503 }) : new Response("<rss></rss>", { status: 200 });
    };

    const result = await fetchText("https://a.example/feed", context(fetcher));
    expect(result.ok).toBe(true);
    expect(result.body).toBe("<rss></rss>");
    expect(calls).toBe(2);
  });

  it("non ritenta un 404 e riporta lo stato", async () => {
    let calls = 0;
    const fetcher: FetchLike = async () => {
      calls++;
      return new Response("nope", { status: 404 });
    };

    const result = await fetchText("https://a.example/manca", context(fetcher));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toBe("HTTP 404");
    expect(calls).toBe(1);
  });

  it("manda gli header condizionali e riconosce il 304", async () => {
    const seen: Record<string, string> = {};
    const fetcher: FetchLike = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seen.etag = headers.get("if-none-match") ?? "";
      seen.modified = headers.get("if-modified-since") ?? "";
      return new Response(null, { status: 304, headers: { etag: '"abc"' } });
    };

    const result = await fetchText("https://a.example/feed", context(fetcher), {
      conditional: { etag: '"abc"', lastModified: "Wed, 15 Oct 2026 10:00:00 GMT" },
    });
    expect(result.notModified).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.body).toBe("");
    expect(result.etag).toBe('"abc"');
    expect(seen.etag).toBe('"abc"');
    expect(seen.modified).toBe("Wed, 15 Oct 2026 10:00:00 GMT");
  });

  it("riporta l'errore di rete invece di lanciare, dopo i tentativi previsti", async () => {
    let calls = 0;
    const fetcher: FetchLike = async () => {
      calls++;
      throw new Error("connection reset");
    };

    const result = await fetchText("https://a.example/feed", context(fetcher));
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain("connection reset");
    expect(calls).toBe(2);
  });

  it("non ritenta quando maxRetries è 0", async () => {
    let calls = 0;
    const fetcher: FetchLike = async () => {
      calls++;
      throw new Error("dns");
    };
    const result = await fetchText("https://a.example/feed", context(fetcher), { maxRetries: 0 });
    expect(calls).toBe(1);
    expect(result.error).toContain("dns");
  });
});

describe("jsonResponse", () => {
  it("non fa cache e restituisce JSON leggibile", async () => {
    const response = jsonResponse({ ok: true, fonti: 12 }, 201);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ ok: true, fonti: 12 });
  });
});
