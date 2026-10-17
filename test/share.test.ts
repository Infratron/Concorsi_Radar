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

/**
 * Luminanza relativa WCAG: serve a dire con un numero se la frase si legge,
 * invece di fidarsi dell'occhio (o del tema chiaro del portatile).
 */
function luminanza(hex: string): number {
  const cifre = hex.replace("#", "");
  const canali = [0, 2, 4].map((offset) => parseInt(cifre.slice(offset, offset + 2), 16) / 255);
  const lineare = (canale: number) => (canale <= 0.03928 ? canale / 12.92 : ((canale + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lineare(canali[0]) + 0.7152 * lineare(canali[1]) + 0.0722 * lineare(canali[2]);
}

function contrasto(primo: string, secondo: string): number {
  const [chiaro, scuro] = [luminanza(primo), luminanza(secondo)].sort((a, b) => b - a);
  return (chiaro + 0.05) / (scuro + 0.05);
}

function colore(html: string, selettore: string, proprieta: "background" | "color"): string {
  const blocco = new RegExp(`\\${selettore} \\{[^}]*${proprieta}: (#[0-9a-fA-F]{6})`);
  const trovato = blocco.exec(html)?.[1];
  if (!trovato) throw new Error(`colore ${proprieta} assente per ${selettore}`);
  return trovato;
}

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
    // Riga vuota fra frase e link: con un solo a capo i client li incollavano.
    const atteso = `https://wa.me/?text=${encodeURIComponent("Hey! Dai un'occhiata a questo concorso!\n\nhttps://esempio.it/concorso?utm=1&x=2")}`;
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

  it("frase e link sono due blocchi leggibili, non una riga sola", () => {
    const html = renderSharePage("https://esempio.it/concorso", "Hey! Dai un'occhiata a questo concorso!");
    // Due paragrafi distinti: il browser non può incollarli.
    expect(html).toContain('<p class="frase" id="frase">Hey! Dai un&#39;occhiata a questo concorso!</p>');
    expect(html).toContain('<p class="link"><a href="https://esempio.it/concorso"');
    // Testo scuro su carta chiara, con il tema di sistema disattivato: dentro la
    // WebView di Telegram il tema scuro forzato rendeva la frase illeggibile.
    expect(html).toContain("color-scheme: light");
    // Opt-out esplicito dal "force dark" di Chrome Android.
    expect(html).toContain("color-scheme: only light");
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).not.toContain("prefers-color-scheme");
    expect(html).toContain(".frase { margin: 0 0 12px; color: #111827;");
    // Il testo si legge su ogni schermo: contrasto misurato, non "a occhio".
    const carta = colore(html, ".card", "background");
    expect(contrasto(colore(html, ".frase", "color"), carta)).toBeGreaterThan(4.5);
    expect(contrasto(colore(html, ".link a", "color"), carta)).toBeGreaterThan(4.5);
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
    // La frase sta nel suo blocco, separata dal link.
    expect(html).toContain('<p class="frase" id="frase">Ciao</p>');
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
