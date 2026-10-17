import { describe, expect, it } from "vitest";

// Sonda temporanea: questo test DEVE fallire. Serve una volta sola, a capire se
// la build di Cloudflare esegue davvero i test prima di pubblicare (se li esegue,
// push come questo non producono nessuna versione nuova). Viene rimossa nel
// commit successivo.
describe("sonda del cancello di build", () => {
  it("fallisce di proposito", () => {
    expect(1).toBe(2);
  });
});
