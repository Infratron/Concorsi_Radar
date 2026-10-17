import type { Insight, ItemRow } from "../types.ts";
import { normalizeTitle } from "../lib/text.ts";

/**
 * Punteggio 0-100 = "quanto vale la pena guardare questo concorso adesso".
 * Pesi trasparenti e modificabili: valore del premio, sforzo richiesto,
 * urgenza della scadenza, freschezza della notizia, segnali di qualità.
 * I pesi appresi dai bottoni ✅/🚫 si sommano sopra questo punteggio, e sopra
 * quelli la marca seguita (⭐ Preferiti per marca).
 */

export const SCORE_WEIGHTS = {
  prizeValue: 30,
  effort: 20,
  deadlineSoon: 18,
  deadlineApproaching: 12,
  deadlineUnknown: 2,
  deadlineExpired: -10,
  freshToday: 12,
  freshThisWeek: 6,
  noPurchase: 10,
  keywordBonus: 5,
  weakTitle: -5,
  learningStep: 3,
  /**
   * Marca seguita: 10 punti, cioè più di tutti i segnali di qualità (un premio
   * certo vale 5) e meno dell'urgenza di una scadenza. Serve a far salire una
   * marca che segui sopra la coda di concorsi anonimi, non a farla vincere su un
   * concorso con un premio vero.
   */
  favoriteBrand: 10,
} as const;

const BONUS_PATTERN = /\b(gift ?card|buono spesa|contanti|in palio|montepremi|premio immediato|vincita sicura)\b/;

function daysUntil(deadline: string, now: Date): number {
  const [y, m, d] = deadline.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000);
}

/** Punteggio base, senza preferenze personali. */
export function baseScore(
  insight: Insight,
  item: { title: string; summary: string; publishedAt?: string | null; firstSeenAt?: string | null },
  now: Date,
): number {
  let score = insight.prizeValue * SCORE_WEIGHTS.prizeValue + insight.effort * SCORE_WEIGHTS.effort;

  if (insight.deadline) {
    const left = daysUntil(insight.deadline, now);
    if (left < 0) score += SCORE_WEIGHTS.deadlineExpired;
    else if (left <= 3) score += SCORE_WEIGHTS.deadlineSoon;
    else if (left <= 14) score += SCORE_WEIGHTS.deadlineApproaching;
  } else {
    score += SCORE_WEIGHTS.deadlineUnknown;
  }

  const reference = item.publishedAt ?? item.firstSeenAt ?? null;
  if (reference) {
    const seen = Date.parse(reference);
    if (Number.isFinite(seen)) {
      const ageHours = (now.getTime() - seen) / 3_600_000;
      if (ageHours <= 24) score += SCORE_WEIGHTS.freshToday;
      else if (ageHours <= 24 * 7) score += SCORE_WEIGHTS.freshThisWeek;
    }
  }

  if (!insight.requiresPurchase) score += SCORE_WEIGHTS.noPurchase;
  if (BONUS_PATTERN.test(normalizeTitle(`${item.title} ${item.summary}`))) score += SCORE_WEIGHTS.keywordBonus;
  if (item.title.trim().length < 18 || item.summary.trim().length === 0) score += SCORE_WEIGHTS.weakTitle;

  return clamp(Math.round(score));
}

/** Applica i pesi appresi: ogni +1 su un tag vale learningStep punti. */
export function applyWeights(score: number, tags: string[], weights: Record<string, number>): number {
  let delta = 0;
  for (const tag of tags) {
    const weight = weights[tag];
    if (typeof weight === "number" && Number.isFinite(weight)) delta += weight;
  }
  return clamp(Math.round(score + delta * SCORE_WEIGHTS.learningStep));
}

/**
 * Il bonus della marca seguita. `favorites` è l'insieme delle marche che le chat
 * seguono (una sola chat, di norma: vedi mergedBrands in src/pipeline.ts).
 * Non è un peso appreso: quelli sono ±1 per volta, questo è la decisione
 * esplicita dell'utente, e vale quanto dieci tocchi.
 */
export function applyBrandBonus(
  score: number,
  brand: string | null | undefined,
  favorites: Iterable<string>,
): number {
  if (!brand) return score;
  const insieme = favorites instanceof Set ? favorites : new Set(favorites);
  return insieme.has(brand) ? clamp(Math.round(score + SCORE_WEIGHTS.favoriteBrand)) : score;
}

