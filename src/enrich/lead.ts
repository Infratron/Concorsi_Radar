import type { ItemKind, Sighting, SourceChannel } from "../types.ts";

/**
 * Il vantaggio di tempistica: di quanto vediamo un concorso prima degli
 * aggregatori.
 *
 * Perché serve: gli aggregatori sono il metro del nostro lavoro, ma non bastava
 * contare chi arriva primo. Il caso reale: la sitemap di Conad pubblica la
 * raccolta punti, e nessun aggregatore la riprende mai — contarli "vinti" tutti
 * insieme a un concorso che Scontrino Felice ha pubblicato tre giorni prima di noi
 * significa raccontarsi una storia. Qui si misura il ritardo con un numero.
 *
 * Da dove viene il numero: `sightings` (una riga per concorso e per fonte). Per
 * ogni concorso si prendono la prima vista da un canale diretto e la prima vista
 * da aggregatore, e si sottrae. Positivo = l'abbiamo visto prima noi.
 *
 * Le tre trappole che questo modulo NON prova a nascondere, e che la schermata in
 * chat dichiara:
 *  1. se l'ingestione era ferma, l'anticipo misura il fermo (le fonti "stampa"
 *     sono quelle che in produzione rispondono meno: oggi `news-*` non passa);
 *  2. quando si accende una fonte nuova la prima esecuzione scarica l'arretrato e
 *     tutte le sue prime viste cadono nello stesso giro;
 *  3. i concorsi visti da una sola classe di canale non hanno un anticipo: sono
 *     censurati e si contano a parte, non valgono zero.
 */

/**
 * Il canale di ogni fonte, dichiarato a mano di proposito.
 *
 * Non si deduce dai tag (`aggregatore` oggi c'è su due fonti e non sulle altre) e
 * non si eredita dalla categoria: sono due cose diverse. Un test verifica che ogni
 * fonte di src/config/sources.ts sia qui dentro, così una fonte nuova non può
 * finire nel default per distrazione.
 */
export const CHANNEL_BY_SOURCE: Record<string, SourceChannel> = {
  // --- Aggregatori: il metro. Raccolgono i concorsi di tutti, anche quelli che
  // noi non vediamo, ed è contro di loro che l'anticipo ha senso.
  premieconcorsi: "aggregatore",
  "sitemap-premieconcorsi": "aggregatore",
  "premieconcorsi-punto-vendita": "aggregatore",
  "scontrinofelice-acquisto": "aggregatore",
  "scontrinofelice-gratuiti": "aggregatore",
  "scontrinofelice-premio-certo": "aggregatore",
  "scontrinofelice-raccolte-punti": "aggregatore",
  "sitemap-scontrinofelice": "aggregatore",
  dimmicosacerchi: "aggregatore",
  soldissimi: "aggregatore",
  vincimi: "aggregatore",
  omaggiomania: "aggregatore",
  "your-contest": "aggregatore",
  "scontomaggio-concorsi": "aggregatore",
  // Le fonti di coupon sono aggregatori come gli altri (raccontano le promozioni
  // delle insegne), anche se quasi non producono viste: le viste si registrano
  // solo per i concorsi, e un buono sconto non lo è. Restano qui perché una di
  // quelle pagine può comunque annunciare un'estrazione, e allora è un concorso
  // visto da un aggregatore — esattamente quello che questa tabella misura.
  "scontrinofelice-cashback": "aggregatore",
  "scontrinofelice-coupon": "aggregatore",
  "dimmicosacerchi-cashback": "aggregatore",
  "dimmicosacerchi-coupon": "aggregatore",
  "scontomaggio-cashback": "aggregatore",
  "scontomaggio-coupon": "aggregatore",
  couponvolantini: "aggregatore",

  // --- Stampa: le query Google News. Non sono la fonte del concorso e non sono
  // nemmeno un aggregatore: sono echi, e restano fuori dal confronto (altrimenti
  // un comunicato stampa letto il giorno prima ci farebbe sembrare più veloci di
  // quello che siamo).
  "news-concorso-premi": "stampa",
  "news-giftcard": "stampa",
  "news-scontrino": "stampa",
  "news-raccolta-punti": "stampa",
  "news-brand": "stampa",
  "news-instantwin": "stampa",

  // --- Brand: la fonte diretta. Sitemap e pagine ufficiali, quelle che gli
  // aggregatori non hanno e dove l'anticipo è davvero nostro.
  "sitemap-ferrero": "brand",
  "sitemap-lavazza": "brand",
  "sitemap-eni": "brand",
  "sitemap-payback": "brand",
  "sitemap-conad": "brand",
  "sitemap-burgerking": "brand",
  "sitemap-sammontana": "brand",
  "sitemap-aia": "brand",
  "sitemap-pampers": "brand",
  "sitemap-penny": "brand",
  "sitemap-eurospin": "brand",
  "cocacola-offerte": "brand",
  "brand-sitemap-template": "brand",
};

