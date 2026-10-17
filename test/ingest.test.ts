import { describe, expect, it, vi } from "vitest";

import type { FetchLike, SourceRow } from "../src/types.ts";
import type { Store } from "../src/db/store.ts";
import { parseGoogleNewsFeed, parseRssFeed } from "../src/ingest/rss.ts";
import { parseSitemap, titleFromUrl } from "../src/ingest/sitemap.ts";
import { parseHtmlLinks } from "../src/ingest/httplist.ts";
import { ingestSource } from "../src/ingest/index.ts";
import { matchesPattern } from "../src/ingest/shared.ts";
import { SOURCES } from "../src/config/sources.ts";

const NOW = new Date("2026-10-16T08:00:00.000Z");

function source(overrides: Partial<SourceRow> & Pick<SourceRow, "id" | "kind" | "url">): SourceRow {
  return {
    name: overrides.id,
    category: "online",
    tags: [],
    cadenceMin: 30,
    enabled: true,
    etag: null,
    lastModified: null,
    lastRunAt: null,
    lastOkAt: null,
    failStreak: 0,
    lastStatus: null,
    lastError: null,
    lastItems: 0,
    ...overrides,
  };
}

/** Store minimale: la store in-memory completa è di un altro worker. */
function makeStore(overrides: Partial<Store> = {}): Store {
  return {
    getRobots: async () => null,
    saveRobots: async () => undefined,
    ...overrides,
  } as unknown as Store;
}

function makeFetcher(
  routes: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>,
): FetchLike {
  return async (input: string) => {
    const route = routes[input];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body ?? null, {
      status: route.status ?? 200,
      headers: route.headers,
    });
  };
}

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Premi e Concorsi</title>
    <item>
      <title>Concorso &amp; premio: vinci 2.000 &#8364;</title>
      <link>https://www.premieconcorsi.com/concorsi/vinci-2000-euro/</link>
      <description><![CDATA[<p>Regolamento e <strong>modulo</strong> di partecipazione.</p>]]></description>
      <pubDate>Mon, 13 Oct 2026 07:45:00 +0200</pubDate>
      <guid isPermaLink="true">https://www.premieconcorsi.com/concorsi/vinci-2000-euro/</guid>
    </item>
    <item>
      <title>Raccolta punti: vinci buoni spesa</title>
      <link>/concorsi/buoni-spesa/</link>
      <description>Concorso con scontrino.</description>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Vinci un viaggio a New York</title>
    <link rel="alternate" type="text/html" href="https://www.esempio.it/concorsi/new-york?utm_source=feed"/>
    <id>https://www.esempio.it/concorsi/new-york</id>
    <updated>2026-10-14T09:30:00+02:00</updated>
    <summary type="html">&lt;p&gt;Partecipa &lt;b&gt;gratis&lt;/b&gt; entro il 30 novembre.&lt;/p&gt;</summary>
  </entry>
</feed>`;

const GOOGLE_NEWS_FIXTURE = `<rss version="2.0"><channel>
  <item>
    <title>Concorso Esselunga: buoni spesa da 1.000 euro - Corriere della Sera</title>
    <link>https://news.google.com/rss/articles/CBMiabc?oc=5</link>
    <guid isPermaLink="false">CBMiabc</guid>
    <pubDate>Wed, 15 Oct 2026 08:12:00 GMT</pubDate>
    <source url="https://www.corriere.it">Corriere della Sera</source>
  </item>