export function scoreItem(
  insight: Insight,
  item: {
    title: string;
    summary: string;
    publishedAt?: string | null;
    firstSeenAt?: string | null;
    brand?: string | null;
  },
  weights: Record<string, number>,
  now: Date,
  favorites: Iterable<string> = [],
): number {
  return applyBrandBonus(applyWeights(baseScore(insight, item, now), insight.tags, weights), item.brand, favorites);
}

/**
 * L'insight di una riga d'archivio: sono gli stessi campi che la pipeline aveva
 * in ingresso, quindi il conto che ne esce è lo stesso di un'ingestione e non
 * una seconda formula da tenere allineata.
 */
export function insightFromRow(row: ItemRow): Insight {
  return {
    deadline: row.deadline,
    prize: row.prize,
    participation: row.participation,
    prizeValue: row.prizeValue,
    effort: row.effort,
    requiresPurchase: row.requiresPurchase,
    tags: row.tags,
    aiUsed: row.aiUsed,
  };
}

/**
 * Il punteggio di una riga d'archivio con le preferenze di ADESSO.
 *
 * Perché serve: il punteggio si calcola quando il concorso entra in archivio, ma
 * i preferiti cambiano dopo — e accendere Ferrero oggi deve alzare anche i
 * concorsi Ferrero raccolti ieri.
 */
export function rescoreRow(
  row: ItemRow,
  weights: Record<string, number>,
  favorites: Iterable<string>,
  now: Date,
): number {
  return scoreItem(insightFromRow(row), row, weights, now, favorites);
}

/**
 * Una voce del punteggio: quanto ha aggiunto, e quanto poteva aggiungere.
 * `max` null = senza tetto (i pesi appresi crescono con i tuoi tocchi).
 * `points` negativo = una voce che ha tolto punti, e va mostrata col segno.
 */
export interface ScorePart {
  key: string;
  label: string;
  points: number;
  max: number | null;
}

export interface ScoreExplanation {
  parts: ScorePart[];
  /** La somma delle voci: è il punteggio con i gusti di ADESSO. */
  total: number;
}

/**
 * Le voci del punteggio, nell'ordine in cui si leggono: prima quello che il
 * concorso offre, poi quanto costa, poi quando scade, poi i segnali forti e
 * infine le due cose che dipendono da te (gusti e marche seguite).
 */
const VOCI: Array<{ key: string; label: string; max: number | null }> = [
  { key: "premio", label: "🏆 Premio", max: SCORE_WEIGHTS.prizeValue },
  { key: "sforzo", label: "💪 Sforzo", max: SCORE_WEIGHTS.effort },
  { key: "scadenza", label: "⏳ Scadenza", max: SCORE_WEIGHTS.deadlineSoon },
  { key: "freschezza", label: "🕐 Freschezza", max: SCORE_WEIGHTS.freshToday },
  { key: "senzaAcquisto", label: "🆓 Senza acquisto", max: SCORE_WEIGHTS.noPurchase },
  { key: "parole", label: "🔑 Parole chiave", max: SCORE_WEIGHTS.keywordBonus },
  { key: "titolo", label: "✂️ Titolo debole", max: 0 },
];

/**
 * Spacca il punteggio nelle sue voci, con numeri che SOMMANO al punteggio vero.
 *
 * Perché non si ricalcola a mano: il punteggio passa per tre arrotondamenti (base,
 * pesi appresi, marca) e per due limiti a 0-100, e una spiegazione che non torna
 * col numero mostrato è peggio di nessuna spiegazione — è il numero che decide se
 * un concorso passa il filtro delle stelle. Quindi le voci si arrotondano
 * distribuendo il resto (chi ha la parte decimale più alta prende il punto), il
 * tetto a 100 e il pavimento a 0 diventano voci esplicite, e i due contributi
 * personali sono già interi per costruzione.
 */