/**
 * Il canale di una fonte. Un id sconosciuto vale `stampa`, cioè resta fuori dal
 * confronto: nel dubbio è meglio non contare una fonte che contarla a favore.
 */
export function channelOf(sourceId: string): SourceChannel {
  return CHANNEL_BY_SOURCE[sourceId] ?? "stampa";
}

/** Il valore da salvare in `sightings`, con il canale già risolto. */
export function sightingFor(input: {
  urlKey: string;
  sourceId: string;
  itemId: number | null;
  kind: ItemKind;
  kept: boolean;
  now: Date;
}): Sighting {
  return {
    urlKey: input.urlKey,
    sourceId: input.sourceId,
    itemId: input.itemId,
    kind: input.kind,
    channel: channelOf(input.sourceId),
    seenAt: input.now.toISOString(),
    kept: input.kept,
  };
}

const ORA_MS = 3_600_000;

/**
 * Prima vista per canale di UN concorso. `null` = quel canale non l'ha mai visto.
 * Le viste scartate (kept=false) restano fuori: un concorso che il cancello di
 * freschezza ha buttato non è un concorso che abbiamo "dato" all'utente.
 */
export interface PrimaVista {
  brand: number | null;
  aggregatore: number | null;
  /** La fonte più antica fra quelle dirette, per dire chi è stato. */
  brandDa: string | null;
  aggregatoreDa: string | null;
}

export function primaVistaPerCanale(rows: Sighting[]): PrimaVista {
  const out: PrimaVista = { brand: null, aggregatore: null, brandDa: null, aggregatoreDa: null };
  for (const row of rows) {
    if (!row.kept || row.kind !== "contest") continue;
    const at = Date.parse(row.seenAt);
    if (!Number.isFinite(at)) continue;
    if (row.channel === "aggregatore") {
      if (out.aggregatore === null || at < out.aggregatore) {
        out.aggregatore = at;
        out.aggregatoreDa = row.sourceId;
      }
      continue;
    }
    if (row.channel === "brand") {
      if (out.brand === null || at < out.brand) {
        out.brand = at;
        out.brandDa = row.sourceId;
      }
    }
  }
  return out;
}

/**
 * Anticipo di UN concorso in ore: positivo = l'abbiamo visto prima degli
 * aggregatori. `null` quando manca uno dei due lati — cioè quando il confronto
 * non esiste e il numero sarebbe una bugia.
 */
export function leadHours(rows: Sighting[]): number | null {
  const prima = primaVistaPerCanale(rows);
  if (prima.brand === null || prima.aggregatore === null) return null;
  return (prima.aggregatore - prima.brand) / ORA_MS;
}

