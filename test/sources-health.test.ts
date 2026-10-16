import { describe, expect, it } from "vitest";
import type { SourceRow } from "../src/types.ts";
import type { SourceStat } from "../src/db/store.ts";
import {
  ESAURITA_DA_MS,
  GRUPPI_DIAGNOSI,
  NON_PROVATA_DA_MS,
  ROTTA_DA_FALLIMENTI,
  diagnosiFonti,
  diagnosiFonte,
  fonteStat,
  riepilogoDiagnosi,
} from "../src/sources-health.ts";

/**
 * La diagnostica delle fonti: quali valgono e quali no.
 *
 * Sono regole pure, quindi qui si verificano i casi che in chat si vedono una
 * volta ogni tanto ma che devono uscire giusti al primo colpo: la fonte che
 * fallisce da tre giri, quella che risponde leggendo venti item di catalogo,
 * quella che vede tutto e non trova mai niente per prima. E, all'opposto, due
 * casi in cui NON si tocca niente: una fonte mai provata e una che non viene
 * provata da giorni non sono fonti inutili.
 */

/** 20/11/2026 10:00, come gli altri test del progetto. */
const NOW = new Date("2026-11-20T10:00:00.000Z");

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "premieconcorsi",
    name: "Premi e Concorsi",
    kind: "rss",
    url: "https://www.premieconcorsi.com/rss.php",
    category: "online",
    tags: ["aggregatore"],
    cadenceMin: 30,
    enabled: true,
    etag: null,
    lastModified: null,
    lastRunAt: "2026-11-20T09:00:00.000Z",
    lastOkAt: "2026-11-20T09:00:00.000Z",
    failStreak: 0,
    lastStatus: 200,
    lastError: null,
    lastItems: 25,
    ...overrides,
  };
}

function stat(overrides: Partial<SourceStat> = {}): SourceStat {
  return { offers: 5, lastOfferAt: "2026-11-19T08:00:00.000Z", sightings: 5, discarded: 0, ...overrides };
}

describe("diagnostica · fonti che falliscono", () => {
  it("tre giri di fila a vuoto sono una fonte rotta", () => {
    const voce = diagnosiFonte(
      source({ failStreak: ROTTA_DA_FALLIMENTI, lastStatus: 403, lastError: "HTTP 403", lastOkAt: "2026-11-18T09:00:00.000Z" }),
      stat(),
      NOW,
    );
    expect(voce.esito).toBe("rotta");
    expect(voce.emoji).toBe("🔴");
    expect(voce.gravita).toBe(0);
    expect(voce.motivo).toContain("3 giri di fila a vuoto");
    expect(voce.motivo).toContain("HTTP 403");
    expect(voce.consiglio).toContain("sources.ts");
  });

  it("un solo giro fallito è un avviso, non un verdetto", () => {
    const voce = diagnosiFonte(source({ failStreak: 1, lastStatus: 503, lastError: "HTTP 503" }), stat(), NOW);
    expect(voce.esito).toBe("rotta");
    expect(voce.emoji).toBe("🟠");
    expect(voce.gravita).toBe(1);
    expect(voce.motivo).toContain("l'ultimo giro è fallito");
  });

  it("un fallimento senza codice né messaggio non si racconta come un successo", () => {
    // Archivio non ancora migrato: la fonte ha fallito ma non c'è niente da
    // citare. Il vocabolario condiviso, da solo, direbbe "ok" — e per una fonte
    // che ha appena fallito sarebbe falso.
    const voce = diagnosiFonte(
      source({ failStreak: 4, lastStatus: null, lastError: null, lastOkAt: "2026-11-19T09:00:00.000Z" }),
      stat(),
      NOW,
    );
    expect(voce.esito).toBe("rotta");
    expect(voce.motivo).toContain("4 giri di fila a vuoto · motivo non registrato");
    expect(voce.motivo).not.toContain("ok");
  });

  it("una fonte che non risponde ma non ha mai portato niente resta \"rotta\"", () => {
    // Il guasto spiega anche il resto: non si dice \"non porta concorsi\" di una
    // fonte che non risponde da tre giri.
    const voce = diagnosiFonte(
      source({ failStreak: 4, lastStatus: 403, lastError: "HTTP 403" }),
      stat({ offers: 0, lastOfferAt: null, sightings: 0 }),
      NOW,
    );
    expect(voce.esito).toBe("rotta");
  });
});

