import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Credential encryption at rest, and the two things a stored blob has to
 * survive: an operator changing the key, and a reader that has to say something
 * true when it cannot open the blob at all.
 *
 * ── THE KEY RING ──────────────────────────────────────────────────────────
 *
 * `APP_ENCRYPTION_KEY` is now ONE OR MORE base64 keys, comma-separated, the
 * active one first. A single key — every value that has ever been deployed —
 * parses as a ring of one and behaves exactly as it did, which is the only
 * migration story worth having: nothing to run, nothing to rewrite, no window
 * where the product is down.
 *
 * Rotation is then: put the new key in front of the old one, restart, and every
 * blob written from that moment carries the NEW key's id while every blob
 * written before it is still opened with the old one. The old key leaves the
 * ring when nothing is on it any more (`rewrapJson` below is what moves rows
 * off it; `ChannelsRepository.verify` is the one caller that does it today).
 *
 * ── WHY A TEXT PREFIX AND NOT A LEADING VERSION BYTE ──────────────────────
 *
 * The obvious fix for "the ciphertext carries no version" is a leading byte.
 * It does not work here, and the reason is the format it would have to be
 * distinguished from: a legacy blob starts with twelve bytes of RANDOM IV, so
 * its first byte takes every value 0x00–0xFF with equal probability. A reader
 * that treated a leading 0x01 as "version 1" would misread one legacy blob in
 * 256 — as a version-1 blob whose key id is four bytes of somebody's IV — and
 * the failure would look exactly like the failure this module exists to
 * classify. There is no byte value that is safe, because every byte value
 * already occurs.
 *
 * So the version lives OUTSIDE the base64, in a prefix that the legacy encoding
 * cannot produce:
 *
 *   legacy   base64( iv[12] || tag[16] || ciphertext )
 *   v1       "p1." || keyId(8 hex) || "." || base64( iv[12] || tag[16] || ciphertext )
 *
 * The base64 alphabet is `A–Za–z0–9+/=`; a `.` never appears in it. "Does this
 * string contain a dot" is therefore a total, exact test for which format is in
 * front of us — not a heuristic — and it stays exact for v2 and v3.
 *
 * ── WHY THE KEY ID ────────────────────────────────────────────────────────
 *
 * A ring alone would work without it: AES-GCM's tag makes a wrong key a
 * deterministic failure, so a reader could simply try each key in turn, and for
 * legacy blobs (which carry no id) that is exactly what happens below. The id
 * buys two things the trial loop cannot. It tells a REWRITE pass which rows are
 * still on the old key without decrypting them — which is what makes "when can
 * I drop the old key?" an answerable question instead of a guess. And it turns
 * "wrong key" from an ambiguity into a statement: an id that is in no ring
 * entry names an absent key, rather than looking like corruption.
 *
 * It is a truncated hash of the key, not the key: four bytes of
 * SHA-256(domain || key) over 32 random bytes. Recovering the key from it is a
 * preimage search; distinguishing two keys by it is what it is for.
 *
 * ── WHY THERE IS NO ASSOCIATED DATA ───────────────────────────────────────
 *
 * The security review's Minor finding is real as stated: nothing binds a blob
 * to the row it sits in, so an attacker with database WRITE access could move
 * one organisation's ciphertext into another organisation's row and it would
 * decrypt. The obvious close is AES-GCM's associated data — authenticate
 * `orgId || table || column` alongside the ciphertext, so a blob moved between
 * rows fails its tag.
 *
 * It is not taken, and the reason is not cost. It is that the context would be
 * derived from the same row the attacker just wrote. `channels.org_id` is an
 * ordinary column: an attacker who can move `credentials_encrypted` from org A
 * to org B can equally leave the blob where it is and set `org_id = B`, and any
 * AAD recomputed from that row then verifies perfectly. The binding is only
 * worth what its context is worth, and the context lives in the attacker's
 * reach. Making it worth something needs a context that is NOT in the database
 * — a per-row key derived from something outside it — which is a different and
 * much larger change than a version byte, and one this product has no place to
 * put the material for.
 *
 * The weaker half — domain separation, so an `ai_credentials` blob cannot be
 * pasted into `channels.credentials_encrypted` — is already closed downstream
 * and fails closed: both readers parse the plaintext against a zod schema and
 * refuse a shape they did not write (`publisher.credentialsSchema`,
 * `{ apiKey }`). It would buy a better error message, not a better outcome.
 *
 * If this is revisited, it is a v2 tag and a `p2.` prefix — which is precisely
 * what the versioned envelope above makes cheap, and what the format it
 * replaced made impossible.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** The current envelope's version tag. `p` for pubrick; `.` cannot occur in base64. */