export interface LeadStats {
  /** Quanti concorsi compaiono nella finestra (visti almeno una volta). */
  concorsi: number;
  /** Da quanti giorni stiamo misurando: la tabella nasce vuota, va detto. */
  daGiorni: number;
  /** Concorsi visti sia da un canale diretto sia da un aggregatore. */
  confrontabili: number;
  avanti: number;
  dietro: number;
  /** Orologio dello stesso giro di raccolta: né prima né dopo. */
  insieme: number;
  medianaOre: number | null;
  p25Ore: number | null;
  p75Ore: number | null;
  /** Visti SOLO da fonti dirette: gli aggregatori non li hanno ripresi. */
  soloDiretti: number;
  /** Visti SOLO dagli aggregatori: i nostri buchi. */
  soloAggregatori: number;
  /** Fasce dei soli casi in cui eravamo avanti. */
  fasce: { entro6h: number; entroGiorno: number; entro3giorni: number; oltre: number };
}

/** Quartile con interpolazione lineare: la mediana di un numero pari di casi. */
function quantile(ordinati: number[], frazione: number): number {
  if (ordinati.length === 0) return Number.NaN;
  if (ordinati.length === 1) return ordinati[0]!;
  const posizione = (ordinati.length - 1) * frazione;
  const base = Math.floor(posizione);
  const resto = posizione - base;
  const successivo = ordinati[base + 1];
  if (successivo === undefined) return ordinati[base]!;
  return ordinati[base]! + resto * (successivo - ordinati[base]!);
}

function arrotonda(ore: number): number {
  return Math.round(ore * 10) / 10;
}

/**
 * Le statistiche della finestra. Funzione pura: le righe arrivano dallo store e il
 * calcolo si prova con dati scritti a mano, senza database e senza rete.
 *
 * L'unità è il concorso, non la vista: due fonti sullo stesso concorso sono UN
 * caso. Si raggruppa per `itemId`, che è già l'identificatore del concorso — i
 * duplicati non creano righe nuove in `items`, quindi due copie dello stesso
 * concorso portano lo stesso id.
 */
export function summarizeLead(sightings: Sighting[], now: Date): LeadStats {
  const per = new Map<number, Sighting[]>();
  let inizio: number | null = null;
  for (const row of sightings) {
    if (!row.kept || row.kind !== "contest") continue;
    const at = Date.parse(row.seenAt);
    if (!Number.isFinite(at) || row.itemId === null) continue;
    if (inizio === null || at < inizio) inizio = at;
    const gruppo = per.get(row.itemId);
    if (gruppo) gruppo.push(row);
    else per.set(row.itemId, [row]);
  }

  const delta: number[] = [];
  let avanti = 0;
  let dietro = 0;
  let insieme = 0;
  let soloDiretti = 0;
  let soloAggregatori = 0;
  const fasce = { entro6h: 0, entroGiorno: 0, entro3giorni: 0, oltre: 0 };

  for (const righe of per.values()) {
    const canali = primaVistaPerCanale(righe);
    if (canali.brand === null && canali.aggregatore === null) continue;
    if (canali.brand === null) {
      soloAggregatori++;
      continue;
    }
    if (canali.aggregatore === null) {
      soloDiretti++;
      continue;
    }
    const ore = (canali.aggregatore - canali.brand) / ORA_MS;
    delta.push(ore);
    if (ore > 0) {
      avanti++;
      if (ore < 6) fasce.entro6h++;
      else if (ore < 24) fasce.entroGiorno++;
      else if (ore < 72) fasce.entro3giorni++;
      else fasce.oltre++;
    } else if (ore < 0) {
      dietro++;
    } else {
      insieme++;
    }
  }

  delta.sort((a, b) => a - b);
  const mediana = delta.length > 0 ? arrotonda(quantile(delta, 0.5)) : null;
  const p25 = delta.length > 0 ? arrotonda(quantile(delta, 0.25)) : null;
  const p75 = delta.length > 0 ? arrotonda(quantile(delta, 0.75)) : null;

  return {
    concorsi: per.size,
    daGiorni: inizio === null ? 0 : Math.max(1, Math.ceil((now.getTime() - inizio) / 86_400_000)),
    confrontabili: delta.length,
    avanti,
    dietro,
    insieme,
    medianaOre: mediana,
    p25Ore: p25,
    p75Ore: p75,
    soloDiretti,
    soloAggregatori,
    fasce,
  };
}
