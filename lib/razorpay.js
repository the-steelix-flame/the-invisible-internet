/**
 * Razorpay verification helpers.
 *
 * Both signature schemes below are Razorpay's own documented HMAC-SHA256
 * constructions — nothing custom. The key secret and webhook secret never leave
 * the server.
 */
import crypto from "node:crypto";
import { requireEnv, optionalEnv, product } from "./env.js";

/** Constant-time compare that tolerates length mismatches. */
function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Payment Link callback signature.
 *
 * Razorpay signs:
 *   payment_link_id | payment_link_reference_id | payment_link_status | payment_id
 * with the API key secret.
 * https://razorpay.com/docs/payments/payment-links/#step-4-verify-payment-signature
 */
export function verifyPaymentLinkSignature({
  paymentLinkId,
  referenceId,
  status,
  paymentId,
  signature,
}) {
  const secret = requireEnv("RAZORPAY_KEY_SECRET");
  const payload = `${paymentLinkId ?? ""}|${referenceId ?? ""}|${status ?? ""}|${paymentId ?? ""}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return safeEqualHex(expected, signature);
}

/**
 * Webhook signature: HMAC-SHA256 of the exact raw request body, keyed with the
 * webhook secret configured in the Razorpay dashboard.
 * https://razorpay.com/docs/webhooks/validate-test/
 */
export function verifyWebhookSignature(rawBody, signature) {
  const secret = requireEnv("RAZORPAY_WEBHOOK_SECRET");
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return safeEqualHex(expected, signature);
}

/**
 * Fetches a payment from the Razorpay API using Basic auth.
 *
 * Used as defence in depth on the callback: the signature already proves the
 * redirect came from Razorpay, and this confirms the payment really is captured
 * and picks up the amount and contact details for the purchase record.
 * Returns null on any failure — callers must treat it as optional enrichment.
 */
export async function fetchPayment(paymentId, { timeoutMs = 5000 } = {}) {
  const keyId = optionalEnv("RAZORPAY_KEY_ID");
  const keySecret = optionalEnv("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret || !paymentId) return null;

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: `Basic ${auth}` }, signal: controller.signal },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates a one-off Payment Link and returns its hosted checkout URL.
 *
 * A Razorpay Payment Link can only be paid by one customer — Razorpay's own FAQ:
 * "you can only accept payments from a single customer using a Payment Link".
 * So a single link pasted into the page would sell one copy and then refuse
 * everyone else. Instead each buyer gets their own link, created the moment they
 * click. `callback_url` is also API-only (it cannot be set in the dashboard),
 * which makes this the only way to point Razorpay at our verifying endpoint.
 *
 * Throws on failure; the caller turns that into a friendly error page.
 */
export async function createPaymentLink({ callbackUrl, timeoutMs = 8000 }) {
  const keyId = requireEnv("RAZORPAY_KEY_ID");
  const keySecret = requireEnv("RAZORPAY_KEY_SECRET");
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  const body = {
    amount: product.amount,
    currency: product.currency,
    accept_partial: false,
    description: product.description,
    // Unique per link. Razorpay echoes it back in the callback and includes it
    // in the signature, so it is also a per-purchase correlation id.
    reference_id: `ii_${crypto.randomUUID()}`,
    callback_url: callbackUrl,
    callback_method: "get",
    expire_by: Math.floor(Date.now() / 1000) + product.linkExpirySeconds,
    // We collect no contact details up front, so Razorpay must not try to notify.
    notify: { sms: false, email: false },
    reminder_enable: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.short_url) {
      // Razorpay's own description is safe to log but never shown to customers.
      const detail = json?.error?.description ?? `HTTP ${res.status}`;
      throw new Error(`payment link creation failed: ${detail}`);
    }
    return { url: json.short_url, id: json.id, referenceId: json.reference_id };
  } finally {
    clearTimeout(timer);
  }
}

/** Maps a Razorpay payment entity to our purchase status vocabulary. */
export function statusFromPayment(payment) {
  if (!payment || typeof payment !== "object") return null;
  switch (payment.status) {
    case "captured":
      return "paid";
    // `authorized` means the money is held but not yet settled. Treat it as
    // pending: the payment.captured webhook flips it to paid moments later.
    case "authorized":
      return "pending";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

/** Razorpay reports amounts in the smallest currency unit (paise for INR). */
export function normalizeAmount(amount) {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value) : null;
}
