import test from "node:test";
import assert from "node:assert/strict";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { decodeBody } from "@seo/crawler";

async function collect(chunks: Uint8Array[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

const sourceOf = (data: Uint8Array): AsyncIterable<Uint8Array> =>
  (async function* () {
    // Split into small chunks to exercise streaming/backpressure paths.
    for (let offset = 0; offset < data.byteLength; offset += 64) {
      yield data.subarray(offset, offset + 64);
    }
  })();

const payload = new TextEncoder().encode("<html>" + "x".repeat(500) + "</html>");
const CAP = 64 * 1024;

test("decodes gzip responses chunk by chunk", async () => {
  const body = await collect(await Array.fromAsync(decodeBody(sourceOf(gzipSync(payload)), "gzip", CAP)));
  assert.deepEqual(body, payload);
});

test("decodes deflate and brotli responses", async () => {
  const deflated = await collect(await Array.fromAsync(decodeBody(sourceOf(deflateSync(payload)), "deflate", CAP)));
  assert.deepEqual(deflated, payload);
  const brotlied = await collect(await Array.fromAsync(decodeBody(sourceOf(brotliCompressSync(payload)), "br", CAP)));
  assert.deepEqual(brotlied, payload);
});

test("identity and unknown encodings pass bytes through untouched", async () => {
  assert.deepEqual(await collect(await Array.fromAsync(decodeBody(sourceOf(payload), "identity", CAP))), payload);
  assert.deepEqual(await collect(await Array.fromAsync(decodeBody(sourceOf(payload), "", CAP))), payload);
  // An encoding we never advertised and cannot decode: pass through as-is.
  assert.deepEqual(await collect(await Array.fromAsync(decodeBody(sourceOf(payload), "compress", CAP))), payload);
});

test("compressed byte cap raises BodyTooLargeError", async () => {
  await assert.rejects(Array.fromAsync(decodeBody(sourceOf(gzipSync(payload)), "gzip", 8)), (error: unknown) => {
    assert.equal((error as Error).name, "BodyTooLargeError");
    return true;
  });
});

test("corrupt compressed data surfaces as a stream error", async () => {
  await assert.rejects(Array.fromAsync(decodeBody(sourceOf(new Uint8Array([1, 2, 3, 4])), "gzip", CAP)));
});
