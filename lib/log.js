/**
 * Structured server-side logging.
 *
 * Emits one JSON line per event so Vercel's log viewer stays searchable.
 * Secrets, signatures, raw webhook payloads and card details are never passed
 * in — callers hand over identifiers and outcomes only, and email addresses are
 * masked here as a second line of defence.
 */

/** ali***@gmail.com — enough to match a support request, not enough to leak a list. */
export function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  const head = local.slice(0, Math.min(3, local.length));
  return `${head}***@${domain}`;
}

const SAFE_KEYS = new Set([
  "event",
  "paymentId",
  "paymentLinkId",
  "referenceId",
  "purchaseId",
  "status",
  "previousStatus",
  "verified",
  "reason",
  "outcome",
  "amount",
  "currency",
  "downloadCount",
  "emailMasked",
  "durationMs",
  "razorpayEvent",
  "httpStatus",
]);

function scrub(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!SAFE_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

export function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...scrub({ event, ...fields }) }));
}

/**
 * Logs a failure. The Error's message is recorded server-side for debugging;
 * it is never returned to the customer.
 */
export function logError(event, error, fields = {}) {
  console.error(
    JSON.stringify({
      t: new Date().toISOString(),
      level: "error",
      ...scrub({ event, ...fields }),
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