const VERSION_TAG = "p1";
const SEPARATOR = ".";

/**
 * Bytes of the key fingerprint stored in the envelope, and the string it is
 * mixed with first.
 *
 * The domain string is there so this id can never collide with some other
 * truncated hash of the same key taken for a different purpose later — the id
 * is written into the database, and a value in the database is forever.
 */
const KEY_ID_BYTES = 4;
const KEY_ID_DOMAIN = "pubrick/credential-key-id/1";

/**
 * The one sentence this product says when a stored blob will not open.
 *
 * Written HERE, once, because four different places had four different answers
 * to one event: a clean verdict, an HTTP 500 with a crypto stack trace, the
 * node crypto library's own "Unsupported state or unable to authenticate data"
 * printed on a screen, and a sentence written for a human. Three of those told
 * the reader nothing they could act on, and one of them told them something
 * about AES.
 *
 * It is this error's `message`, so a caller that only logs `error.message` —
 * the publish worker's generic path — already says the right thing, and it is
 * exported so the api can put the identical sentence in a coded refusal's body.
 *
 * It contains no secret by construction and names no table, because it is true
 * of every blob this module writes.
 */
export const UNREADABLE_CREDENTIALS_MESSAGE =
  "Stored credentials could not be decrypted: they were encrypted with a key this instance no " +
  "longer has. Add the old key to APP_ENCRYPTION_KEY, or save the credentials again.";

/**
 * A stored blob that will not open — the DATA is unreadable, as opposed to the
 * configuration being wrong.
 *
 * That distinction is the whole reason this class exists rather than a bare
 * `Error`. Both failures used to arrive as an untyped throw, so every caller
 * had the same two choices: treat all of them as "the key was rotated" (and
 * report a config error, a bad base64 key, or a genuine bug as a verdict about
 * the user's credentials), or treat none of them as such (and answer 500). A
 * key that is not 32 bytes is still a plain `Error` from `keyFromBase64`: it is
 * an operator's mistake about the whole instance, it fails at boot through
 * `parseKeyRing`, and it must never be dressed up as one channel's problem.
 *
 * `name` rather than `instanceof` is what `isUnreadableCiphertext` tests, for
 * the reason `classifyProbeFailure` gives: the marker survives duplicate copies
 * of `@pubrick/shared` in a pnpm tree, where `instanceof` silently does not.
 */
export class UnreadableCiphertextError extends Error {
  readonly name = "UnreadableCiphertextError";
  constructor(message: string = UNREADABLE_CREDENTIALS_MESSAGE) {
    super(message);
  }
}

/** Is this the one event — a stored blob that no configured key can open? */
export function isUnreadableCiphertext(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "UnreadableCiphertextError"
  );
}

type RingEntry = { readonly base64: string; readonly key: Buffer; readonly id: string };

function keyFromBase64(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("Encryption key must decode to exactly 32 bytes (base64-encoded)");
  }
  return key;
}

function keyIdOf(key: Buffer): string {
  return createHash("sha256")
    .update(KEY_ID_DOMAIN)
    .update(key)
    .digest()
    .subarray(0, KEY_ID_BYTES)
    .toString("hex");
}

/**
 * Splits and validates `APP_ENCRYPTION_KEY`, active key first.
 *
 * Exported for the api's and the worker's env schemas: the ring is validated at
 * BOOT, the way a single key already was, so a typo in the second key is a
 * refusal to start rather than a credential that silently cannot be read months
 * later. Returns the base64 strings rather than the key material, because the
 * one thing env does with them besides validating is name them to
 * `assertNoPublishedSecrets` — which must see EACH member: a rotation that
 * moves this repository's published test key into second place would otherwise
 * hide it from a check that used to catch it.
 *
 * A duplicate member is refused rather than deduplicated. Two entries with the
 * same id make "which key is this row on" ambiguous for no gain, and the only
 * way to write one is a copy-paste an operator wanted to be told about.
 */
export function parseKeyRing(raw: string): string[] {
  const members = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (members.length === 0) {
    throw new Error("Encryption key must decode to exactly 32 bytes (base64-encoded)");
  }
  for (const member of members) keyFromBase64(member);
  if (new Set(members).size !== members.length) {
    throw new Error("Encryption key ring must not repeat a key");
  }
  return members;
}

function ringOf(raw: string): RingEntry[] {
  return parseKeyRing(raw).map((base64) => {
    const key = keyFromBase64(base64);
    return { base64, key, id: keyIdOf(key) };
  });
}

function sealWith(entry: RingEntry, plaintext: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, entry.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const body = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
  return `${VERSION_TAG}${SEPARATOR}${entry.id}${SEPARATOR}${body}`;
}

