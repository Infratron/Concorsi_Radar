import { describe, expect, it } from "vitest";
import { tagsToAdd } from "../scripts/backfill-tags.ts";

/**
 * Riempimento dei tag di contenuto (`npm run tags`).
 *
 * Serve perché una riga già in archivio non ripassa dall'arricchimento: senza
 * questo comando le porte 🎁 Premio certo e 🛍️ Omaggi con acquisto partirebbero
 * da zero. La selezione è pura, quindi si prova senza database: qui si verifica
 * che aggiunga solo quello che manca e che non allarghi le regole.
 */

function riga(overrides: Partial<Parameters<typeof tagsToAdd>[0]> = {}): Parameters<typeof tagsToAdd>[0] {
  return {
    title: "Premio certo Bolla: richiedi i calici in regalo",
    summary: "",
    requiresPurchase: true,
    tags: ["premio_certo", "acquisto"],
    ...overrides,
  };
}

describe("riempimento dei tag · cosa aggiungere", () => {
  it("a una riga già completa non aggiunge niente", () => {
    expect(tagsToAdd(riga({ tags: ["premio_certo", "acquisto", "omaggio_con_acquisto"] }))).toEqual([]);
  });

  it("aggiunge i due tag mancanti a un premio certo con acquisto", () => {
    expect(tagsToAdd(riga({ tags: [] }))).toEqual(["premio_certo", "omaggio_con_acquisto"]);
  });

  it("un premio certo gratuito prende il tag certo ma non quello dell'omaggio", () => {
    expect(
      tagsToAdd(riga({ title: "Concorso gratuito con premio certo", requiresPurchase: false, tags: [] })),
    ).toEqual(["premio_certo"]);
  });

  it("l'estrazione con scontrino resta senza tag di contenuto", () => {
    expect(
      tagsToAdd(
        riga({ title: "Concorso Findus: vinci una gift card con lo scontrino", summary: "", tags: ["giftcard"] }),
      ),
    ).toEqual([]);
  });

  it("non ri-aggiunge un tag che la riga ha già", () => {
    expect(tagsToAdd(riga({ tags: ["premio_certo"] }))).toEqual(["omaggio_con_acquisto"]);
  });
});
