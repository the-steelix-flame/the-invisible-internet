/**
 * GET /api/download
 *
 * The only customer-facing route to the PDF. It never streams or exposes the
 * file itself — it returns a Supabase signed URL that stops working after
 * DOWNLOAD_URL_EXPIRY_SECONDS.
 *
 * Three independent checks must all pass:
 *   1. the browser presents a session cookie signed by this server,
 *   2. the purchase that cookie names still exists and is `paid`,
 *   3. the purchase is under its download limit.
 *
 * Anything else fails closed with a generic message.
 */
import { limits } from "../lib/env.js";
import { logEvent, logError } from "../lib/log.js";
import { SESSION_COOKIE, readCookie, verifySessionToken } from "../lib/session.js";
import { claimDownload, createSignedDownloadUrl } from "../lib/supabase.js";

const GENERIC_ERROR =
  "We couldn't verify your purchase. Please refresh the page or contact support.";

/** Maps an internal refusal reason to safe customer-facing copy and a status. */
function refusal(reason) {
  switch (reason) {
    case "limit_reached":
      return { httpStatus: 403, message: "Download limit reached." };
    case "status_refunded":
      return { httpStatus: 403, message: "This purchase is no longer active." };
    case "status_pending":
      return {
        httpStatus: 403,
        message: "Your payment is still being confirmed. Please refresh in a moment.",
      };
    default:
      // not_found, status_failed, and anything unexpected.
      return { httpStatus: 403, message: GENERIC_ERROR };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ message: "Method not allowed." });
  }

  res.setHeader("Cache-Control", "no-store");

  // 1. Session ------------------------------------------------------------
  const session = verifySessionToken(readCookie(req, SESSION_COOKIE));
  if (!session) {
    // Covers: opening thank-you.html directly, a forged or edited cookie, and
    // an expired session. Deliberately indistinguishable from one another.
    logEvent("download.denied", { reason: "no_session", httpStatus: 401 });
    return res.status(401).json({ message: GENERIC_ERROR });
  }

  const { paymentId } = session;

  // 2 + 3. Purchase status and download limit, claimed atomically ----------
  let claim;
  try {
    claim = await claimDownload(paymentId);
  } catch (error) {
    logError("download.claim_failed", error, { paymentId });
    return res.status(500).json({ message: GENERIC_ERROR });
  }

  if (!claim.allowed) {
    const { httpStatus, message } = refusal(claim.reason);
    logEvent("download.denied", {
      paymentId,
      reason: claim.reason,
      downloadCount: claim.downloads,
      httpStatus,
    });
    return res.status(httpStatus).json({ message });
  }

  // 4. Short-lived signed URL ---------------------------------------------
  try {
    const url = await createSignedDownloadUrl();
    logEvent("download.granted", {
      paymentId,
      downloadCount: claim.downloads,
      httpStatus: 200,
    });
    return res.status(200).json({
      url,
      expiresIn: limits.downloadUrlExpirySeconds,
    });
  } catch (error) {
    // Storage misconfiguration (wrong bucket, missing object, bad key). The
    // customer gets nothing useful; the detail goes to the server log only.
    logError("download.signed_url_failed", error, { paymentId });
    return res.status(500).json({ message: GENERIC_ERROR });
  }
}
