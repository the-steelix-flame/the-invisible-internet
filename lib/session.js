/**
 * Purchase sessions.
 *
 * After /api/razorpay/callback verifies Razorpay's signature it mints a signed
 * token naming the payment it verified, and hands it to the browser as an
 * HttpOnly cookie. The token is not a bearer key to the PDF on its own: every
 * download re-reads the purchase row and refuses anything that is not currently
 * `paid`, so refunds and download limits still apply.
 *
 * The token is signed, not encrypted — it carries no secret, and the payment id
 * inside it is useless without a matching paid row.
 */
import crypto from "node:crypto";
import { optionalEnv, requireEnv, isSecureSite, limits } from "./env.js";

export const SESSION_COOKIE = "ii_purchase";
const VERSION = "v1";

/**
 * Signing key. Set DOWNLOAD_SESSION_SECRET to control session lifetime
 * independently; otherwise it is derived from the Razorpay key secret, which
 * means rotating Razorpay keys also invalidates outstanding sessions.
 */
function signingKey() {
  const explicit = optionalEnv("DOWNLOAD_SESSION_SECRET");
  if (explicit) return Buffer.from(explicit, "utf8");
  return crypto
    .createHmac("sha256", requireEnv("RAZORPAY_KEY_SECRET"))
    .update("the-invisible-internet:purchase-session:v1")
    .digest();
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(payloadB64) {
  return crypto.createHmac("sha256", signingKey()).update(payloadB64).digest("base64url");
}

/** Issues a token for a verified payment. */
export function issueSessionToken(paymentId, ttlSeconds = limits.sessionTtlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ pid: paymentId, iat: now, exp: now + ttlSeconds }));
  return `${VERSION}.${payload}.${sign(payload)}`;
}

/** Returns { paymentId } for a valid, unexpired token, or null. */
export function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;

  const [, payloadB64, signature] = parts;
  const expected = sign(payloadB64);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || typeof claims.pid !== "string" || !claims.pid) return null;
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;

  return { paymentId: claims.pid };
}

/** Serialises the Set-Cookie header value for a freshly issued session. */
export function buildSessionCookie(token, maxAgeSeconds = limits.sessionTtlSeconds) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureSite()) attrs.push("Secure");
  return attrs.join("; ");
}

/** Reads a cookie from a Node request without pulling in a parser dependency. */
export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
