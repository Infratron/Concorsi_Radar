import type { AiBinding, Insight } from "../types.ts";
import type { Store } from "../db/store.ts";
import { truncate } from "../lib/text.ts";

/**
 * Workers AI entra in gioco SOLO sui casi dubbi: quando le regole non hanno
 * trovato né scadenza né premio né tag. Sul piano Free ci sono 10.000
 * Neurons/giorno, quindi teniamo un tetto giornaliero esplicito e un fallback
 * silenzioso alle regole: mai un errore, mai un blocco della pipeline.
 */

/** Modello piccolo: sufficiente per normalizzare una data o un premio. */
export const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";
/** Stima prudente di consumo per chiamata: sotto il tetto, non sopra. */
export const ASSUMED_NEURONS_PER_CALL = 250;
/** Tetto prudente: 40 chiamate ≈ 10.000 Neurons. */
export const MAX_NEURONS_PER_DAY = 10_000;
/** Massimo chiamate AI per singola esecuzione: la pipeline non deve rallentare. */
export const MAX_AI_CALLS_PER_RUN = 3;

export interface AiDeps {
  ai: AiBinding | null;
  store: Store;
  now: Date;
  maxNeuronsPerDay?: number;
  assumedNeuronsPerCall?: number;
  maxCallsPerRun?: number;
}

/** Vale la pena spendere una chiamata AI su questo item? */
export function needsAi(insight: Insight, item: { title: string; summary: string }): boolean {
  const textLength = item.summary.trim().length;
  if (textLength < 40) return false; // troppo poco testo: l'AI inventerebbe
  if (insight.deadline === null) return true;
  if (insight.prize === null) return true;
  return false;
}

function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown, maxLength = 160): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "null") return null;
  return truncate(trimmed, maxLength);
}

function clamp01(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, Number(parsed.toFixed(2))));
}

function validDeadline(value: unknown, now: Date): string | null {
  const candidate = stringOrNull(value, 10);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const parsed = Date.parse(`${candidate}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  const deltaDays = (parsed - now.getTime()) / 86_400_000;
  return deltaDays >= -1 && deltaDays <= 730 ? candidate : null;
}

/**
 * Chiede all'AI i soli campi mancanti e restituisce una patch parziale.
 * Restituisce null se il budget è esaurito, se il modello risponde male o se
 * la risposta non contiene JSON valido: in tutti questi casi valgono le regole.
 */
export async function enrichWithAi(
  item: { title: string; summary: string },
  deps: AiDeps,
): Promise<Partial<Insight> | null> {
  if (!deps.ai) return null;

  const day = deps.now.toISOString().slice(0, 10);
  const maxNeurons = deps.maxNeuronsPerDay ?? MAX_NEURONS_PER_DAY;
  const perCall = deps.assumedNeuronsPerCall ?? ASSUMED_NEURONS_PER_CALL;
  const used = await deps.store.aiUsage(day);
  if (used + perCall > maxNeurons) return null;

  const prompt = [
    "Sei un estrattore di dati su concorsi a premi italiani.",
    "Rispondi SOLO con un oggetto JSON, senza commenti, con queste chiavi:",
    '{"deadline":"YYYY-MM-DD o null","prize":"testo breve o null","participation":"testo breve o null",',
    '"requires_purchase":true|false,"prize_value":0.0-1.0,"effort":0.0-1.0,"tags":["..."]}',
    "deadline è la data ultima per partecipare; se nel testo non c'è una data, metti null.",
    "prize_value stima il valore del premio, effort quanto è facile partecipare (1 = facilissimo).",
    "tags: al massimo 5 etichette brevi in italiano (es. giftcard, buoni_spesa, viaggio).",
    "",
    `TITOLO: ${truncate(item.title, 300)}`,
    `TESTO: ${truncate(item.summary, 1200)}`,
  ].join("\n");

  try {
    const response = await deps.ai.run(AI_MODEL, {
      messages: [
        { role: "system", content: "Estrai dati strutturati da testi italiani. Solo JSON valido." },
        { role: "user", content: prompt },
      ],
      max_tokens: 400,
      temperature: 0.1,
    });
    await deps.store.addAiUsage(day, 1, perCall);

    const text =
      typeof response === "string"
        ? response
        : response && typeof response === "object" && typeof (response as { response?: unknown }).response === "string"
          ? ((response as { response: string }).response)
          : "";
    const parsed = extractJson(text);
    if (!parsed) return null;

    const patch: Partial<Insight> = { aiUsed: true };
    const deadline = validDeadline(parsed.deadline, deps.now);
    if (deadline) patch.deadline = deadline;

    const prize = stringOrNull(parsed.prize);
    if (prize) patch.prize = prize;

    const participation = stringOrNull(parsed.participation);
    if (participation) patch.participation = participation;

    if (typeof parsed.requires_purchase === "boolean") patch.requiresPurchase = parsed.requires_purchase;
    if (parsed.prize_value !== undefined) patch.prizeValue = clamp01(parsed.prize_value, 0.3);
    if (parsed.effort !== undefined) patch.effort = clamp01(parsed.effort, 0.5);

    if (Array.isArray(parsed.tags)) {
      const tags = parsed.tags
        .map((tag) => stringOrNull(tag, 30))
        .filter((tag): tag is string => tag !== null)
        .slice(0, 5);
      if (tags.length > 0) patch.tags = tags;
    }

    return Object.keys(patch).length > 1 ? patch : null;
  } catch {
    // Nessuna eccezione propagata: l'arricchimento AI è un lusso, non un requisito.
    return null;
  }
}

/** Fonde la patch AI nelle regole, senza sovrascrivere ciò che le regole hanno già trovato. */
export function mergeInsight(base: Insight, patch: Partial<Insight>): Insight {
  return {
    deadline: base.deadline ?? patch.deadline ?? null,
    prize: base.prize ?? patch.prize ?? null,
    participation: base.participation ?? patch.participation ?? null,
    prizeValue: base.deadline === null && patch.deadline ? base.prizeValue : Math.max(base.prizeValue, patch.prizeValue ?? 0),
    effort: patch.effort !== undefined && base.effort === 0.5 ? patch.effort : base.effort,
    requiresPurchase: base.requiresPurchase || (patch.requiresPurchase ?? false),
    tags: [...new Set([...base.tags, ...(patch.tags ?? [])])],
    aiUsed: patch.aiUsed ?? base.aiUsed,
  };
}