function openWith(key: Buffer, body: string): Buffer | null {
  const raw = Buffer.from(body, "base64");
  // A blob shorter than iv+tag cannot be one of ours. `subarray` would happily
  // hand back empty buffers and `setAuthTag` would then throw a different,
  // untyped error out of the crypto library — the exact leak this module is
  // removing.
  if (raw.length < IV_LENGTH + TAG_LENGTH) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, raw.subarray(0, IV_LENGTH));
    decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
    return Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
  } catch {
    // Wrong key, or tampering. Either way this key did not open it; the caller
    // decides whether another one still might.
    return null;
  }
}

type Opened = { plaintext: Buffer; keyId: string | null };

/**
 * Opens a payload with the ring, and says which key did it.
 *
 * Two shapes, one rule — never guess. A `p1.` envelope names its key, so
 * exactly one ring entry is tried and a missing id is an immediate, honest
 * "the key that wrote this is not configured". A legacy blob names nothing, so
 * every key is tried in ring order; GCM's tag is what makes that safe, since a
 * wrong key fails with probability 1 − 2⁻¹²⁸ rather than returning plausible
 * bytes.
 */
function open(payload: string, raw: string): Opened {
  const ring = ringOf(raw);

  if (payload.includes(SEPARATOR)) {
    const parts = payload.split(SEPARATOR);
    const [version, keyId, body] = parts;
    if (parts.length !== 3 || version !== VERSION_TAG || !keyId || body === undefined) {
      throw new UnreadableCiphertextError();
    }
    const entry = ring.find((candidate) => candidate.id === keyId);
    if (!entry) throw new UnreadableCiphertextError();
    const plaintext = openWith(entry.key, body);
    if (plaintext === null) throw new UnreadableCiphertextError();
    return { plaintext, keyId };
  }

  for (const entry of ring) {
    const plaintext = openWith(entry.key, payload);
    if (plaintext !== null) return { plaintext, keyId: null };
  }
  throw new UnreadableCiphertextError();
}

/**
 * Encrypt any JSON-serializable value under the ring's ACTIVE key.
 *
 * Output is the versioned envelope described at the top of this file. The
 * legacy format is readable for ever and is never written again — which is the
 * asymmetry that makes the change deployable: nothing has to be rewritten
 * before the new code works. Nothing written by the new code is readable by the
 * old code, so this is a one-way deploy; there is no way round that which also
 * carries a version.
 */
export function encryptJson(value: unknown, keyBase64: string): string {
  const ring = ringOf(keyBase64);
  const active = ring[0] as RingEntry;
  return sealWith(active, Buffer.from(JSON.stringify(value), "utf8"));
}

/**
 * Decrypt a payload produced by `encryptJson`, in either format.
 *
 * Throws `UnreadableCiphertextError` — and ONLY that — for every way the data
 * can be unreadable: a wrong or absent key, tampering, truncation, a corrupted
 * envelope, or plaintext that is not JSON. A malformed key ring still throws a
 * plain `Error`, because that is a broken instance rather than a broken row.
 */
export function decryptJson<T = unknown>(payload: string, keyBase64: string): T {
  const { plaintext } = open(payload, keyBase64);
  try {
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    // Authenticated, so this is our own ciphertext — and its contents are still
    // not something we can use. Same verdict, because the caller's question
    // ("can I read the stored credentials?") has the same answer.
    throw new UnreadableCiphertextError();
  }
}

/**
 * Move a payload onto the ring's active key, or report that it is already there.
 *
 * `null` means "nothing to do", and it is the answer for the overwhelming
 * majority of calls — which is why the check is a string comparison against the
 * envelope's key id and not a decrypt. Only a legacy blob (no id at all) or one
 * written under a key that has since been demoted costs a decrypt and a
 * re-seal.
 *
 * The PLAINTEXT BYTES are re-sealed, not a re-serialised object. A JSON
 * round-trip through `JSON.parse`/`JSON.stringify` would rewrite key order and
 * number formatting, so a rewrap would silently alter what was stored; the
 * whole promise of this function is that the value is untouched and only the
 * key changed.
 *
 * Throws exactly what `decryptJson` throws when the blob cannot be opened — a
 * rewrap of an unreadable blob is the same event, not a quiet no-op.
 */
export function rewrapJson(payload: string, keyBase64: string): string | null {
  const ring = ringOf(keyBase64);
  const active = ring[0] as RingEntry;
  const { plaintext, keyId } = open(payload, keyBase64);
  if (keyId === active.id) return null;
  return sealWith(active, plaintext);
}
