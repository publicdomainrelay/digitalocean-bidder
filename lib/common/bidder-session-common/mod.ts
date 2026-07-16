// bidder-session-common — cookie name, JWT types, HS256 sign/verify helpers.
// Layer 0: pure helpers, no project-local imports, no I/O.

/** HTTP-only cookie name for the bidder dashboard session. */
export const BIDDER_SESSION_COOKIE = "bidder_session";

/** Cookie max age in seconds (7 days). */
export const BIDDER_SESSION_MAX_AGE_SEC = 604800;

/** Payload encoded in the session JWT cookie. */
export interface SessionCookiePayload {
  did: string;
  handle: string;
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Uint8Array {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  const keyData = encoder.encode(secret);
  return crypto.subtle.importKey(
    "raw", keyData,
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"],
  );
}

/**
 * Sign a session payload into a HS256 JWT string.
 * Pure function — deterministic given same secret and payload.
 */
export async function signSessionJwt(
  payload: Omit<SessionCookiePayload, "iat" | "exp">,
  secret: string,
  maxAgeSec?: number,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const maxAge = maxAgeSec ?? BIDDER_SESSION_MAX_AGE_SEC;
  const fullPayload: SessionCookiePayload = { ...payload, iat, exp: iat + maxAge };

  const headerB64 = b64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payloadB64 = b64url(encoder.encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput).buffer as ArrayBuffer);
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

/**
 * Verify a HS256 JWT and return the payload, or null if invalid/expired.
 * Pure function — deterministic given same secret and token.
 */
export async function verifySessionJwt(
  token: string,
  secret: string,
): Promise<SessionCookiePayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const sigBytes = b64urlDecode(sigB64);
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes.buffer as ArrayBuffer, encoder.encode(signingInput).buffer as ArrayBuffer);
  if (!valid) return null;

  try {
    const payload = JSON.parse(decoder.decode(b64urlDecode(payloadB64))) as SessionCookiePayload;
    if (typeof payload.did !== "string" || typeof payload.handle !== "string") return null;
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
