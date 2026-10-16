/**
 * Parsing e matching di robots.txt (implementazione compatta, senza dipendenze).
 * Regola standard: vince la corrispondenza più lunga tra Allow e Disallow.
 */

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
}

const EMPTY: RobotsRules = { allow: [], disallow: [], crawlDelay: null };

/**
 * Come si scrive il motivo quando robots.txt ci vieta la raccolta: in archivio,
 * in chat e nei report. Non è un guasto della fonte — la fonte risponde, siamo
 * noi a non poterla leggere — e senza un testo condiviso la riga in chat
 * resterebbe senza codice HTTP e senza spiegazione.
 */
export const ROBOTS_DENIED_REASON = "robots.txt vieta la raccolta";

/** Estrae i gruppi che si applicano al nostro User-Agent (con fallback su "*"). */
export function parseRobots(body: string, userAgent: string): RobotsRules {
  const uaLower = userAgent.toLowerCase();
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastDirectiveWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!lastDirectiveWasAgent || current === null) {
        current = { agents: [], rules: { allow: [], disallow: [], crawlDelay: null } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastDirectiveWasAgent = true;
      continue;
    }
    lastDirectiveWasAgent = false;
    if (current === null) continue;

    if (field === "disallow" && value.length > 0) current.rules.disallow.push(value);
    else if (field === "allow") current.rules.allow.push(value);
    else if (field === "crawl-delay") {
      const delay = Number.parseFloat(value);
      if (Number.isFinite(delay)) current.rules.crawlDelay = delay;
    }
  }

  const specific = groups.filter(
    (g) => g.agents.some((a) => a !== "*" && uaLower.includes(a)),
  );
  const wildcard = groups.filter((g) => g.agents.includes("*"));
  const chosen = specific.length > 0 ? specific : wildcard;
  if (chosen.length === 0) return { ...EMPTY, allow: [], disallow: [], crawlDelay: null };

  return chosen.reduce<RobotsRules>(
    (acc, group) => ({
      allow: [...acc.allow, ...group.rules.allow],
      disallow: [...acc.disallow, ...group.rules.disallow],
      crawlDelay: group.rules.crawlDelay ?? acc.crawlDelay,
    }),
    { allow: [], disallow: [], crawlDelay: null },
  );
}

/** Un pattern robots.txt contro un path: supporta "*" e "$" finale. */
export function matchesRule(rule: string, path: string): boolean {
  if (rule === "" || rule === "/") return true;
  let pattern = rule;
  let anchoredEnd = false;
  if (pattern.endsWith("$")) {
    anchoredEnd = true;
    pattern = pattern.slice(0, -1);
  }
  const escaped = pattern
    .split("*")
    .map((chunk) => chunk.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  const regex = new RegExp(`^${escaped}${anchoredEnd ? "$" : ""}`);
  return regex.test(path);
}

export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  const matchLength = (patterns: string[]): number =>
    patterns.reduce((best, rule) => (matchesRule(rule, path) ? Math.max(best, rule.length) : best), -1);

  const disallow = matchLength(rules.disallow);
  if (disallow < 0) return true;
  const allow = matchLength(rules.allow);
  return allow >= disallow;
}

/** Estrae l'origine (schema + host) da un URL, o null se non è valido. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}
