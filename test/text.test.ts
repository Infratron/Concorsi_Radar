import { describe, expect, it } from "vitest";
import {
  DUP_CANDIDATE_MAX_HAMMING,
  canonicalUrl,
  decodeEntities,
  hammingHex,
  isDuplicateTitle,
  jaccard,
  normalizeTitle,
  simhash,
  slugify,
  stripBoilerplate,
  stripHtml,
  stripSourceTokens,
  tokens,
  truncate,
  urlKey,
} from "../src/lib/text.ts";

describe("URL canonico e chiave", () => {
  it("toglie tracking, www, hash e slash finale", () => {
    expect(canonicalUrl("https://www.Esselunga.com/concorsi/vinci/?utm_source=x&fbclid=1#premi")).toBe(
      "https://esselunga.com/concorsi/vinci",
    );
  });

  it("ordina i parametri rimasti, così l'ordine non cambia la chiave", () => {
    expect(canonicalUrl("https://a.example/p?b=2&a=1")).toBe(canonicalUrl("https://a.example/p?a=1&b=2"));
  });

  it("risolve gli URL relativi", () => {
    expect(canonicalUrl("/p/1", "https://a.example/feed")).toBe("https://a.example/p/1");
  });

  it("lascia intatto un URL non valido invece di lanciare", () => {
    expect(canonicalUrl("non-un-url")).toBe("non-un-url");
  });

  it("la chiave è stabile tra varianti di tracking e diversa per pagine diverse", () => {
    const a = urlKey(canonicalUrl("https://a.example/concorso?utm_medium=email"));
    const b = urlKey(canonicalUrl("https://a.example/concorso"));
    const c = urlKey(canonicalUrl("https://a.example/altro-concorso"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // 64 bit in esadecimale: due half FNV-1a accostati, senza dipendenze crypto.
    expect(a).toHaveLength(16);
  });
});

describe("normalizzazione del testo", () => {
  it("decodifica entità nominali e numeriche, compreso l'euro", () => {
    expect(decodeEntities("Costa 500&euro; oggi")).toBe("Costa 500€ oggi");
    expect(decodeEntities("Costa 500&#8364; oggi")).toBe("Costa 500€ oggi");
    expect(decodeEntities("a&nbsp;b &amp; c")).toBe("a b & c");
  });

  it("lascia stare un'entità sconosciuta", () => {
    expect(decodeEntities("&pippo;")).toBe("&pippo;");
  });

  it("toglie i tag e gli script", () => {
    expect(stripHtml("<p>Ciao <b>mondo</b></p>")).toBe("Ciao mondo");
    expect(stripHtml("Prima<script>alert('no')</script>Dopo")).toBe("Prima Dopo");
  });

  it("normalizza il titolo togliendo stopword, diacritici e separatori di migliaia", () => {
    expect(normalizeTitle("Vinci un Buono Spesa da 1.000 € con  Caffè!")).toBe("vinci buono spesa 1000 caffe");
  });

  it("rimuove il boilerplate degli aggregatori", () => {
    const testo = "Concorso Condor: vinci un volo per il Messico […] Leggi l'articolo: Concorso Condor";
    expect(stripBoilerplate(testo)).toBe("Concorso Condor: vinci un volo per il Messico");
    expect(stripBoilerplate("Concorso Findus, in palio 500 euro. Continua a leggere sul sito")).toBe(
      "Concorso Findus, in palio 500 euro.",
    );
  });

  it("toglie i token del nome della fonte dal titolo", () => {
    expect(
      stripSourceTokens("Scontrino Felice - Concorso Findus: 1000 euro", "Scontrino Felice · concorsi con acquisto"),
    ).toBe("Concorso Findus: 1000 euro");
    // Anche in coda, con il separatore a staccarlo.
    expect(
      stripSourceTokens("Concorso Findus: 1000 euro - Scontrino Felice", "Scontrino Felice · concorsi con acquisto"),
    ).toBe("Concorso Findus: 1000 euro");
  });

  it("non mangia le parole del titolo che somigliano al nome della fonte", () => {
    // La fonte si chiama "Sammontana · gusta e vinci": la versione precedente
    // toglieva "gusta", "e" e "vinci" ovunque comparissero, e questi due titoli
    // diventavano "Gioca Gardaland" e "E Gardaland Sorrisi Per Tutta La
    // Famiglia" — cioè illeggibili, che è il contrario dello scopo.
    expect(stripSourceTokens("Gusta Gioca Vinci Gardaland", "Sammontana · gusta e vinci")).toBe(
      "Gusta Gioca Vinci Gardaland",
    );
    expect(
      stripSourceTokens("Sammontana E Gardaland Sorrisi Per Tutta La Famiglia", "Sammontana · gusta e vinci"),
    ).toBe("Sammontana E Gardaland Sorrisi Per Tutta La Famiglia");
    // Una parola sola in testa senza separatore è la prima parola del titolo
    // (il brand che si nomina nel proprio titolo), non boilerplate da togliere.
    expect(stripSourceTokens("Cupper vince un weekend", "Cupper")).toBe("Cupper vince un weekend");
  });

  it("non lascia un titolo più corto del dovuto", () => {
    expect(stripSourceTokens("Scontrino Felice", "Scontrino Felice · concorsi con acquisto")).toBe("Scontrino Felice");
    expect(stripSourceTokens("Scontrino Felice - Findus", "Scontrino Felice · concorsi con acquisto")).toBe(
      "Scontrino Felice - Findus",
    );
  });

  it("tronca e normalizza slug", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abc", 5)).toBe("abc");
    expect(slugify("Concorso Caffè & Premi 2026")).toBe("concorso-caffe-premi-2026");
  });
});

describe("similarità", () => {
  it("testi identici hanno distanza zero", () => {
    expect(hammingHex(simhash("Concorso Barilla: vinci una Fiat Panda"), simhash("Concorso Barilla: vinci una Fiat Panda"))).toBe(0);
  });

  it("simhash ha sempre 16 cifre esadecimali", () => {
    expect(simhash("x")).toMatch(/^[0-9a-f]{16}$/);
    expect(simhash("")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("testi di lunghezza diversa non sono confrontabili", () => {
    expect(hammingHex("abcdef", "abcdef12")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("jaccard misura l'insieme dei token", () => {
    expect(jaccard(tokens("concorso barilla fiat panda"), tokens("barilla concorso fiat panda"))).toBe(1);
    expect(jaccard(tokens("concorso barilla"), tokens("concorso kinder"))).toBeCloseTo(0.33, 2);
    expect(jaccard([], [])).toBe(0);
  });

  it("la soglia dei candidati resta più larga della separazione misurata", () => {
    // Misurato sui dati: duplicati veri fino a Hamming 20, concorsi diversi da 8.
    // Il prefilter deve stare sopra i duplicati, il giudice è isDuplicateTitle.
    expect(DUP_CANDIDATE_MAX_HAMMING).toBeGreaterThan(20);
  });
});

describe("isDuplicateTitle · regola calibrata sui dati reali", () => {
  const duplicati: [string, string][] = [
    ["In palio una Fiat Panda con il concorso Barilla, scade il 25 ottobre 2026", "In palio una Fiat Panda con il concorso Barilla"],
    ["Concorso Barilla: vinci una Fiat Panda", "Barilla: vinci una Fiat Panda"],
    ["Raccolta punti Conad: in palio una e-bike", "Conad: raccolta punti e in palio una e-bike"],
    ["Concorso Findus, in palio 1000 euro di buoni spesa", "Concorso Findus: 1000 euro di buoni spesa con scontrino"],
    ["Gift card Amazon da 100 euro: concorso gratuito", "Concorso gratis: gift card Amazon da 100 euro"],
  ];

  const diversi: [string, string][] = [
    ["Concorso Findus: 1000 euro di buoni spesa", "Concorso Findus: 500 euro di buoni spesa"],
    ["Gift card Amazon da 100 euro", "Gift card Amazon da 50 euro"],
    ["Concorso Nutella: vinci un viaggio a Parigi", "Vinci un viaggio a Parigi con il concorso Kinder"],
    ["Vinci un buono spesa da 50 euro con Lidl", "Vinci un buono spesa da 50 euro con Penny"],
    ["Vinci una vacanza in Sardegna", "Vinci una vacanza in Sicilia"],
    ["Vinci un iPhone 16 con WindTre", "Vinci un buono spesa Conad da 100 euro"],
  ];

  for (const [a, b] of duplicati) {
    it(`unisce: "${truncate(a, 40)}" ≈ "${truncate(b, 40)}"`, () => {
      expect(isDuplicateTitle(a, b)).toBe(true);
    });
  }

  for (const [a, b] of diversi) {
    it(`tiene separati: "${truncate(a, 40)}" ≠ "${truncate(b, 40)}"`, () => {
      expect(isDuplicateTitle(a, b)).toBe(false);
    });
  }

  it("con soli termini generici vale l'uguaglianza esatta", () => {
    expect(isDuplicateTitle("Concorso a premi", "Concorso a premi")).toBe(true);
    expect(isDuplicateTitle("Concorso a premi", "Concorso a premi online")).toBe(false);
  });
});
