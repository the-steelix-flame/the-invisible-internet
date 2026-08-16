/**
 * GET /api/razorpay/callback  — Razorpay Payment Link callback_url
 *
 * WHY THIS ENDPOINT EXISTS
 * ------------------------
 * Razorpay cannot redirect straight to the static thank-you.html, because the
 * customer's browser would then be the only thing asserting "I paid" — and
 * anyone can type that URL. Razorpay redirects here instead, carrying a
 * signature only Razorpay could have produced. This endpoint:
 *
 *   1. verifies that signature server-side with the Razorpay key secret,
 *   2. records the purchase (idempotently),
 *   3. mints an HttpOnly purchase-session cookie for this browser,
 *   4. redirects onward to /thank-you.html.
 *
 * The customer sees payment -> thank-you page. The proof of payment never
 * travels through anything the customer can edit: not a query string, not
 * localStorage, not a JS variable.
 *
 * Configure in Razorpay:  callback_url = https://YOUR-DOMAIN/api/razorpay/callback
 *                         callback_method = get
 */
import { siteLink } from "../../lib/env.js";
import { logEvent, logError, maskEmail } from "../../lib/log.js";
import {
  verifyPaymentLinkSignature,
  fetchPayment,
  statusFromPayment,
  normalizeAmount,
} from "../../lib/razorpay.js";
import { recordPurchaseEvent } from "../../lib/supabase.js";
import { issueSessionToken, buildSessionCookie } from "../../lib/session.js";

/** Reads a parameter from the query string, falling back to a form/JSON body. */
function param(req, name) {
  const fromQuery = req.query?.[name];
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  const fromBody = req.body?.[name];
  return typeof fromBody === "string" && fromBody ? fromBody : "";
}

function redirect(res, location, cookie = null) {
  if (cookie) res.setHeader("Set-Cookie", cookie);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", location);
  return res.status(302).end();
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ message: "Method not allowed." });
  }

  const paymentId = param(req, "razorpay_payment_id");
  const paymentLinkId = param(req, "razorpay_payment_link_id");
  const referenceId = param(req, "razorpay_payment_link_reference_id");
  const status = param(req, "razorpay_payment_link_status");
  const signature = param(req, "razorpay_signature");

  // Anyone can hit this URL with invented parameters. The only thing that makes
  // the next few lines meaningful is the HMAC check.
  let signatureValid = false;
  try {
    signatureValid =
      Boolean(paymentId && signature) &&
      verifyPaymentLinkSignature({ paymentLinkId, referenceId, status, paymentId, signature });
  } catch (error) {
    logError("callback.verify_error", error, { paymentId, paymentLinkId });
    return redirect(res, siteLink("/?payment=unavailable"));
  }

  if (!signatureValid || status !== "paid") {
    logEvent("callback.rejected", {
      verified: signatureValid,
      status: status || "missing",
      paymentId: paymentId || null,
      paymentLinkId: paymentLinkId || null,
    });
    // No session cookie is issued, so the thank-you page would show the
    // "couldn't verify" state. Send them back to the sales page instead of
    // congratulating them on a payment that did not happen.
    return redirect(res, siteLink("/?payment=unverified#pricing"));
  }

  logEvent("callback.verified", { verified: true, paymentId, paymentLinkId, referenceId });

  // Defence in depth: ask Razorpay directly what state the payment is in and
  // pick up amount/contact details. A failure here is not fatal — the signature
  // already proved this redirect is genuine, and the webhook will fill the gaps.
  const payment = await fetchPayment(paymentId);
  const apiStatus = statusFromPayment(payment);

  try {
    const purchase = await recordPurchaseEvent({
      paymentId,
      paymentLinkId: paymentLinkId || null,
      referenceId: referenceId || null,
      amount: normalizeAmount(payment?.amount),
      currency: payment?.currency ?? null,
      // If Razorpay's API says the payment is not captured yet, record what it
      // said rather than overriding it — merge_purchase_status will promote the
      // row to paid when payment.captured arrives.
      status: apiStatus ?? "paid",
      customerName: payment?.notes?.name ?? null,
      customerEmail: payment?.email ?? null,
    });

    logEvent("purchase.recorded", {
      paymentId,
      purchaseId: purchase?.id,
      status: purchase?.status,
      emailMasked: maskEmail(payment?.email),
    });
  } catch (error) {
    // The payment is real and verified, so do not strand the customer on an
    // error page: issue the session anyway. /api/download will fail closed if
    // the row genuinely never got written, and the webhook retries the write.
    logError("callback.persist_failed", error, { paymentId, paymentLinkId });
  }

  const cookie = buildSessionCookie(issueSessionToken(paymentId));
  logEvent("session.issued", { paymentId });
  return redirect(res, siteLink("/thank-you.html"), cookie);
}
