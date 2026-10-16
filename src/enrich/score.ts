import type { Insight } from "../types.ts";
import { normalizeTitle } from "../lib/text.ts";

/**
 * Punteggio 0-100 = "quanto vale la pena guardare questo concorso adesso".
 * Pesi trasparenti e modificabili: valore del premio, sforzo richiesto,
 * urgenza della scadenza, freschezza della notizia, segnali di qualità.
 * I pesi appresi dai bottoni ✅/🚫 si sommano sopra questo punteggio.
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

export function scoreItem(
  insight: Insight,
  item: { title: string; summary: string; publishedAt?: string | null; firstSeenAt?: string | null },
  weights: Record<string, number>,
  now: Date,
): number {
  return applyWeights(baseScore(insight, item, now), insight.tags, weights);
}

export function clamp(score: number): number {
  return Math.max(0, Math.min(100, score));
}
