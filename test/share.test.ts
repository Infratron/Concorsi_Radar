import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { isShareableUrl, renderSharePage } from "../src/share.ts";
import type { Env } from "../src/types.ts";

/**
 * La pagina di condivisione.
 *
 * Perché merita test: è l'unico pezzo del bot raggiungibile senza Telegram e
 * senza login — chiunque abbia il link può aprirla — e riceve due parametri
 * dall'URL che finiscono dentro l'HTML. Le prove che contano sono tre: solo
 * http/https, niente escursione dall'HTML, e i link delle app costruiti bene.
 */

describe("condivisione · la pagina /share", () => {
  it("accetta solo link http/https", () => {
    expect(isShareableUrl("https://esempio.it/concorso")).toBe(true);
    expect(isShareableUrl("http://esempio.it/concorso")).toBe(true);
    // Uno schema che esegue codice non è un concorso.
    expect(isShareableUrl("javascript:alert(1)")).toBe(false);
    expect(isShareableUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isShareableUrl("file:///etc/passwd")).toBe(false);
    expect(isShareableUrl("")).toBe(false);
    expect(isShareableUrl(`https://esempio.it/${"a".repeat(2_100)}`)).toBe(false);
  });

  it("mette il link e la frase nelle vie dirette, e nient'altro", () => {
    const html = renderSharePage("https://esempio.it/concorso?utm=1&x=2", "Hey! Dai un'occhiata a questo concorso!");
    // WhatsApp: la via che i bottoni di Telegram non davano. Nell'attributo
    // l'apostrofo è `&#39;` (è HTML, non testo), quindi si confronta su quello.
    const atteso = `https://wa.me/?text=${encodeURIComponent("Hey! Dai un'occhiata a questo concorso!\nhttps://esempio.it/concorso?utm=1&x=2")}`;
    expect(html).toContain(atteso.replace(/'/g, "&#39;"));
    // Telegram resta, come alternativa esplicita.
    expect(html).toContain("https://t.me/share/url?url=");
    // Email e copia: le due che funzionano sempre.
    expect(html).toContain("mailto:?subject=");
    expect(html).toContain("navigator.clipboard.writeText");
    // Il pannello di sistema, quando c'è.
    expect(html).toContain("navigator.share");
    // Il link compare visitabile ma con rel che non passa referrer.
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("non lascia uscire il testo dall'HTML né dallo script", () => {
    const cattivo = `</script><img src=x onerror=alert(1)>`;
    const html = renderSharePage("https://esempio.it/concorso", cattivo);
    // Nel corpo finisce come testo, mai come tag.
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    // Nello script il `</script>` è neutralizzato: di blocchi chiusi ce n'è uno solo.
    expect(html.match(/<\/script>/g) ?? []).toHaveLength(1);
    expect(html).toContain("\\u003c/script\\u003e");
  });
});

describe("condivisione · la rotta del Worker", () => {
  const env = {} as Env;

  it("serve la pagina con il link giusto", async () => {
    const risposta = await worker.fetch(
      new Request("https://bot.example/share?u=https%3A%2F%2Fesempio.it%2Fconcorso&t=Ciao"),
      env,
    );
    expect(risposta.status).toBe(200);
    expect(risposta.headers.get("content-type")).toContain("text/html");
    const html = await risposta.text();
    expect(html).toContain("https://esempio.it/concorso");
    expect(html).toContain("Ciao");
  });

  it("rifiuta uno schema eseguibile invece di servirlo", async () => {
    const risposta = await worker.fetch(
      new Request("https://bot.example/share?u=javascript%3Aalert(1)"),
      env,
    );
    expect(risposta.status).toBe(400);
    const html = await risposta.text();
    expect(html).not.toContain("javascript:alert");
  });

  it("senza link non serve niente", async () => {
    const risposta = await worker.fetch(new Request("https://bot.example/share"), env);
    expect(risposta.status).toBe(400);
  });
});
