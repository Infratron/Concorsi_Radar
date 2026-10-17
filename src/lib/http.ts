import type { FetchLike, IngestContext } from "../types.ts";

export interface ConditionalHeaders {
  etag: string | null;
  lastModified: string | null;
}

export interface HttpResult {
  ok: boolean;
  status: number | null;
  notModified: boolean;
  body: string;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  error: string | null;
}

export interface FetchTextOptions {
  conditional?: ConditionalHeaders;
  accept?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET testuale con ETag/Last-Modified, timeout e un retry con backoff su
 * errori transitori (rete, 429, 5xx). L'attesa non consuma CPU: il limite dei
 * 10 ms sul piano Free riguarda solo il codice eseguito.
 */
export async function fetchText(
  url: string,
  ctx: IngestContext,
  options: FetchTextOptions = {},
): Promise<HttpResult> {
  const { conditional, accept = "application/rss+xml, application/xml, text/xml, application/atom+xml, text/html;q=0.9, */*;q=0.5", timeoutMs = 8000, maxRetries = 1 } = options;
  const headers: Record<string, string> = {
    "user-agent": ctx.userAgent,
    accept,
    "accept-language": "it-IT,it;q=0.9",
  };
  if (conditional?.etag) headers["if-none-match"] = conditional.etag;
  if (conditional?.lastModified) headers["if-modified-since"] = conditional.lastModified;

  let lastError: string | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await ctx.fetcher(url, { headers, redirect: "follow", signal: controller.signal });
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      const contentType = response.headers.get("content-type");

      if (response.status === 304) {
        return {
          ok: true, status: 304, notModified: true, body: "", etag: etag ?? conditional?.etag ?? null,
          lastModified: lastModified ?? conditional?.lastModified ?? null, contentType, error: null,
        };
      }
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxRetries) {
          const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
          await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 5000) : 800);
          continue;
        }
        return {
          ok: false, status: response.status, notModified: false, body: "", etag, lastModified,
          contentType, error: lastError,
        };
      }

      const body = await response.text();
      return { ok: true, status: response.status, notModified: false, body, etag, lastModified, contentType, error: null };
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      lastError = message;
      if (attempt < maxRetries) {
        await sleep(800);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false, status: null, notModified: false, body: "", etag: null, lastModified: null,
    contentType: null, error: lastError ?? "fetch fallito",
  };
}

/**
 * HTML autoprodotto (una pagina sola, nessun asset). `no-store` perché non c'è
 * niente da mettere in cache, e la CSP tiene fuori tutto tranne lo stile e lo
 * script inline della pagina: non è una pagina che deve caricare risorse altrui.
 */
export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
