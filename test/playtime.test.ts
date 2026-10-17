import { describe, expect, it } from "vitest";
import {
  playDaysFrom,
  playTimeFor,
  playWindowFrom,
  prizeCadenceFrom,
} from "../src/enrich/playtime.ts";

/**
 * Quando giocare: la finestra e la cadenza lette dal bando, più lo stato di
 * adesso. Le date sono scelte in ora italiana: novembre è UTC+1, quindi le
 * 11:00 di Roma sono le 10:00Z.
 */
const VENERDI_11 = new Date("2026-11-20T10:00:00.000Z");
const VENERDI_0730 = new Date("2026-11-20T06:30:00.000Z");
const VENERDI_2230 = new Date("2026-11-20T21:30:00.000Z");
const SABATO_11 = new Date("2026-11-21T10:00:00.000Z");

function testo(summary: string, title = "Premio certo Bolla"): { title: string; summary: string } {
  return { title, summary };
}

describe("finestra oraria del bando", () => {
  it("legge le forme in cui il bando dichiara gli orari", () => {
    expect(playWindowFrom("Premio certo: dalle 9:00 alle 20:00")).toEqual({
      from: 540,
      to: 1200,
      label: "09:00–20:00",
    });
    // Punto e virgola come separatore, e "ore" davanti al numero.
    expect(playWindowFrom("Dalle ore 8.00 alle ore 22.00")?.label).toBe("08:00–22:00");
    expect(playWindowFrom("Tra le 9 e le 21")?.label).toBe("09:00–21:00");
    // Un minuto dopo la mezzanotte è un orario valido.
    expect(playWindowFrom("dalle 00:15 alle 06:45")?.from).toBe(15);
  });

  it("un intervallo di giorni non è una finestra oraria", () => {
    expect(playWindowFrom("Concorso valido dal 1 al 5 dicembre")).toBeNull();
    expect(playWindowFrom("Premio certo senza orari")).toBeNull();
    // Una finestra vuota non dice niente: meglio nessuna riga.
    expect(playWindowFrom("dalle 9 alle 9")).toBeNull();
  });
});

describe("cadenza dei premi", () => {
  it("legge la frequenza quando il testo dice cosa si ripete", () => {
    expect(prizeCadenceFrom("Un premio ogni 15 minuti")).toBe("un premio ogni 15 minuti");
    expect(prizeCadenceFrom("In palio un premio ogni 2 ore")).toBe("un premio ogni 2 ore");
    expect(prizeCadenceFrom("un premio all'ora")).toBe("un premio all'ora");
    expect(prizeCadenceFrom("Un premio ogni mezz'ora")).toBe("un premio ogni mezz'ora");
    expect(prizeCadenceFrom("Un premio ogni giorno")).toBe("un premio al giorno");
  });

  it("un limite di partecipazione non è la cadenza dei premi", () => {
    // "ogni 24 ore" qui parla di quanto spesso si può giocare, non di quanti
    // premi escono: senza il sostantivo davanti non si cattura.
    expect(prizeCadenceFrom("Puoi partecipare ogni 24 ore")).toBeNull();
    expect(prizeCadenceFrom("Premio certo senza cadenza")).toBeNull();
  });
});

describe("restrizione di giorni", () => {
  it("distingue fine settimana, giorni feriali e giorno singolo", () => {
    expect(playDaysFrom("solo sabato e domenica")?.label).toBe("sabato e domenica");
    expect(playDaysFrom("dal lunedì al venerdì")?.label).toBe("dal lunedì al venerdì");
    expect(playDaysFrom("solo il sabato")?.allowed).toEqual(new Set([6]));
    // "tutti i giorni" non è una restrizione.
    expect(playDaysFrom("tutti i giorni dalle 9 alle 20")).toBeNull();
  });
});

describe("dentro o fuori, adesso", () => {
  it("dentro la finestra dice che si gioca, e riporta la cadenza", () => {
    const quando = playTimeFor(testo("Un premio ogni 15 minuti, dalle 9:00 alle 20:00"), VENERDI_11);
    expect(quando.window?.label).toBe("09:00–20:00");
    expect(quando.every).toBe("un premio ogni 15 minuti");
    expect(quando.status).toBe("inside");
    expect(quando.reason).toBeNull();
  });

  it("prima dell'apertura dice quando riapre oggi", () => {
    const quando = playTimeFor(testo("dalle 9:00 alle 20:00"), VENERDI_0730);
    expect(quando.status).toBe("outside");
    expect(quando.reason).toBe("time");
    expect(quando.opensAt).toBe("riapre alle 09:00");
  });

  it("dopo la chiusura riapre domani, e la mezzanotte non si confonde", () => {
    const quando = playTimeFor(testo("dalle 9:00 alle 20:00"), VENERDI_2230);
    expect(quando.opensAt).toBe("riapre domani alle 09:00");
  });

  it("una finestra che passa la mezzanotte resta una finestra sola", () => {
    const notte = testo("dalle 22:00 alle 6:00");
    expect(playTimeFor(notte, new Date("2026-11-20T22:30:00.000Z")).status).toBe("inside");
    expect(playTimeFor(notte, VENERDI_11).status).toBe("outside");
    expect(playTimeFor(notte, VENERDI_11).reason).toBe("time");
  });

  it("un giorno non ammesso è fuori anche dentro l'orario", () => {
    const weekend = testo("solo sabato e domenica dalle 9:00 alle 20:00");
    const venerdi = playTimeFor(weekend, VENERDI_11);
    expect(venerdi.status).toBe("outside");
    expect(venerdi.reason).toBe("day");
    expect(playTimeFor(weekend, SABATO_11).status).toBe("inside");
  });

  it("senza orario dichiarato non si promette niente", () => {
    const quando = playTimeFor(testo("Premio certo con omaggio, un premio ogni ora"), VENERDI_11);
    expect(quando.window).toBeNull();
    expect(quando.every).toBe("un premio all'ora");
    // La cadenza da sola non dice se adesso si può giocare.
    expect(quando.status).toBe("unknown");
  });
});
