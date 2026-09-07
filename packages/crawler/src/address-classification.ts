import { isIP } from "node:net";

/**
 * Literal IP address classification (docs/ARCHITECTURE.md §11).
 *
 * "PUBLIC" only means "not reserved for private or special use" — it is not a
 * security verdict by itself. DNS must still be resolved by the fetch worker
 * and every resolved address re-checked (P2), including after redirects.
 */

export const ADDRESS_CLASSES = [
  "PUBLIC",
  "PRIVATE",
  "LOOPBACK",
  "LINK_LOCAL",
  "UNSPECIFIED",
  "MULTICAST",
  "RESERVED",
] as const;
export type AddressClass = (typeof ADDRESS_CLASSES)[number];

const hexGroup = /^[0-9a-f]{1,4}$/;

function parseIpv4ToNumber(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

export function classifyIpv4FromNumber(n: number): AddressClass {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8) & 0xff;
  if (a === 0) return "UNSPECIFIED";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "PRIVATE";
  if (a === 127) return "LOOPBACK";
  if (a === 169 && b === 254) return "LINK_LOCAL";
  if (a === 100 && b >= 64 && b <= 127) return "PRIVATE"; // RFC 6598 carrier-grade NAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "RESERVED";
  if (a === 198 && (b === 18 || b === 19)) return "RESERVED"; // RFC 2544 benchmark range 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return "RESERVED"; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "RESERVED"; // TEST-NET-3
  if (a >= 224 && a < 240) return "MULTICAST";
  if (a >= 240) return "RESERVED";
  return "PUBLIC";
}

/** Parse an IPv6 literal (brackets removed) into a 128-bit BigInt. Handles `::`, embedded dotted-quad tails, and `%zone` suffixes. */
export function parseIpv6(address: string): bigint | null {
  const zoneIndex = address.indexOf("%");
  const literal = zoneIndex === -1 ? address : address.slice(0, zoneIndex);
  const sections = literal.split("::");
  if (sections.length > 2) return null;

  const parseGroups = (section: string): bigint[] | null => {
    if (section === "") return [];
    const groups: bigint[] = [];
    for (const piece of section.split(":")) {
      if (piece.includes(".")) {
        const embedded = parseIpv4ToNumber(piece);
        if (embedded === null) return null;
        groups.push(BigInt(embedded >>> 16), BigInt(embedded & 0xffff));
      } else {
        if (!hexGroup.test(piece)) return null;
        groups.push(BigInt(parseInt(piece, 16)));
      }
    }
    return groups;
  };

  const head = parseGroups(sections[0]);
  if (head === null) return null;
  const tail = sections.length === 2 ? parseGroups(sections[1]) : [];
  if (tail === null) return null;

  const groupCount = head.length + tail.length;
  if (sections.length === 2) {
    if (groupCount > 8) return null;
  } else if (groupCount !== 8) {
    return null;
  }
  const fill = 8 - groupCount;
  const groups = sections.length === 2 ? [...head, ...Array.from<bigint>({ length: fill }).fill(0n), ...tail] : head;
  return groups.reduce((value, group) => (value << 16n) | group, 0n);
}

export function classifyIpv6FromValue(v: bigint): AddressClass {
  if (v === 0n) return "UNSPECIFIED";
  if (v === 1n) return "LOOPBACK";
  // IPv4-mapped (::ffff:0:0/96) — classify the embedded IPv4 address.
  if (v >> 32n === 0xffffn) return classifyIpv4FromNumber(Number(v & 0xffffffffn));
  // NAT64 well-known prefix (64:ff9b::/96) — classify the translated IPv4 address.
  if (v >> 32n === 0x0064ff9bn << 64n) return classifyIpv4FromNumber(Number(v & 0xffffffffn));
  // 6to4 (2002::/16) — the public IPv4 tunnel endpoint lives in bits 16-47.
  if (v >> 112n === 0x2002n) return classifyIpv4FromNumber(Number((v >> 80n) & 0xffffffffn));
  // Teredo (2001::/32) and documentation (2001:db8::/32) ranges.
  if (v >> 96n === 0x20010000n || v >> 96n === 0x20010db8n) return "RESERVED";
  if (v >= 0xfe80n << 112n && v < 0xfec0n << 112n) return "LINK_LOCAL"; // fe80::/10
  if (v >= 0xfc00n << 112n && v < 0xfe00n << 112n) return "PRIVATE"; // fc00::/7 unique local
  if (v >> 120n === 0xffn) return "MULTICAST"; // ff00::/8
  // Remaining ::/96 covers the deprecated IPv4-compatible form (e.g. ::127.0.0.1).
  if (v >> 96n === 0n) return "RESERVED";
  return "PUBLIC";
}

/**
 * Classify a literal IPv4 or IPv6 address. Returns null for hostnames and
 * anything that is not a syntactically valid address literal.
 */
export function classifyIpAddress(address: string): AddressClass | null {
  const version = isIP(address);
  if (version === 4) {
    const n = parseIpv4ToNumber(address);
    return n === null ? null : classifyIpv4FromNumber(n);
  }
  if (version === 6) {
    const v = parseIpv6(address);
    return v === null ? null : classifyIpv6FromValue(v);
  }
  return null;
}

export function isPubliclyRoutableAddress(address: string): boolean {
  return classifyIpAddress(address) === "PUBLIC";
}
