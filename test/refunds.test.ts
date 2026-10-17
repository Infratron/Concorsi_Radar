import { describe, expect, it } from "vitest";
import {
  formatEuro,
  parseEuroInput,
  refundAmountFor,
  refundAmountFrom,
  refundAmountLabel,
  refundDeclaredLabel,
  refundMenuLabel,
  totalsOfRefunds,
} from "../src/refunds.ts";

/**
 * Gli importi dei rimborsi sono la parte che si può sbagliare in silenzio: una
 * cifra presa dalla spesa invece che dal rimborso gonfia il totale, e una
 * percentuale letta come zero fa sembrare recuperato niente. Qui si verifica
 * sulle formule che le fonti usano davvero, non su casi inventati.
 */
describe("importo dichiarato dal bando", () => {
  it("legge la cifra del rimborso, con euro o col simbolo", () => {
    expect(refundAmountFrom("Rimborso di 25€ su Ymea")).toEqual({ cents: 2500, cap: false });
    expect(refundAmountFrom("Cashback: 5 euro di rimborso")).toEqual({ cents: 500, cap: false });
    expect(refundAmountFrom("Buono da 1,50 € su un gelato")).toEqual({ cents: 150, cap: false });
  });

  it("distingue il tetto dalla cifra esatta", () => {
    expect(refundAmountFrom("Rimborso fino a 6 euro su Nutella")).toEqual({ cents: 600, cap: true });
    expect(refundAmountFrom("Fino a 100€ di rimborso")).toEqual({ cents: 10000, cap: true });
    // Casi veri dal riassunto delle fonti: fra "fino a" e la cifra ci sono
    // altre parole, e la cifra resta un tetto (non un importo esatto).
    expect(refundAmountFrom("rimborso del 50% di quanto speso, fino a un massimo di 7,50 euro")).toEqual({
      cents: 750,
      cap: true,
    });
    expect(refundAmountFrom("rimborso completo, fino a un valore massimo di 3 Euro")).toEqual({
      cents: 300,
      cap: true,
    });
  });

  it("non confonde la spesa richiesta con il rimborso", () => {
    // Il caso vero: "10 € di rimborso con 20 € di acquisti". La seconda cifra è
    // quello che devi spendere, non quello che ti torna.
    expect(refundAmountFrom("10€ di rimborso con 20€ di acquisti")).toEqual({ cents: 1000, cap: false });
    expect(refundAmountFrom("Spendi 20 € e ricevi 5 € di rimborso")).toEqual({ cents: 500, cap: false });
  });

  it("una percentuale non è una cifra: resta null", () => {
    expect(refundAmountFrom("Rimborso del 50% su tutti i prodotti")).toEqual({ cents: null, cap: false });
    expect(refundAmountFrom("Cashback 100% sulla seconda confezione")).toEqual({ cents: null, cap: false });
    expect(refundAmountFrom("Rimborso 1+1 sul prodotto meno caro")).toEqual({ cents: null, cap: false });
  });

  it("cerca nel titolo, poi nel riassunto, poi nel premio", () => {
    expect(
      refundAmountFor({ title: "Buono sconto Novi", summary: "Rimborso di 3 €", prize: null }),
    ).toEqual({ cents: 300, cap: false });
    expect(
      refundAmountFor({ title: "Cashback Ymea", summary: "Richiedi il rimborso", prize: "25 €" }),
    ).toEqual({ cents: 2500, cap: false });
    expect(refundAmountFor({ title: "Buono", summary: "Sconto", prize: null })).toEqual({
      cents: null,
      cap: false,
    });
  });

  it("un prezzo nel riassunto non è un rimborso", () => {
    // Il caso vero (McDonald's Discovery Days): il titolo non ha cifre, il
    // riassunto dice "patatine a 2,90€". Senza la parola del rimborso accanto,
    // quella cifra non deve entrare in 💰 Rimborsi.
    expect(
      refundAmountFor({
        title: "McDonald’s Discovery Days: offerte in app dal 14 al 26 maggio",
        summary: "Ogni giorno nuove offerte in app: Crispy McBacon o McChicken e patatine a 2,90€.",
        prize: null,
      }),
    ).toEqual({ cents: null, cap: false });
    // Ma un riassunto che NOMINA il rimborso continua a funzionare.
    expect(
      refundAmountFor({
        title: "Cashback Henkel 2026: ricevi il rimborso del 50%",
        summary: "Acquista 15 euro di prodotti e ricevi il rimborso del 50% di quanto speso, fino a un massimo di 7,50 euro!",
        prize: null,
      }),
    ).toEqual({ cents: 750, cap: true });
  });
});

