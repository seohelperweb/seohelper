import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedByRobots, parseRobots, robotsRuleMatches } from "@seo/crawler";

test("rule matcher honours longest match, wildcards, and end anchor", () => {
  // Specificity = original pattern length per RFC 9309 longest-entry rule.
  assert.equal(robotsRuleMatches("/admin", "/admin"), 6);
  assert.equal(robotsRuleMatches("/admin", "/admin/login"), 6);
  assert.equal(robotsRuleMatches("/admin$", "/admin"), 7);
  assert.equal(robotsRuleMatches("/admin$", "/admin/login"), -1);
  assert.equal(robotsRuleMatches("/*.php$", "/a/b.php"), 7);
  assert.equal(robotsRuleMatches("/*.php$", "/a/b.php?x=1"), -1);
  assert.equal(robotsRuleMatches("/a*/c", "/a/b/c"), 5);
  assert.equal(robotsRuleMatches("", "/anything"), -1);
  assert.equal(robotsRuleMatches("/x", "/y"), -1);
});

test("parses groups, comments, sitemaps, and empty disallow", () => {
  const robots = parseRobots(`
# comment
User-agent: IndexlyBot
Disallow: /private/
Allow: /private/public$

User-agent: *
Disallow:

Sitemap: https://example.com/sitemap.xml
`);
  assert.deepEqual(robots.sitemaps, ["https://example.com/sitemap.xml"]);
  assert.equal(robots.groups.length, 2);
  const [bot, star] = robots.groups;
  assert.deepEqual(bot.agents, ["indexlybot"]);
  assert.deepEqual(bot.rules, [
    { path: "/private/", allow: false },
    { path: "/private/public$", allow: true },
  ]);
  assert.deepEqual(star.rules, [{ path: "", allow: false }]);
});

test("most specific agent group wins; star group is the fallback", () => {
  const robots = parseRobots(`
User-agent: *
Disallow: /

User-agent: indexlybot
Disallow: /secret/
`);
  const url = (path: string) => new URL(`https://example.com${path}`);
  // IndexlyBot uses its own group only: / allowed, /secret/ blocked.
  assert.equal(isAllowedByRobots(robots, "IndexlyBot", url("/")), true);
  assert.equal(isAllowedByRobots(robots, "IndexlyBot", url("/secret/a")), false);
  // Other agents fall back to *: everything blocked.
  assert.equal(isAllowedByRobots(robots, "Googlebot", url("/")), false);
  // Allow beats equally-long Disallow.
  const tie = parseRobots("User-agent: *\nAllow: /ok\nDisallow: /ok\n");
  assert.equal(isAllowedByRobots(tie, "x", url("/ok")), true);
});

test("absence of an applicable group means unrestricted", () => {
  const robots = parseRobots("User-agent: googlebot\nDisallow: /\n");
  assert.equal(isAllowedByRobots(robots, "indexlybot", new URL("https://example.com/anything")), true);
});