describe("diagnostica · fonti che rispondono e non portano concorsi", () => {
  it("legge item e non ne passa nessuno: il pattern è sbagliato", () => {
    const voce = diagnosiFonte(source({ lastItems: 20 }), stat({ offers: 0, lastOfferAt: null, sightings: 0 }), NOW);
    expect(voce.esito).toBe("muta");
    expect(voce.motivo).toContain("20 item");
    expect(voce.consiglio).toContain("pattern");
  });

  it("porta solo pagine scartate: è un catalogo, non un elenco di concorsi", () => {
    const voce = diagnosiFonte(
      source({ id: "sitemap-conad", lastItems: 20 }),
      stat({ offers: 0, lastOfferAt: null, sightings: 0, discarded: 12 }),
      NOW,
    );
    expect(voce.esito).toBe("catalogo");
    expect(voce.motivo).toContain("12 pagine scartate");
    expect(voce.consiglio).toContain("includePattern");
  });

  it("una fonte che scarta tutto non \"ripete\": porta catalogo", () => {
    // Una vista e una scartata: non ha visto nessun concorso, ha visto una pagina
    // che il cancello ha buttato. Contare le viste scartate come concorsi visti la
    // faceva finire fra quelle che ripetono gli altri, che è un'altra cosa.
    const voce = diagnosiFonte(
      source({ id: "sitemap-aia", lastItems: 1 }),
      stat({ offers: 0, lastOfferAt: null, sightings: 1, discarded: 1 }),
      NOW,
    );
    expect(voce.esito).toBe("catalogo");
    expect(voce.motivo).toContain("una pagina scartata");
  });

  it("conta le viste utili, non tutte: due scartate su cinque lasciano tre concorsi visti", () => {
    const voce = diagnosiFonte(
      source({ lastItems: 25 }),
      stat({ offers: 0, lastOfferAt: null, sightings: 5, discarded: 2 }),
      NOW,
    );
    expect(voce.esito).toBe("ripete");
    expect(voce.motivo).toContain("ha visto 3 concorsi");
  });

  it("vede concorsi che ha già trovato qualcun altro: ripete e basta", () => {
    const voce = diagnosiFonte(
      source({ lastItems: 25 }),
      stat({ offers: 0, lastOfferAt: null, sightings: 9 }),
      NOW,
    );
    expect(voce.esito).toBe("ripete");
    expect(voce.motivo).toContain("ha visto 9 concorsi");
    expect(voce.consiglio).toContain("conferma");
  });

  it("risponde e non ha mai portato niente", () => {
    const voce = diagnosiFonte(
      source({ lastItems: 0, lastStatus: 304 }),
      stat({ offers: 0, lastOfferAt: null, sightings: 0 }),
      NOW,
    );
    expect(voce.esito).toBe("vuota");
    expect(voce.motivo).toContain("mai portato un concorso");
  });

  it("chi ha portato concorsi non viene giudicato per l'ultimo giro vuoto", () => {
    // 20 item letti adesso e zero scartate, ma 5 concorsi in archivio: la fonte
    // lavora, il giro vuoto è fisiologico.
    const voce = diagnosiFonte(source({ lastItems: 0 }), stat(), NOW);
    expect(voce.esito).toBe("utile");
  });
});

describe("diagnostica · fonti esaurite e non provate", () => {
  it("nessun concorso nuovo da più di un mese", () => {
    const voce = diagnosiFonte(
      source(),
      stat({ offers: 3, lastOfferAt: new Date(NOW.getTime() - ESAURITA_DA_MS - 86_400_000).toISOString() }),
      NOW,
    );
    expect(voce.esito).toBe("esaurita");
    expect(voce.emoji).toBe("🟡");
    expect(voce.motivo).toContain("nessun concorso nuovo da");
    expect(voce.consiglio).toContain("sostituisci");
  });

  it("una fonte fresca non è esaurita", () => {
    expect(diagnosiFonte(source(), stat(), NOW).esito).toBe("utile");
  });

  it("la rotazione non la raggiunge: si dice, ma non è un motivo per toglierla", () => {
    const voce = diagnosiFonte(
      source({ lastRunAt: new Date(NOW.getTime() - NON_PROVATA_DA_MS - 3_600_000).toISOString() }),
      stat(),
      NOW,
    );
    expect(voce.esito).toBe("non-provata");
    expect(voce.emoji).toBe("⚪️");
    expect(voce.consiglio.toLowerCase()).toContain("motivo per toglierla");
  });

  it("mai provata: aspetta un giro, qualunque sia il suo contributo", () => {
    // L'ordine delle regole conta: senza il controllo su lastRunAt, una fonte mai
    // provata finirebbe fra quelle \"che non portano concorsi\".
    const voce = diagnosiFonte(
      source({ lastRunAt: null, lastOkAt: null, lastItems: 0 }),
      stat({ offers: 0, lastOfferAt: null, sightings: 0 }),
      NOW,
    );
    expect(voce.esito).toBe("mai-provata");
    expect(voce.consiglio).toContain("Aspetta");
  });
});

