import { AwsClient } from "aws4fetch";
import type { R2Config } from "./config";

// ============================================================
// The ONLY module in this codebase that talks to R2. Three operations —
// signed PUT, signed DELETE, and a presigned PUT URL for direct browser
// uploads — are all the app needs, because object keys are stored in our
// own rows rather than in a component-managed metadata table.
//
// `aws4fetch` signs with `fetch` + `SubtleCrypto`, so this runs in
// Convex's DEFAULT runtime: no `"use node"` (which
// `convex/lib/whatsappEncryption.ts:11` documents as a last resort, and
// which would restrict this file to exporting actions only). It is also
// the client Cloudflare itself documents for R2.
//
// `region: "auto"` and `service: "s3"` are required by the signing
// algorithm but ignored by R2.
// ============================================================

function awsClient(cfg: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
}

/** `endpoint/bucket/key`, each key segment percent-encoded. */
function objectUrl(cfg: R2Config, key: string): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${cfg.endpoint}/${cfg.bucket}/${encoded}`;
}

/**
 * Upload bytes we already hold server-side (inbound WhatsApp media, ad
 * referral images, and the Plan 2 backfill). Throws on a non-2xx so the
 * caller's best-effort wrapper can log and degrade.
 */
export async function putObject(
  cfg: R2Config,
  args: { key: string; body: Blob; contentType: string },
): Promise<void> {
  // R2's S3 API answers `411 Length Required` to a chunked upload, and a
  // `Blob` handed straight to `fetch` is streamed WITHOUT a Content-Length
  // once it is big enough. That is why this failed only on real inbound
  // media (a 1.1 MB photo) while a 3 KB probe and every stubbed-fetch test
  // passed — small bodies happened to go out with a length.
  //
  // Reading into a fixed-length view and stating the length explicitly
  // removes the dependency on the runtime's streaming heuristic entirely.
  // Note this interacts with the `X-Amz-Content-Sha256` header below:
  // that header tells aws4fetch to skip hashing the body, which also skips
  // the internal buffering that used to mask this. The two are only safe
  // together because the bytes are materialized here first.
  const bytes = new Uint8Array(await args.body.arrayBuffer());
  const res = await awsClient(cfg).fetch(objectUrl(cfg, args.key), {
    method: "PUT",
    body: bytes,
    headers: {
      "Content-Type": args.contentType,
      "Content-Length": String(bytes.byteLength),
      // Without an `X-Amz-Content-Sha256` header, aws4fetch has to read
      // the whole body to SHA-256-hash it for the signature — for the
      // Blob this call is handed (an inbound WhatsApp document, already
      // sitting in a Convex action's memory once), that would mean
      // holding the bytes a second time just to compute a hash R2 never
      // actually checks. "UNSIGNED-PAYLOAD" is SigV4's documented
      // sentinel for "trust the transport" — R2 accepts it over HTTPS,
      // where the TLS channel already authenticates the body — so
      // setting it explicitly skips that extra read. Pinned here rather
      // than left to aws4fetch's own default for a non-query-signed S3
      // request (which happens to already be "UNSIGNED-PAYLOAD" today),
      // so this call's memory behavior doesn't depend on that internal
      // default surviving a library upgrade or a future refactor of
      // this function. `presignPut` deliberately does NOT get this
      // header — its signature must stay verifiable against whatever
      // bytes the BROWSER ends up sending, which this module never
      // sees or hashes itself.
      "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    },
  });
  if (!res.ok) {
    throw new Error(
      `R2 putObject failed for ${args.key}: ${res.status} ${res.statusText}`,
    );
  }
}

/**
 * Delete an object. A 404 is success — callers are GC paths
 * (`files.remove` on an abandoned draft) that fire-and-forget, and an
 * already-absent object is the desired end state.
 */
export async function deleteObject(cfg: R2Config, key: string): Promise<void> {
  const res = await awsClient(cfg).fetch(objectUrl(cfg, key), {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `R2 deleteObject failed for ${key}: ${res.status} ${res.statusText}`,
    );
  }
}

/**
 * A short-lived URL the BROWSER may PUT to directly, so upload bytes
 * never transit the VPS.
 *
 * `Content-Type` is signed (it is set on the Request handed to `sign`),
 * which means the browser MUST send a byte-identical `Content-Type` or
 * R2 rejects the upload. That is deliberate: it is also what gets the
 * correct type stored on the object, which is what lets `<img>`/
 * `<audio>`/`<video>` and Meta's media fetcher handle it properly.
 *
 * `allHeaders: true` is required to get that enforcement: aws4fetch
 * puts `content-type` in its own `UNSIGNABLE_HEADERS` default set (it
 * mirrors SigV4's usual host-only query-signing convention) and drops it
 * from `X-Amz-SignedHeaders` unless told otherwise, which would silently
 * let a browser PUT with any `Content-Type` it likes.
 */
export async function presignPut(
  cfg: R2Config,
  args: { key: string; contentType: string; expiresSeconds?: number },
): Promise<string> {
  const expires = args.expiresSeconds ?? 900;
  const url = new URL(objectUrl(cfg, args.key));
  url.searchParams.set("X-Amz-Expires", String(expires));

  const signed = await awsClient(cfg).sign(
    new Request(url, {
      method: "PUT",
      headers: { "Content-Type": args.contentType },
    }),
    { aws: { signQuery: true, allHeaders: true } },
  );
  return signed.url;
}
