/**
 * POST /api/razorpay/webhook
 *
 * The authoritative record of what happened. The callback only fires if the
 * customer's browser follows the redirect; the webhook fires regardless — if
 * someone pays and immediately closes the tab, this is what still records the
 * sale, and what later marks it refunded.
 *
 * Configure in Razorpay:  https://YOUR-DOMAIN/api/razorpay/webhook
 * Events:                 payment_link.paid, payment.captured, payment.failed,
 *                         refund.created, refund.processed
 */
import { logEvent, logError, maskEmail } from "../../lib/log.js";
import { verifyWebhookSignature, normalizeAmount } from "../../lib/razorpay.js";
import { recordPurchaseEvent } from "../../lib/supabase.js";

// Razorpay signs the exact bytes it sent. Any re-serialisation of the JSON would
// change whitespace or key order and break the HMAC, so body parsing is off and
// the raw buffer is read by hand.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    // Layered fallback. If a runtime parses the body despite the config above,
    // the stream is already consumed and reading it would yield zero bytes — so
    // recover whatever the parser left behind, in decreasing order of fidelity.
    if (Buffer.isBuffer(req.rawBody)) return resolve(req.rawBody);
    if (typeof req.rawBody === "string") return resolve(Buffer.from(req.rawBody, "utf8"));
    if (Buffer.isBuffer(req.body)) return resolve(req.body);
    if (typeof req.body === "string") return resolve(Buffer.from(req.body, "utf8"));
    if (req.body && typeof req.body === "object") {
      // Last resort. Re-serialising is lossy in principle (whitespace, unicode
      // escaping), so a mismatch here shows up as a rejected signature rather
      // than as a silently accepted forgery. Logged so it is diagnosable.
      logEvent("webhook.raw_body_reconstructed");
      return resolve(Buffer.from(JSON.stringify(req.body), "utf8"));
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Pulls the fields we store out of the various event payload shapes. */
function extract(event, payload) {
  const payment = payload?.payment?.entity ?? null;
  const link = payload?.payment_link?.entity ?? null;
  const refund = payload?.refund?.entity ?? null;

  const paymentId = payment?.id ?? refund?.payment_id ?? null;
  if (!paymentId) return null;

  const base = {
    paymentId,
    paymentLinkId: link?.id ?? null,
    referenceId: link?.reference_id ?? null,
    amount: normalizeAmount(payment?.amount ?? link?.amount),
    currency: payment?.currency ?? link?.currency ?? null,
    customerName: payment?.notes?.name ?? link?.customer?.name ?? null,
    customerEmail: payment?.email ?? link?.customer?.email ?? null,
  };

  switch (event) {
    case "payment_link.paid":
    case "order.paid":
      return { ...base, status: "paid" };
    case "payment.captured":
      return { ...base, status: "paid" };
    case "payment.authorized":
      // Money held, not settled. The captured event promotes it to paid.
      return { ...base, status: "pending" };
    case "payment.failed":
      return { ...base, status: "failed" };
    case "refund.created":
    case "refund.processed":
      // Access is revoked here: /api/download refuses any purchase that is not
      // currently `paid`, so existing customers lose the file immediately.
      return { ...base, status: "refunded" };
    default:
      return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: "Method not allowed." });
  }

  const signature = req.headers["x-razorpay-signature"];
  let raw;
  try {
    raw = await readRawBody(req);
  } catch (error) {
    logError("webhook.body_read_failed", error);
    return res.status(400).json({ message: "Invalid request." });
  }

  let verified = false;
  try {
    verified = typeof signature === "string" && verifyWebhookSignature(raw, signature);
  } catch (error) {
    // Missing RAZORPAY_WEBHOOK_SECRET lands here. 500 so Razorpay retries once
    // the configuration is fixed, instead of giving up on a real payment.
    logError("webhook.verify_error", error);
    return res.status(500).json({ message: "Webhook not configured." });
  }

  if (!verified) {
    logEvent("webhook.rejected", { verified: false, reason: "bad_signature" });
    return res.status(400).json({ message: "Invalid signature." });
  }

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    logError("webhook.bad_json", error);
    return res.status(400).json({ message: "Invalid payload." });
  }

  const event = typeof body?.event === "string" ? body.event : "unknown";
  const fields = extract(event, body?.payload);

  if (!fields) {
    // Subscribed to an event we do not act on, or one with no payment id.
    // 200 keeps Razorpay from retrying something we will never handle.
    logEvent("webhook.ignored", { razorpayEvent: event, verified: true });
    return res.status(200).json({ received: true });
  }

  try {
    const purchase = await recordPurchaseEvent(fields);
    logEvent("purchase.recorded", {
      razorpayEvent: event,
      paymentId: fields.paymentId,
      paymentLinkId: fields.paymentLinkId,
      purchaseId: purchase?.id,
      status: purchase?.status,
      amount: fields.amount,
      currency: fields.currency,
      emailMasked: maskEmail(fields.customerEmail),
    });
    return res.status(200).json({ received: true });
  } catch (error) {
    logError("webhook.persist_failed", error, {
      razorpayEvent: event,
      paymentId: fields.paymentId,
    });
    // Non-2xx makes Razorpay retry, which is exactly what we want: the row is
    // keyed on the payment id, so the retry updates rather than duplicates.
    return res.status(500).json({ message: "Could not record event." });
  }
}
