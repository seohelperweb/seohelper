/**
 * robots.txt parsing and matching (RFC 9309 core semantics, docs/ARCHITECTURE.md §7.3).
 *
 * Longest-match rule wins between the most specific matching user-agent
 * group's Allow/Disallow rules; `*` and `$` wildcards are supported with a
 * hand-rolled linear matcher. Fetch outcomes (404/403/5xx) are a product
 * decision — see the conservative matrix in the architecture doc — this
 * module only interprets rule text.
 */

export interface RobotsRule {
  path: string;
  allow: boolean;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

interface Directive {
  key: string;
  value: string;
}

function parseDirective(line: string): Directive | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  return { key: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
}

export function parseRobots(source: string): ParsedRobots {
  const robots: ParsedRobots = { groups: [], sitemaps: [] };
  let currentAgents: string[] = [];
  let currentRules: RobotsRule[] = [];

  const flush = () => {
    if (currentAgents.length > 0) {
      robots.groups.push({ agents: currentAgents, rules: currentRules });
    }
    currentAgents = [];
    currentRules = [];
  };

  for (const rawLine of source.split(/\r\n|\r|\n/)) {
    const comment = rawLine.indexOf("#");
    const line = (comment === -1 ? rawLine : rawLine.slice(0, comment)).trim();
    if (line === "") continue;

    const directive = parseDirective(line);
    if (!directive) continue;
    if (directive.key === "sitemap") {
      if (directive.value !== "") robots.sitemaps.push(directive.value);
    } else if (directive.key === "user-agent") {
      if (currentRules.length > 0) flush(); // a new group starts after rules
      if (directive.value !== "") currentAgents.push(directive.value.toLowerCase());
    } else if (directive.key === "disallow") {
      currentRules.push({ path: directive.value, allow: false });
    } else if (directive.key === "allow") {
      currentRules.push({ path: directive.value, allow: true });
    }
  }
  flush();
  return robots;
}

/**
 * Match one robots rule path against a URL path (with query). `*` matches any
 * run of characters (including `/`); a trailing `$` anchors the end
 * (RFC 9309 §2.2.3). Returns the rule's specificity — the original pattern
 * length, per the longest-entry-wins rule — or -1 when it does not match.
 */
export function robotsRuleMatches(pattern: string, pathWithQuery: string): number {
  if (pattern === "") return -1;
  const anchoredEnd = pattern.endsWith("$");
  const effective = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const segments = effective.split("*");

  let pos = 0;
  const startsWith = (segment: string, at: number) => pathWithQuery.startsWith(segment, at);

  // First segment must match at position 0.
  if (!startsWith(segments[0] ?? "", 0)) return -1;
  pos = (segments[0] ?? "").length;

  if (segments.length === 1) {
    // No wildcard: with `$` the whole path must equal the pattern.
    if (anchoredEnd && pos !== pathWithQuery.length) return -1;
    return pattern.length;
  }

  // Middle segments: first occurrence after the previous position.
  for (let i = 1; i < segments.length - 1; i += 1) {
    const found = pathWithQuery.indexOf(segments[i], pos);
    if (found === -1) return -1;
    pos = found + segments[i].length;
  }

  // Last segment must match at the end of the path.
  const last = segments[segments.length - 1];
  if (last === "") return pattern.length; // trailing `*`
  const lastIndex = pathWithQuery.length - last.length;
  if (lastIndex < pos || !startsWith(last, lastIndex)) return -1;
  return pattern.length;
}

function selectGroup(robots: ParsedRobots, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  let star: RobotsGroup | null = null;
  for (const group of robots.groups) {
    if (group.agents.includes(ua)) return group;
    if (group.agents.includes("*")) star = star ?? group;
  }
  return star;
}

export function isAllowedByRobots(robots: ParsedRobots, userAgent: string, url: URL): boolean {
  const group = selectGroup(robots, userAgent);
  if (!group) return true; // no applicable group → unrestricted (RFC 9309 §2.2.1)
  const pathWithQuery = `${url.pathname}${url.search}`;

  let bestLength = -1;
  let bestAllow = true; // default allow when no rule matches
  for (const rule of group.rules) {
    if (rule.path === "") continue; // "Disallow:" with empty value allows everything
    const matched = robotsRuleMatches(rule.path, pathWithQuery);
    if (matched > bestLength || (matched === bestLength && rule.allow)) {
      bestLength = matched;
      bestAllow = rule.allow;
    }
  }
  return bestAllow;
}