describe("diagnostica · una fonte di coupon si giudica sui coupon", () => {
  it("conta i coupon che ha portato, non i concorsi che non ha portato", () => {
    // Il caso vero: i tre siti di buoni sconto non portano NESSUN concorso, ed è
    // il loro mestiere. Dire "non ha mai portato un concorso" di una di loro
    // sarebbe vero e inutile, e spingerebbe a togliere la fonte che funziona.
    const voce = diagnosiFonte(
      source({ id: "scontrinofelice-coupon", name: "Scontrino Felice · buoni sconto", category: "coupon" }),
      stat({ offers: 6, lastOfferAt: "2026-11-19T08:00:00.000Z" }),
      NOW,
    );
    expect(voce.esito).toBe("utile");
    expect(voce.motivo).toContain("6 coupon in archivio");
    expect(voce.motivo).not.toContain("concors");
  });

  it("una fonte di coupon che non porta niente si giudica con le sue parole", () => {
    const voce = diagnosiFonte(
      source({ id: "scontrinofelice-coupon", name: "Scontrino Felice · buoni sconto", category: "coupon", lastItems: 0 }),
      stat({ offers: 0, lastOfferAt: null, sightings: 0 }),
      NOW,
    );
    expect(voce.esito).toBe("vuota");
    expect(voce.motivo).toContain("non ha mai portato un coupon");
  });

  it("legge item e non ne passa nessuno: lo dice con la parola giusta", () => {
    const voce = diagnosiFonte(
      source({ id: "scontomaggio-coupon", name: "scontOmaggio · buoni sconto", category: "coupon", lastItems: 16 }),
      stat({ offers: 0, lastOfferAt: null, sightings: 0 }),
      NOW,
    );
    expect(voce.esito).toBe("muta");
    expect(voce.motivo).toContain("16 item e nessuno è diventato un coupon");
  });

  it("il singolare di un coupon è \"un coupon\"", () => {
    const voce = diagnosiFonte(
      source({ id: "scontrinofelice-coupon", name: "Buoni sconto", category: "coupon" }),
      stat({ offers: 1, lastOfferAt: "2026-11-19T08:00:00.000Z" }),
      NOW,
    );
    expect(voce.motivo).toContain("un coupon in archivio");
  });
});

describe("diagnostica · elenco, gruppi e riepilogo", () => {
  const rotta = source({ id: "dimmicosacerchi", name: "DimmiCosaCerchi", failStreak: 3, lastStatus: 403, lastError: "HTTP 403" });
  const catalogo = source({ id: "sitemap-conad", name: "Conad", lastItems: 20 });
  const utile = source({ id: "scontrinofelice-acquisto", name: "Scontrino Felice" });
  const spenta = source({ id: "vincimi", name: "Vincimi", enabled: false });

  it("guarda solo le fonti accese e mette per prime le peggiori", () => {
    const diagnosi = diagnosiFonti(
      [utile, spenta, rotta, catalogo],
      {
        dimmicosacerchi: stat({ offers: 0, lastOfferAt: null, sightings: 0 }),
        "sitemap-conad": stat({ offers: 0, lastOfferAt: null, sightings: 0, discarded: 12 }),
        "scontrinofelice-acquisto": stat(),
      },
      NOW,
    );
    expect(diagnosi.map((voce) => voce.source.id)).toEqual([rotta.id, catalogo.id, utile.id]);
    expect(diagnosi.map((voce) => voce.esito)).toEqual(["rotta", "catalogo", "utile"]);
  });

  it("a parità di gravità viene prima chi ha reso meno", () => {
    const poche = source({ id: "poche", name: "Poche" });
    const zero = source({ id: "zero", name: "Zero" });
    const diagnosi = diagnosiFonti(
      [poche, zero],
      { poche: stat({ offers: 2 }), zero: stat({ offers: 0, lastOfferAt: null }) },
      NOW,
    );
    // Stessa gravità (entrambe "esaurite" o "utili"): l'ordine è per contributo.
    expect(diagnosi[0]?.source.id).toBe("zero");
  });

  it("conta accese, utili e da guardare", () => {
    const diagnosi = diagnosiFonti(
      [utile, rotta, catalogo],
      {
        dimmicosacerchi: stat({ offers: 0, lastOfferAt: null, sightings: 0 }),
        "sitemap-conad": stat({ offers: 0, lastOfferAt: null, sightings: 0, discarded: 3 }),
        "scontrinofelice-acquisto": stat(),
      },
      NOW,
    );
    expect(riepilogoDiagnosi(diagnosi)).toEqual({ accese: 3, utili: 1, rotte: 1, daGuardare: 2 });
  });

  it("le fonti che non vengono provate non gonfiano il numero da guardare", () => {
    const diagnosi = diagnosiFonti([source({ lastRunAt: null, lastOkAt: null })], {}, NOW);
    expect(riepilogoDiagnosi(diagnosi).daGuardare).toBe(0);
  });

  it("ogni verdetto ha un gruppo, tranne \"utile\" che è contato in testa", () => {
    const conGruppo = new Set(GRUPPI_DIAGNOSI.flatMap((gruppo) => gruppo.esiti));
    for (const esito of ["rotta", "catalogo", "muta", "vuota", "ripete", "esaurita", "mai-provata", "non-provata"] as const) {
      expect(conGruppo.has(esito)).toBe(true);
    }
    expect(conGruppo.has("utile")).toBe(false);
  });

  it("una fonte che non compare nell'archivio ha un contributo a zero, non \"non lo so\"", () => {
    expect(fonteStat({}, "mai-vista")).toEqual({ offers: 0, lastOfferAt: null, sightings: 0, discarded: 0 });
  });
});