</channel></rss>`;

describe("parseRssFeed", () => {
  it("legge RSS 2.0 con CDATA, entità e data RFC 822", () => {
    const items = parseRssFeed(RSS_FIXTURE, "premieconcorsi", "https://www.premieconcorsi.com/rss.php", 10);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      sourceId: "premieconcorsi",
      title: "Concorso & premio: vinci 2.000 €",
      url: "https://www.premieconcorsi.com/concorsi/vinci-2000-euro/",
      summary: "Regolamento e modulo di partecipazione.",
      publishedAt: "2026-10-13T05:45:00.000Z",
      guid: "https://www.premieconcorsi.com/concorsi/vinci-2000-euro/",
    });
    // Link relativo risolto sulla base del feed, senza data → null.
    expect(items[1].url).toBe("https://www.premieconcorsi.com/concorsi/buoni-spesa/");
    expect(items[1].publishedAt).toBeNull();
  });

  it("rispetta maxItems", () => {
    expect(parseRssFeed(RSS_FIXTURE, "x", "https://www.premieconcorsi.com/", 1)).toHaveLength(1);
  });

  it("legge Atom, dove il link sta nell'attributo href", () => {
    const items = parseRssFeed(ATOM_FIXTURE, "vincimi", "https://www.esempio.it/feed", 10);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Vinci un viaggio a New York",
      url: "https://www.esempio.it/concorsi/new-york?utm_source=feed",
      summary: "Partecipa gratis entro il 30 novembre.",
      publishedAt: "2026-10-14T07:30:00.000Z",
    });
  });
});

describe("parseGoogleNewsFeed", () => {
  it("toglie il suffisso della testata dal titolo", () => {
    const items = parseGoogleNewsFeed(GOOGLE_NEWS_FIXTURE, "news-giftcard", 10);

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Concorso Esselunga: buoni spesa da 1.000 euro");
    expect(items[0].url).toBe("https://news.google.com/rss/articles/CBMiabc?oc=5");
    expect(items[0].guid).toBe("CBMiabc");
    expect(items[0].publishedAt).toBe("2026-10-15T08:12:00.000Z");
  });
});

describe("titleFromUrl", () => {
  it("ricava un titolo leggibile dallo slug", () => {
    expect(titleFromUrl("https://www.x.it/concorsi-a-premi/concorso-esselunga-buoni-spesa-2026/")).toBe(
      "Concorso Esselunga Buoni Spesa 2026",
    );
    expect(titleFromUrl("https://www.x.it/raccolta-punti-2027")).toBe("Raccolta Punti 2027");
    // Segmento generico → ripiega sull'host.
    expect(titleFromUrl("https://www.esempio.it/promozioni/")).toBe("esempio.it");
    // Slug duplicato di WordPress.
    expect(titleFromUrl("https://www.x.it/concorsi/vinci-gift-card-2/")).toBe("Vinci Gift Card");
  });
});

describe("parseSitemap", () => {
  it("raccoglie le sitemap figlie da un sitemapindex", () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://www.scontrinofelice.it/concorsi-gratuiti-sitemap.xml</loc><lastmod>2026-10-15T06:00:00+00:00</lastmod></sitemap>
      <sitemap><loc>https://www.scontrinofelice.it/page-sitemap.xml</loc></sitemap>
    </sitemapindex>`;

    const parsed = parseSitemap(xml, "sitemap-scontrinofelice", "/concorsi-/", 10);

    expect(parsed.items).toHaveLength(0);
    expect(parsed.childSitemaps).toEqual([
      "https://www.scontrinofelice.it/concorsi-gratuiti-sitemap.xml",
      "https://www.scontrinofelice.it/page-sitemap.xml",
    ]);
  });

  it("filtra le entry di un urlset con includePattern", () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://www.scontrinofelice.it/concorsi-con-acquisto/vinci-buoni-amazon/</loc><lastmod>2026-10-15</lastmod></url>
      <url><loc>https://www.scontrinofelice.it/chi-siamo/</loc></url>
    </urlset>`;

    const parsed = parseSitemap(xml, "sitemap-scontrinofelice", "/concorsi-(con-acquisto|gratuiti)/", 10);

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      url: "https://www.scontrinofelice.it/concorsi-con-acquisto/vinci-buoni-amazon/",
      title: "Vinci Buoni Amazon",
      publishedAt: "2026-10-15T00:00:00.000Z",
    });
  });

  it("tiene le pagine più recenti, non le prime del file", () => {
    // Le sitemap dei siti veri elencano dalla più vecchia: con un tetto di 20
    // pagine, prendere le prime venti vuol dire leggere il 2023 e non vedere mai
    // quello uscito ieri. L'ordine si decide sulla data, non sulla posizione.
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://www.aiafood.com/it/concorsi/vinci-con-spinacine-aia/</loc><lastmod>2023-07-05T14:48:18.110Z</lastmod></url>
      <url><loc>https://www.aiafood.com/it/concorsi/dal-15-ottobre-al-1-novembre-2026-vinci-un-barbecue/</loc><lastmod>2026-10-15T08:54:51.445Z</lastmod></url>
      <url><loc>https://www.aiafood.com/it/concorsi/concorso-carne-al-fuoco-2026/</loc><lastmod>2026-03-30T08:19:25.068Z</lastmod></url>
      <url><loc>https://www.aiafood.com/it/ricette/</loc><lastmod>2026-10-16T00:00:00.000Z</lastmod></url>
    </urlset>`;

    const parsed = parseSitemap(xml, "sitemap-aia", "/concorsi/[a-z0-9]", 2);

    expect(parsed.items.map((item) => item.url)).toEqual([
      "https://www.aiafood.com/it/concorsi/dal-15-ottobre-al-1-novembre-2026-vinci-un-barbecue/",
      "https://www.aiafood.com/it/concorsi/concorso-carne-al-fuoco-2026/",
    ]);
  });

  it("senza lastmod resta l'ordine del file, e chi non ha la data va in coda", () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://www.scontrinofelice.it/concorsi-gratuiti/primo-senza-data/</loc></url>
      <url><loc>https://www.scontrinofelice.it/concorsi-gratuiti/con-la-data/</loc><lastmod>2026-10-15</lastmod></url>
      <url><loc>https://www.scontrinofelice.it/concorsi-gratuiti/secondo-senza-data/</loc></url>
    </urlset>`;

    const parsed = parseSitemap(xml, "sitemap-scontrinofelice", "/concorsi-gratuiti/", 5);

    // Una data è un'informazione, non un'ipotesi: chi ce l'ha sta davanti.
    expect(parsed.items.map((item) => item.url)).toEqual([
      "https://www.scontrinofelice.it/concorsi-gratuiti/con-la-data/",
      "https://www.scontrinofelice.it/concorsi-gratuiti/primo-senza-data/",
      "https://www.scontrinofelice.it/concorsi-gratuiti/secondo-senza-data/",
    ]);
  });
});

describe("parseHtmlLinks", () => {
  const html = `<div class="lista">
    <a href="/concorsi-a-premi/concorso-natale-2026/">Concorso di Natale 2026: vinci un'auto</a>
    <a href="/concorsi-a-premi/concorso-natale-2026/">Concorso di Natale 2026: vinci un'auto</a>
    <a href="/concorsi-a-premi/vinci-gift-card-100-euro/">Vinci una gift card da 100 euro</a>
    <a href="#top">Torna su, scorri la pagina</a>
    <a href="mailto:info@x.it">Scrivici una email</a>
    <a href="javascript:void(0)">Apri il dettaglio del concorso</a>
    <a href="/chi-siamo/">Chi siamo e cosa facciamo</a>
    <a href="/">Home</a>
  </div>`;

  it("risolve i link relativi, filtra e deduplica", () => {
    const items = parseHtmlLinks(html, "lista", "https://www.x.it/promozioni/", "/concorsi-a-premi/[a-z0-9-]+", 20);

    expect(items.map((item) => item.url)).toEqual([
      "https://www.x.it/concorsi-a-premi/concorso-natale-2026/",
      "https://www.x.it/concorsi-a-premi/vinci-gift-card-100-euro/",
    ]);
    expect(items[0].title).toBe("Concorso di Natale 2026: vinci un'auto");
  });

  it("scarta mailto, javascript, ancore e titoli troppo corti", () => {
    const items = parseHtmlLinks(html, "lista", "https://www.x.it/", null, 20);
    const urls = items.map((item) => item.url);

    expect(urls.some((url) => url.startsWith("mailto") || url.startsWith("javascript"))).toBe(false);
    expect(urls).not.toContain("https://www.x.it/#top");
    expect(items.every((item) => item.title.length >= 8)).toBe(true);
  });
});

describe("ingestSource", () => {
  it("normalizza una fonte RSS e conserva l'ETag", async () => {
    const fetcher = makeFetcher({
      "https://www.premieconcorsi.com/rss.php": { body: RSS_FIXTURE, headers: { etag: '"etag-1"' } },
    });

    const result = await ingestSource(
      source({ id: "premieconcorsi", kind: "rss", url: "https://www.premieconcorsi.com/rss.php" }),
      { store: makeStore(), fetcher, userAgent: "test" },
      NOW,
    );

    expect(result).toMatchObject({ httpStatus: 200, notModified: false, robotsDenied: false, error: null, etag: '"etag-1"' });
    expect(result.items).toHaveLength(2);
  });

  it("su 304 segnala notModified e non restituisce item", async () => {
    const fetcher = makeFetcher({ "https://www.x.it/feed": { status: 304 } });

    const result = await ingestSource(
      source({ id: "x", kind: "rss", url: "https://www.x.it/feed", etag: '"v1"' }),
      { store: makeStore(), fetcher, userAgent: "test" },
      NOW,
    );

    expect(result.notModified).toBe(true);
    expect(result.items).toHaveLength(0);
    expect(result.error).toBeNull();
  });

  it("su errore HTTP restituisce lo stato e nessun item", async () => {
    const fetcher = makeFetcher({ "https://www.x.it/feed": { status: 404 } });

    const result = await ingestSource(
      source({ id: "x", kind: "rss", url: "https://www.x.it/feed" }),
      { store: makeStore(), fetcher, userAgent: "test" },
      NOW,
    );

    expect(result.httpStatus).toBe(404);
    expect(result.error).toContain("404");
    expect(result.items).toHaveLength(0);
  });

  it("non applica robots.txt ai feed RSS", async () => {
    const fetcher = makeFetcher({
      "https://www.x.it/robots.txt": { body: "User-agent: *\nDisallow: /\n" },
      "https://www.x.it/feed": { body: RSS_FIXTURE },
    });

    const result = await ingestSource(
      source({ id: "x", kind: "rss", url: "https://www.x.it/feed" }),
      { store: makeStore(), fetcher, userAgent: "test" },
      NOW,
    );

    expect(result.robotsDenied).toBe(false);
    expect(result.items).toHaveLength(2);
  });

  it("blocca una pagina HTML vietata da robots.txt e non la scarica", async () => {
    const saveRobots = vi.fn(async () => undefined);
    const fetcher = makeFetcher({
      "https://www.x.it/robots.txt": { body: "User-agent: *\nDisallow: /concorsi\n" },
      "https://www.x.it/concorsi/albero-di-natale/": { body: "<a href='/x'>non deve essere letto</a>" },
    });

    const result = await ingestSource(
      source({ id: "lista", kind: "html", url: "https://www.x.it/concorsi/albero-di-natale/" }),
      { store: makeStore({ saveRobots }), fetcher, userAgent: "test" },
      NOW,
    );

    expect(result.robotsDenied).toBe(true);
    expect(result.items).toHaveLength(0);
    expect(result.httpStatus).toBeNull();
    expect(saveRobots).toHaveBeenCalledTimes(1);
  });

  it("legge una lista HTML quando robots.txt non la vieta", async () => {
    const fetcher = makeFetcher({
      "https://www.x.it/robots.txt": { body: "User-agent: *\nDisallow: /admin\n" },
      "https://www.x.it/concorsi/": {
        body: "<a href='/concorsi-a-premi/vinci-gift-card-100-euro/'>Vinci una gift card da 100 euro</a>",
      },
    });

    const result = await ingestSource(
      source({ id: "lista", kind: "html", url: "https://www.x.it/concorsi/", includePattern: "/concorsi-a-premi/" }),
      { store: makeStore(), fetcher, userAgent: "test" },
      NOW,
    );

    expect(result.robotsDenied).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Vinci una gift card da 100 euro");
  });

  it("segue le sitemap figlie di un indice", async () => {
    const index = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://www.x.it/concorsi-sitemap.xml</loc></sitemap>
      <sitemap><loc>https://www.x.it/page-sitemap.xml</loc></sitemap>
    </sitemapindex>`;
    const child = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://www.x.it/concorsi-a-premi/vinci-buoni-spesa/</loc></url>
    </urlset>`;
    const fetcher = makeFetcher({
      "https://www.x.it/robots.txt": { status: 404 },
      "https://www.x.it/sitemap.xml": { body: index },
      "https://www.x.it/concorsi-sitemap.xml": { body: child },
      "https://www.x.it/page-sitemap.xml": { body: "<urlset></urlset>" },
    });

    const result = await ingestSource(
      source({ id: "sitemap-x", kind: "sitemap", url: "https://www.x.it/sitemap.xml", includePattern: "/concorsi-a-premi/" }),
      { store: makeStore(), fetcher, userAgent: "test" },
      NOW,
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Vinci Buoni Spesa");
  });
});

/**
 * Le due sitemap spendi-e-riprendi delle insegne: configurate, verificate e
 * spente (vedi src/config/sources.ts). Il test fissa il PATTERN sulle pagine
 * misurate il 17/10/2026, perché è l'unica parte che non si può riverificare
 * senza rete, e quella che, se sbagliata, fa entrare il catalogo.
 */
describe("sitemap spendi-e-riprendi delle insegne", () => {
  const fonte = (id: string) => {
    const config = SOURCES.find((source) => source.id === id);
    if (!config) throw new Error(`fonte assente: ${id}`);
    return config;
  };

  it("sono coupon, di tipo sitemap, e restano spente finché non c'è una campagna fresca", () => {
    for (const id of ["sitemap-conad-spendi", "sitemap-carrefour-spendi"]) {
      expect(fonte(id).kind).toBe("sitemap");
      expect(fonte(id).category).toBe("coupon");
      expect(fonte(id).enabled).toBe(false);
    }
  });

  it("Conad: prende le spendi-e-riprendi e le ti-rendiamo-la-metà di ogni circuito", () => {
    const pattern = fonte("sitemap-conad-spendi").includePattern ?? null;
    const campagne = [
      "https://www.conad.it/landing-page-ccn/spendi_e_riprendi",
      "https://www.conad.it/landing-page-ccn/Spendieriprendi",
      "https://www.conad.it/landing-page-ccn/spendieriprendispazio",
      "https://www.conad.it/landing-page-ccn/tirendiamolametasettembre",
      "https://www.conad.it/landing-page-dao/cashback-conad",
    ];
    for (const url of campagne) expect(matchesPattern(url, pattern)).toBe(true);

    // Il catalogo non è una campagna: concorsi, raccolte punti e volantini.
    const catalogo = [
      "https://www.conad.it/landing-page-ccn/Concorso60",
      "https://www.conad.it/landing-page-ccn/catalogo-mdd",
      "https://www.conad.it/landing-page-cia/collezione-bicchieri-disney",
      "https://www.conad.it/landing-page-pac2000a/sfoglia-i-nuovi-volantini-conad-lazio",
      "https://www.conad.it/carte-e-premi/collezioni-e-concorsi/thun",
    ];
    for (const url of catalogo) expect(matchesPattern(url, pattern)).toBe(false);
  });

  it("Carrefour: prende le due forme di slug e non l'elenco promozioni", () => {
    const pattern = fonte("sitemap-carrefour-spendi").includePattern ?? null;
    const campagne = [
      "https://www.carrefour.it/spendi-e-riprendi/ortofrutta.html",
      "https://www.carrefour.it/spendi-riprendi-uova-di-pasqua.html",
      "https://www.carrefour.it/landing/spendi-riprendi-pescheria.html",
    ];
    for (const url of campagne) expect(matchesPattern(url, pattern)).toBe(true);
    expect(matchesPattern("https://www.carrefour.it/spesa-online/promozioni-weekend.html", pattern)).toBe(false);
    expect(matchesPattern("https://www.carrefour.it/p/poltrona-nuvola.html", pattern)).toBe(false);
  });
});
