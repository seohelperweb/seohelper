import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import type * as dns from "node:dns";
import { Transform, Readable, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { classifyIpAddress } from "./address-classification.ts";
import { BodyTooLargeError, SafeFetchError } from "./safe-fetch.ts";
import type { DnsResolver, Transport, TransportRequest, TransportResponse } from "./safe-fetch.ts";

/**
 * Production transport wiring (docs/ARCHITECTURE.md §11):
 * - DNS resolves all A/AAAA records; every address must classify PUBLIC.
 * - The chosen validated address is pinned as the TCP destination via a
 *   custom `lookup`, while Host header and TLS SNI keep the original
 *   hostname — this closes the TOCTOU/DNS-rebinding window between the
 *   safety check and the actual connection.
 * - No automatic redirects (safeFetch drives hops), no cookies, no custom
 *   proxy support.
 */

export function createDnsResolver(resolver = new Resolver()): DnsResolver {
  return async (hostname) => {
    if (isIP(hostname)) return [hostname];
    const [v4, v6] = await Promise.all([
      resolver.resolve4(hostname).catch(() => [] as string[]),
      resolver.resolve6(hostname).catch(() => [] as string[]),
    ]);
    return [...v4, ...v6];
  };
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

export function validatedLookup(dnsResolve: DnsResolver): import("node:net").LookupFunction {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    void dnsResolve(hostname)
      .then((addresses) => {
        if (addresses.some((address) => classifyIpAddress(address) !== "PUBLIC")) {
          callback(new SafeFetchError("SECURITY_BLOCKED", `non-public DNS address for ${hostname}`), "");
          return;
        }
        const publicAddress = addresses[0];
        if (publicAddress === undefined) {
          const error = new Error(`no public address for ${hostname}`) as NodeJS.ErrnoException;
          error.code = "ENOTFOUND";
          callback(error, "");
          return;
        }
        const family = isIP(publicAddress);
        if (options.all) callback(null, [{ address: publicAddress, family }]);
        else callback(null, publicAddress, family);
      })
      .catch((error: NodeJS.ErrnoException) => {
        callback(error, "");
      });
  };
}

/**
 * Stream a response body, transparently decoding Content-Encoding
 * (gzip/deflate/br) and capping the COMPRESSED byte count — the decompressed
 * cap is enforced by safeFetch (docs/ARCHITECTURE.md §7.3 caps both).
 */
export async function* decodeBody(
  source: AsyncIterable<Uint8Array>,
  contentEncoding: string,
  maxCompressedBytes: number,
): AsyncGenerator<Uint8Array> {
  const encoding = contentEncoding.trim().toLowerCase();
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      total += chunk.byteLength;
      if (total > maxCompressedBytes) {
        callback(new BodyTooLargeError(`compressed body exceeded ${maxCompressedBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });

  // Only encodings we advertised (gzip) or can safely decode are unwrapped;
  // anything else passes through untouched and fails HTML parsing upstream.
  const decoder =
    encoding === "gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : new PassThrough();
  const output = new PassThrough();
  // pipeline() propagates errors across every stage (plain pipe() does not);
  // we relay from `output` and surface failures to the consumer.
  const finished = pipeline(Readable.from(source, { objectMode: false }), counter, decoder, output).catch(
    (error: Error) => {
      output.destroy(error);
      return error;
    },
  );

  try {
    for await (const chunk of output) {
      yield chunk as Buffer;
    }
  } finally {
    output.destroy();
    await finished.catch(() => undefined);
  }
}

/** Build the production transport. Sends Accept-Encoding and streams the decoded body. */
export function createNodeTransport(
  dns: DnsResolver,
  defaults: { timeoutMs: number; maxBodyBytes?: number },
): Transport {
  const lookup = validatedLookup(dns);
  const maxCompressedBytes = defaults.maxBodyBytes ?? 2 * 1024 * 1024;
  return (spec: TransportRequest) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const url = spec.url;
      const sender = url.protocol === "https:" ? httpsRequest : httpRequest;
      const headers = { ...spec.headers, "accept-encoding": "gzip" };
      const outgoing = sender(
        {
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port === "" ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers,
          lookup,
          agent: false,
          // TLS SNI + certificate validation stay bound to the original hostname.
          ...(url.protocol === "https:" ? { servername: url.hostname, rejectUnauthorized: true } : {}),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const flatHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            flatHeaders[key] = Array.isArray(value) ? value.join(", ") : (value ?? "");
          }
          if (status >= 300 && status < 400) {
            // Redirect bodies are irrelevant and may never end; close immediately.
            response.destroy();
            resolve({ status, headers: flatHeaders, body: emptyBody() });
            return;
          }
          resolve({
            status,
            headers: flatHeaders,
            body: decodeBody(response, flatHeaders["content-encoding"] ?? "", maxCompressedBytes),
          });
        },
      );
      outgoing.setTimeout(spec.timeoutMs ?? defaults.timeoutMs, () => {
        outgoing.destroy(new TimeoutError(`request timed out after ${spec.timeoutMs ?? defaults.timeoutMs}ms`));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return (async function* () {})();
}
