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
    // Dopo un trattino comincia una frase nuova: la parolina torna maiuscola.
    expect(readableTitle("KRAFT e MORATO – LA COMBO PERFETTA")).toBe("Kraft e Morato – La Combo Perfetta");
  });

  it("separa lettere e anno attaccati", () => {
    expect(readableTitle("Vinciwonka2026")).toBe("Vinciwonka 2026");
    expect(readableTitle("Vincimomentiinsieme2026")).toBe("Vincimomentiinsieme 2026");
    expect(readableTitle("ŠKODAXFACTOR2026")).toBe("Škodaxfactor 2026");
    expect(readableTitle("Caffè2026")).toBe("Caffè 2026");
  });

  it("non spezza i marchi scritti con la maiuscola in mezzo", () => {
    // Casi reali dell'archivio: la separazione delle parole incollate li
    // trasformava in "In Post", "Kitchen Aid" e "The Fork".
    expect(readableTitle("Concorso gratuito InPost: in palio 12 voucher")).toBe(
      "Concorso gratuito InPost: in palio 12 voucher",
    );
    expect(readableTitle("KitchenAid")).toBe("KitchenAid");
    expect(readableTitle("Gift Card TheFork da 50 Euro")).toBe("Gift Card TheFork da 50 Euro");
    // Nessun dizionario: "Vincimomentiinsieme" resta una parola sola, scritta bene.
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
      "Concorso gratuito InPost: in palio 12 voucher",
      "Concorso Lievital: vinci Forni e Scaldavivande",
      "«IL GRANDE PREMIO»",
    ];
    for (const caso of casi) {
      const una = readableTitle(caso);
      expect(readableTitle(una)).toBe(una);
    }
  });
});
