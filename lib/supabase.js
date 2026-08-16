/**
 * Supabase access — server-side only.
 *
 * Uses the Service Role Key, which bypasses Row Level Security and can read the
 * private `ebook` bucket. It must never be exposed to the browser: nothing in
 * this file is reachable from client JavaScript.
 */
import { createClient } from "@supabase/supabase-js";
import { requireEnv, storage, limits } from "./env.js";

let client = null;

export function getSupabase() {
  if (client) return client;
  client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "the-invisible-internet" } },
  });
  return client;
}

/**
 * Idempotently records a payment event.
 *
 * Delegates to the `record_purchase_event` SQL function, which upserts on the
 * unique razorpay_payment_id and only ever moves status forward
 * (pending -> failed -> paid -> refunded). Replayed webhooks therefore update a
 * single row instead of creating duplicates, and a late `payment.failed` can
 * never revoke a paid purchase.
 */
export async function recordPurchaseEvent({
  paymentId,
  paymentLinkId = null,
  referenceId = null,
  amount = null,
  currency = null,
  status = "pending",
  customerName = null,
  customerEmail = null,
}) {
  const { data, error } = await getSupabase().rpc("record_purchase_event", {
    p_payment_id: paymentId,
    p_link_id: paymentLinkId,
    p_ref_id: referenceId,
    p_amount: amount,
    p_currency: currency,
    p_status: status,
    p_name: customerName,
    p_email: customerEmail,
  });
  if (error) throw new Error(`record_purchase_event failed: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

/**
 * Atomically authorises one download.
 *
 * The `claim_download` SQL function locks the purchase row, checks that it is
 * `paid` and under the limit, and increments download_count in the same
 * transaction — so two simultaneous clicks cannot slip past the limit.
 *
 * Returns { allowed, reason, downloads }. Reasons: not_found, status_pending,
 * status_failed, status_refunded, limit_reached, ok.
 */
export async function claimDownload(paymentId) {
  const { data, error } = await getSupabase().rpc("claim_download", {
    p_payment_id: paymentId,
    p_max: limits.maxDownloadsPerPurchase,
  });
  if (error) throw new Error(`claim_download failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { allowed: false, reason: "not_found", downloads: 0 };
  return { allowed: row.allowed === true, reason: row.reason, downloads: row.downloads ?? 0 };
}

/**
 * Creates a short-lived signed URL for the private PDF.
 *
 * The `download` option makes Supabase serve the object with
 * Content-Disposition: attachment, so the browser saves the file instead of
 * rendering it. The URL stops working once it expires.
 */
export async function createSignedDownloadUrl() {
  const { data, error } = await getSupabase()
    .storage.from(storage.bucket)
    .createSignedUrl(storage.path, limits.downloadUrlExpirySeconds, {
      download: storage.downloadFilename,
    });
  if (error || !data?.signedUrl) {
    throw new Error(`createSignedUrl failed: ${error ? error.message : "no URL returned"}`);
  }
  return data.signedUrl;
}
