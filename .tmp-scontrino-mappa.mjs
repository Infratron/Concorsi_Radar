// Mappa del sito Scontrino Felice: quali sezioni esistono, così si vede se le
// fonti in config coprono tutto quello che pubblicano.
import { USER_AGENT } from "./src/config/sources.ts";

async function get(url) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, "accept-language": "it-IT,it;q=0.9" } });
  return { status: response.status, text: await response.text() };
}

const home = await get("https://www.scontrinofelice.it/");
console.log("home:", home.status, home.text.length, "caratteri");

const prefissi = new Map();
for (const match of home.text.matchAll(/href="([^"]+)"/g)) {
  let path;
  try {
    const url = new URL(match[1], "https://www.scontrinofelice.it/");
    if (url.hostname.replace(/^www\./, "") !== "scontrinofelice.it") continue;
    path = url.pathname;
  } catch {
    continue;
  }
  const primo = path.split("/").filter(Boolean)[0] ?? "(radice)";
  prefissi.set(primo, (prefissi.get(primo) ?? 0) + 1);
}
console.log("\nsezioni linkate dalla home:");
for (const [sezione, quante] of [...prefissi.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(quante).padStart(3)}  /${sezione}/`);
}

const index = await get("https://www.scontrinofelice.it/sitemap_index.xml");
console.log("\nsitemap_index:", index.status);
for (const match of index.text.matchAll(/<loc>([^<]+)<\/loc>/g)) console.log("  ", match[1]);

// Quanti concorsi pubblica in tutto la sitemap dei concorsi (senza il filtro).
for (const child of ["https://www.scontrinofelice.it/page-sitemap.xml", "https://www.scontrinofelice.it/post-sitemap.xml"]) {
  const sitemap = await get(child);
  if (sitemap.status !== 200) {
    console.log(`\n${child}: HTTP ${sitemap.status}`);
    continue;
  }
  const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const concorsi = locs.filter((loc) => /concors|giveaway|vinci|premi|omaggi/i.test(loc));
  console.log(`\n${child}: ${locs.length} URL, di cui ${concorsi.length} sembrano concorsi`);
  const sezioni = new Map();
  for (const loc of concorsi) {
    const path = new URL(loc).pathname.split("/").filter(Boolean);
    const sezione = path[0] ?? "(radice)";
    sezioni.set(sezione, (sezioni.get(sezione) ?? 0) + 1);
  }
  for (const [sezione, quante] of [...sezioni.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   /${sezione}/ → ${quante}`);
  }
}
