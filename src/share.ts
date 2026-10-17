/**
 * La pagina di condivisione.
 *
 * Perché esiste: un bot Telegram non può aprire il pannello di condivisione del
 * telefono. Il bottone `t.me/share/url` porta solo nelle chat di Telegram, e
 * "condividi" per l'utente vuol dire WhatsApp, i messaggi, la mail — le app che
 * ha lì accanto. Un bottone `url` può però aprire una pagina NOSTRA dentro il
 * browser in-app di Telegram: da lì `navigator.share()` chiama il pannello di
 * sistema, e quando non c'è (WebView vecchie) restano i quattro link espliciti.
 *
 * Cosa NON fa: non salva niente, non legge niente, non ha una corsia per i cors.
 * Prende due parametri dall'URL — il link da condividere (`u`) e la frase (`t`) —
 * e ne fa una pagina. L'unica cosa che tocca la sicurezza è la validazione dello
 * schema: solo http/https, perché `javascript:` in un bottone "apri" è
 * un'esecuzione di codice a nome di chi tocca.
 */

/** Tetto sul link condivisibile: un URL più lungo non è un concorso. */
const MAX_URL = 2_000;
/** Tetto sulla frase: deve stare in un messaggio, non essere un tema. */
const MAX_TEXT = 300;

/**
 * true se il link si può mettere in una pagina. Solo http/https: `javascript:`,
 * `data:` e `file:` restano fuori — non sono concorsi e sarebbero codice.
 */
export function isShareableUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Converte un valore in una stringa letterale per dentro `<script>`.
 *
 * `JSON.stringify` da solo non basta: un testo che contiene `</script>` chiude il
 * blocco e trasforma il resto in HTML. Sostituire i caratteri pericolosi con le
 * loro sequenze unicode lascia la stringa identica per il JavaScript e innocua
 * per il parser.
 */
function scriptLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/** Testo per l'HTML: fuori i caratteri che possono aprire un tag o un attributo. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * La pagina: un bottone che chiama il pannello di sistema e quattro vie dirette.
 * WhatsApp, Telegram e mail coprono il caso in cui `navigator.share` non c'è;
 * 📋 copia frase e link, che funziona sempre.
 */
export function renderSharePage(target: string, text: string): string {
  const messaggio = text.trim().length > 0 ? text.trim().slice(0, MAX_TEXT) : "";
  const insieme = messaggio.length > 0 ? `${messaggio}\n${target}` : target;
  const host = (() => {
    try {
      return new URL(target).host;
    } catch {
      return target;
    }
  })();

  const wa = `https://wa.me/?text=${encodeURIComponent(insieme)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(target)}&text=${encodeURIComponent(messaggio)}`;
  const mail = `mailto:?subject=${encodeURIComponent("Guarda questo concorso")}&body=${encodeURIComponent(insieme)}`;

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Condividi</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.4 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px 18px 40px; background: #f6f7f9; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #16181c; color: #f2f3f5; } .card { background: #1f2228; } a.via { background: #2a2e36; color: #f2f3f5; } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.host { margin: 0 0 18px; opacity: .65; font-size: 14px; word-break: break-all; }
  .card { background: #fff; border-radius: 14px; padding: 16px; margin: 0 0 18px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .msg { white-space: pre-wrap; word-break: break-word; margin: 0; }
  .msg a { color: inherit; }
  button, a.via { display: block; width: 100%; box-sizing: border-box; text-align: center; border: 0; border-radius: 12px; padding: 15px 14px; margin: 0 0 10px; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  button.primary { background: #2563eb; color: #fff; font-size: 17px; }
  a.via { background: #e9ecf1; color: #111; }
  .nota { font-size: 13px; opacity: .7; margin: 14px 0 0; }
</style>
</head>
<body>
<h1>Condividi</h1>
<p class="host">${escapeHtml(host)}</p>
<div class="card"><p class="msg" id="msg">${escapeHtml(messaggio)}${messaggio.length > 0 ? "\n" : ""}<a href="${escapeHtml(target)}" rel="noopener noreferrer nofollow">${escapeHtml(target)}</a></p></div>
<button class="primary" id="share" type="button">📱 Condividi con un'app…</button>
<a class="via" href="${escapeHtml(wa)}" rel="noopener noreferrer">💬 WhatsApp</a>
<a class="via" href="${escapeHtml(tg)}" rel="noopener noreferrer">✈️ Telegram</a>
<a class="via" href="${escapeHtml(mail)}">✉️ Email</a>
<button class="via" id="copy" type="button">📋 Copia frase e link</button>
<p class="nota" id="nota"></p>
<script>
  var TARGET = ${scriptLiteral(target)};
  var MESSAGE = ${scriptLiteral(insieme)};
  var share = document.getElementById('share');
  var nota = document.getElementById('nota');
  if (navigator.share) {
    share.addEventListener('click', function () {
      navigator.share({ text: MESSAGE }).catch(function () { /* annullato: nessun errore da mostrare */ });
    });
  } else {
    share.hidden = true;
    nota.textContent = 'Questo browser non ha il pannello di condivisione: usa WhatsApp, Telegram o copia il link.';
  }
  document.getElementById('copy').addEventListener('click', function () {
    var fatto = function () { nota.textContent = 'Copiato: incollalo dove vuoi.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(MESSAGE).then(fatto, function () { nota.textContent = 'Copia non riuscita: tieni premuto sul testo qui sopra.'; });
    } else {
      nota.textContent = 'Tieni premuto sul testo qui sopra per copiarlo.';
    }
  });
</script>
</body>
</html>`;
}
