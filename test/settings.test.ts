import { describe, expect, it } from "vitest";
import type { Prefs } from "../src/types.ts";
import { defaultFilters } from "../src/filters.ts";
import {
  DIGEST_HOURS,
  SCORE_MAX,
  SCORE_MIN,
  hourLabel,
  hourShort,
  parseQuietRange,
  quietRange,
  shiftQuietRange,
  stepScore,
  toggleDigestHour,
} from "../src/telegram/prefs-config.ts";

/**
 * Le regole delle impostazioni fini, senza chat e senza bottoni: qui si verifica
 * il calcolo — di quanto si sposta una soglia, dove finisce un cursore che gira
 * sulla giornata, cosa succede accendendo un'ora del digest.
 *
 * Importa perché: gli stessi numeri li usano la tastiera (per scrivere il valore
 * sul bottone) e il router (per accettarlo). Se qui il conto è giusto, un bottone
 * disegnato non può essere scartato al tocco.
 */

function prefs(quietHours: string): Prefs {
  return {
    chatId: 1,
    active: true,
    weights: {},
    minScoreInstant: 80,
    quietHours,
    digestHours: [8, 19],
    instantAlerts: true,
    filters: defaultFilters(),
  };
}

describe("impostazioni · soglia degli avvisi immediati", () => {
  it("si sposta di cinque punti per volta", () => {
    expect(stepScore(80, 1)).toBe(85);
    expect(stepScore(80, -1)).toBe(75);
    expect(stepScore(0, 1)).toBe(SCORE_MIN + 5);
  });

  it("si ferma ai bordi: 0 e 100 non si superano", () => {
    expect(stepScore(SCORE_MAX, 1)).toBe(SCORE_MAX);
    expect(stepScore(SCORE_MIN, -1)).toBe(SCORE_MIN);
    // Anche partendo da un valore storto (archivio vecchio, modifica a mano).
    expect(stepScore(3, -1)).toBe(SCORE_MIN);
    expect(stepScore(98, 1)).toBe(SCORE_MAX);
  });
});

describe("impostazioni · fascia di silenzio", () => {
  it("legge le fasce vere e rifiuta il resto", () => {
    expect(parseQuietRange("23-7")).toEqual({ start: 23, end: 7 });
    expect(parseQuietRange(" 23 - 07 ")).toEqual({ start: 23, end: 7 });
    expect(parseQuietRange("0-0")).toEqual({ start: 0, end: 0 });
    expect(parseQuietRange("")).toBeNull();
    expect(parseQuietRange("off")).toBeNull();
    expect(parseQuietRange("99-99")).toBeNull();
    expect(parseQuietRange("7-33")).toBeNull();
    expect(parseQuietRange("23:00-7:00")).toBeNull();
  });

  it("con il silenzio spento i cursori partono dalla fascia solita", () => {
    expect(quietRange(prefs(""))).toEqual({ start: 23, end: 7 });
    expect(quietRange(prefs("niente"))).toEqual({ start: 23, end: 7 });
    expect(quietRange(prefs("22-8"))).toEqual({ start: 22, end: 8 });
  });

  it("sposta un estremo per volta, e gira sulla giornata", () => {
    expect(shiftQuietRange({ start: 23, end: 7 }, "start", 1)).toBe("0-7");
    expect(shiftQuietRange({ start: 0, end: 7 }, "start", -1)).toBe("23-7");
    expect(shiftQuietRange({ start: 23, end: 7 }, "end", 1)).toBe("23-8");
    expect(shiftQuietRange({ start: 23, end: 0 }, "end", -1)).toBe("23-23");
  });

  it("nessun tocco dei cursori può produrre una fascia che il router rifiuta", () => {
    for (let ora = 0; ora < 24; ora++) {
      const fascia = { start: ora, end: (ora + 8) % 24 };
      for (const which of ["start", "end"] as const) {
        for (const delta of [-1, 1]) {
          expect(parseQuietRange(shiftQuietRange(fascia, which, delta))).not.toBeNull();
        }
      }
    }
  });
});

describe("impostazioni · ore del digest", () => {
  it("accende un'ora tenendo l'elenco in ordine", () => {
    expect(toggleDigestHour([8, 19], 9)).toEqual([8, 9, 19]);
    expect(toggleDigestHour([8, 9, 19], 21)).toEqual([8, 9, 19, 21]);
  });

  it("la stessa ora la spegne: è un interruttore, non una scelta", () => {
    expect(toggleDigestHour([8, 19], 8)).toEqual([19]);
    // L'ultima ora spenta lascia l'elenco vuoto: è il "digest spenti" delle impostazioni.
    expect(toggleDigestHour([8], 8)).toEqual([]);
  });

  it("offre tutte le ventiquattr'ore, una per volta", () => {
    expect(DIGEST_HOURS).toHaveLength(24);
    for (const hour of DIGEST_HOURS) {
      expect(toggleDigestHour([], hour)).toEqual([hour]);
      expect(toggleDigestHour([hour], hour)).toEqual([]);
    }
  });

  it("scrive le ore a due cifre", () => {
    expect(hourLabel(9)).toBe("09:00");
    expect(hourLabel(19)).toBe("19:00");
    expect(hourShort(9)).toBe("09");
    expect(hourShort(19)).toBe("19");
  });
});
