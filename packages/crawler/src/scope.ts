/**
 * Crawl scope. First version covers exactly one hostname per project
 * (docs/ARCHITECTURE.md §4): subdomains — including www — and non-default
 * ports are separate projects, never automatically merged.
 */

export function isSameDomain(candidate: string, root: string): boolean {
  return new URL(candidate).hostname === new URL(root).hostname;
}
