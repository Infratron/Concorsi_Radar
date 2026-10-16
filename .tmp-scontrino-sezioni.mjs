// Quali sezioni di Scontrino Felice hanno un feed utilizzabile?
import { USER_AGENT } from "./src/config/sources.ts";
import { parseRssFeed } from "./src/ingest/rss.ts";

const sezioni = [
  "concorsi-con-acquisto",
  "concorsi-gratuiti",
  "premio-certo",
  "raccolte-punti",
  "spendi-e-riprendi",
  "diventa-tester",
  "campioni-omaggio",
  "omaggi-in-edicola",
];

for (const sezione of sezioni) {
  const url = `https://www.scontrinofelice.it/${sezione}/feed/`;
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/rss+xml" } });
  if (!response.ok) {
    console.log(`\n/${sezione}/feed/ → HTTP ${response.status}`);
    continue;
  }
  const xml = await response.text();
  const items = parseRssFeed(xml, sezione, url, 5);
  console.log(`\n/${sezione}/feed/ → HTTP 200, ${items.length} item (mostro 5)`);
  for (const item of items) {
    console.log(`   · ${item.title}\n     ${item.url} | pub=${item.publishedAt ?? "-"}`);
  }
}