describe("importo scritto in chat", () => {
  it("accetta le forme che si scrivono davvero", () => {
    expect(parseEuroInput("7,50")).toBe(750);
    expect(parseEuroInput("7.50")).toBe(750);
    expect(parseEuroInput("7")).toBe(700);
    expect(parseEuroInput("€ 7,50")).toBe(750);
    expect(parseEuroInput("7,50 €")).toBe(750);
    expect(parseEuroInput(" 12 euro ")).toBe(1200);
  });

  it("rifiuta quello che non è una cifra, invece di leggerlo male", () => {
    expect(parseEuroInput("")).toBeNull();
    expect(parseEuroInput("sette")).toBeNull();
    expect(parseEuroInput("7,555")).toBeNull();
    expect(parseEuroInput("0")).toBeNull();
    expect(parseEuroInput("-5")).toBeNull();
    // 5.000 € in un rimborso è un refuso (o un prezzo incollato).
    expect(parseEuroInput("5000")).toBeNull();
  });
});

describe("come si scrivono gli importi", () => {
  it("virgola per i centesimi, niente decimali inutili", () => {
    expect(formatEuro(500)).toBe("5 €");
    expect(formatEuro(150)).toBe("1,50 €");
    expect(formatEuro(123456)).toBe("1.234,56 €");
    expect(formatEuro(0)).toBe("0 €");
  });

  it("l'etichetta dice il tetto e il caso variabile", () => {
    expect(refundAmountLabel({ amountCents: 500, cap: false })).toBe("5 €");
    expect(refundAmountLabel({ amountCents: 10000, cap: true })).toBe("fino a 100 €");
    expect(refundAmountLabel({ amountCents: 0, cap: false })).toBe("importo variabile");
    expect(refundDeclaredLabel({ cents: null, cap: false })).toBe("importo variabile");
  });

  it("l'etichetta del menù dice quando il totale è un tetto", () => {
    expect(refundMenuLabel(0, 0)).toBe("💰 Rimborsi");
    expect(refundMenuLabel(2, 1250)).toBe("💰 Rimborsi (2) · 12,50 €");
    expect(refundMenuLabel(2, 1250, true)).toBe("💰 Rimborsi (2) · fino a 12,50 €");
  });
});

describe("i totali", () => {
  const riga = (amountCents: number, received: boolean, cap = false) => ({
    amountCents,
    receivedAt: received ? "2026-11-20T10:00:00.000Z" : null,
    cap,
  });

  it("separa il denaro tornato da quello promesso, e conta i casi senza cifra", () => {
    expect(totalsOfRefunds([riga(2500, false), riga(500, true), riga(0, false), riga(600, false, true)])).toEqual({
      pendingCents: 3100,
      receivedCents: 500,
      pending: 3,
      received: 1,
      unknownPending: 1,
      unknownReceived: 0,
      capPending: 1,
      capReceived: 0,
    });
  });

  it("senza richieste tutti i totali sono zero", () => {
    expect(totalsOfRefunds([])).toEqual({
      pendingCents: 0,
      receivedCents: 0,
      pending: 0,
      received: 0,
      unknownPending: 0,
      unknownReceived: 0,
      capPending: 0,
      capReceived: 0,
    });
  });
});