export function explainScore(
  insight: Insight,
  item: { title: string; summary: string; publishedAt?: string | null; firstSeenAt?: string | null; brand?: string | null },
  weights: Record<string, number>,
  now: Date,
  favorites: Iterable<string> = [],
): ScoreExplanation {
  const grezze: Record<string, number> = {
    premio: insight.prizeValue * SCORE_WEIGHTS.prizeValue,
    sforzo: insight.effort * SCORE_WEIGHTS.effort,
    scadenza: SCORE_WEIGHTS.deadlineUnknown,
    freschezza: 0,
    senzaAcquisto: insight.requiresPurchase ? 0 : SCORE_WEIGHTS.noPurchase,
    parole: BONUS_PATTERN.test(normalizeTitle(`${item.title} ${item.summary}`)) ? SCORE_WEIGHTS.keywordBonus : 0,
    titolo: item.title.trim().length < 18 || item.summary.trim().length === 0 ? SCORE_WEIGHTS.weakTitle : 0,
  };

  if (insight.deadline) {
    const left = daysUntil(insight.deadline, now);
    grezze.scadenza =
      left < 0
        ? SCORE_WEIGHTS.deadlineExpired
        : left <= 3
          ? SCORE_WEIGHTS.deadlineSoon
          : left <= 14
            ? SCORE_WEIGHTS.deadlineApproaching
            : 0;
  }
  const reference = item.publishedAt ?? item.firstSeenAt ?? null;
  if (reference) {
    const seen = Date.parse(reference);
    if (Number.isFinite(seen)) {
      const ageHours = (now.getTime() - seen) / 3_600_000;
      grezze.freschezza = ageHours <= 24 ? SCORE_WEIGHTS.freshToday : ageHours <= 24 * 7 ? SCORE_WEIGHTS.freshThisWeek : 0;
    }
  }

  const chiaviBase = ["premio", "sforzo", "scadenza", "freschezza", "senzaAcquisto", "parole", "titolo"];
  const vociBase = chiaviBase.map((key) => VOCI.find((voce) => voce.key === key)!);
  const grezzeBase = chiaviBase.map((key) => grezze[key]);

  // I tre passaggi veri, per non duplicare la formula: base → pesi → marca.
  const base = baseScore(insight, item, now);
  const dopoPesi = applyWeights(base, insight.tags, weights);
  const total = applyBrandBonus(dopoPesi, item.brand, favorites);

  // Arrotonda le voci distribuendo il resto, così la somma fa esattamente
  // `Math.round(sommaGrezza)`; il tetto e il pavimento restano a parte, perché
  // sono tagli veri e non arrotondamenti.
  const sommaGrezza = grezzeBase.reduce((somma, valore) => somma + valore, 0);
  const arrotondate = distribuisci(grezzeBase, Math.round(sommaGrezza));
  const parts: ScorePart[] = vociBase.map((voce, indice) => ({
    key: voce.key,
    label: voce.label,
    points: arrotondate[indice],
    max: voce.max,
  }));

  const taglio = base - Math.round(sommaGrezza);
  if (taglio !== 0) {
    // La base è stata tagliata dai limiti 0-100: dirlo è parte della spiegazione.
    parts.push({
      key: "limite",
      label: taglio < 0 ? "🚧 Tetto 100" : "🏁 Minimo 0",
      points: taglio,
      max: 0,
    });
  }

  // I due contributi personali sono già interi: si prendono per differenza, che è
  // l'unico modo per non sbagliare di un punto fra due arrotondamenti.
  const gusti = dopoPesi - base;
  if (gusti !== 0) {
    parts.push({ key: "gusti", label: "🏷 I tuoi gusti", points: gusti, max: null });
  }
  const marca = total - dopoPesi;
  if (marca !== 0) {
    parts.push({ key: "marca", label: "⭐ Marca seguita", points: marca, max: SCORE_WEIGHTS.favoriteBrand });
  }

  return { parts, total };
}

/**
 * Arrotonda dei valori tenendo fissa la loro somma. Chi ha la parte decimale più
 * alta prende i punti che avanzano (o li perde, se la somma va abbassata): è
 * l'arrotondamento che non fa mentire un elenco di numeri.
 */
function distribuisci(valori: number[], totale: number): number[] {
  const arrotondati = valori.map((valore) => Math.round(valore));
  let resto = totale - arrotondati.reduce((somma, valore) => somma + valore, 0);
  const ordine = valori
    .map((valore, indice) => ({ indice, frazione: valore - Math.floor(valore) }))
    .sort((a, b) => b.frazione - a.frazione);
  let giro = 0;
  while (resto !== 0 && ordine.length > 0 && giro < Math.abs(resto) + ordine.length * 100) {
    const voce = ordine[giro % ordine.length];
    if (resto > 0) {
      arrotondati[voce.indice] += 1;
      resto -= 1;
    } else {
      arrotondati[voce.indice] -= 1;
      resto += 1;
    }
    giro += 1;
  }
  return arrotondati;
}

export function clamp(score: number): number {
  return Math.max(0, Math.min(100, score));
}
