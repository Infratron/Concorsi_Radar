import { describe, expect, it } from "vitest";
import { readableTitle } from "../src/lib/titles.ts";

/**
 * I titoli che finiscono in chat.
 * I casi qui sotto sono quelli veri dell'archivio del 16/10/2026: un titolo
 * urlato preso dal feed di un aggregatore, due titoli con le parole incollate e
 * l'anno attaccato, e i titoli che invece erano già scritti bene e devono
 * restare identici.
 */

describe("titoli leggibili", () => {
  it("non tocca un titolo già scritto bene", () => {
    expect(readableTitle("Concorso Lievital: vinci Forni e Scaldavivande")).toBe(
      "Concorso Lievital: vinci Forni e Scaldavivande",
    );
    expect(readableTitle("Bevi Coca‑Cola Zero E Vinci Con Gusto")).toBe("Bevi Coca‑Cola Zero E Vinci Con Gusto");
    expect(readableTitle("Vinci con Cupper")).toBe("Vinci con Cupper");
    expect(readableTitle("Saka Mikami a Lucca Comics 2026: come partecipare ai firmacopie")).toBe(
      "Saka Mikami a Lucca Comics 2026: come partecipare ai firmacopie",
    );
  });

  it("rende leggibile un titolo urlato, con le paroline minuscole", () => {
    // Title Case con le paroline italiane minuscole: è la convenzione che regge
    // anche i nomi propri, che da un titolo urlato non si possono distinguere
    // ("PREMIO MULLER" deve diventare "Premio Muller", non "Premio muller").
    expect(readableTitle("LA CACCIA AL TESORO DEL CAPITANO")).toBe("La Caccia al Tesoro del Capitano");
    expect(readableTitle("PREMIO IN PALIO PER TUTTI")).toBe("Premio in Palio per Tutti");
    expect(readableTitle("«IL GRANDE PREMIO»")).toBe("«Il Grande Premio»");
  });

  it("separa lettere e anno attaccati", () => {
    expect(readableTitle("Vinciwonka2026")).toBe("Vinciwonka 2026");
    expect(readableTitle("Vincimomentiinsieme2026")).toBe("Vincimomentiinsieme 2026");
    expect(readableTitle("ŠKODAXFACTOR2026")).toBe("Škodaxfactor 2026");
    expect(readableTitle("Caffè2026")).toBe("Caffè 2026");
  });

  it("separa le parole incollate senza inventarne di nuove", () => {
    expect(readableTitle("GlowWin Beauty")).toBe("Glow Win Beauty");
    // Nessun dizionario: "Vinciwonka" resta una parola sola, ma non più urlata.
    expect(readableTitle("VINCIWONKA")).toBe("Vinciwonka");
  });

  it("non si rompe sui casi vuoti o strani", () => {
    expect(readableTitle("")).toBe("");
    expect(readableTitle("   ")).toBe("");
    expect(readableTitle("  Concorso   Barilla  ")).toBe("Concorso Barilla");
    // Sigle corte: non si giudica se è "urlato", si lascia stare.
    expect(readableTitle("TIM")).toBe("TIM");
  });

  it("è idempotente: applicarla due volte non cambia il risultato", () => {
    const casi = [
      "LA CACCIA AL TESORO DEL CAPITANO",
      "ŠKODAXFACTOR2026",
      "Vinciwonka2026",
      "GlowWin Beauty",
      "Concorso Lievital: vinci Forni e Scaldavivande",
      "«IL GRANDE PREMIO»",
    ];
    for (const caso of casi) {
      const una = readableTitle(caso);
      expect(readableTitle(una)).toBe(una);
    }
  });
});
