/**
 * GET /api/checkout
 *
 * Every "Get the eBook" button on the sales page points here. This creates a
 * Razorpay Payment Link for this one buyer and redirects them to it.
 *
 * Why a new link per buyer rather than one link in the HTML: Razorpay Payment
 * Links are single-use — "you can only accept payments from a single customer
 * using a Payment Link" — so a shared link would sell one copy and then start
 * refusing people. Creating the link here also lets us set `callback_url`, which
 * is an API-only parameter and cannot be configured in the Razorpay dashboard.
 *
 * That callback URL is built from PUBLIC_SITE_URL at request time, so pointing
 * the whole flow at a new domain is one environment variable, and there is no
 * link to re-create by hand.
 *
 * Set RAZORPAY_PAYMENT_LINK_URL to bypass all of this and redirect to a fixed
 * link or Payment Page instead — useful for testing, or if you later move to a
 * reusable Razorpay Payment Page.
 */
import { optionalEnv, siteLink } from "../lib/env.js";
import { logEvent, logError } from "../lib/log.js";
import { createPaymentLink } from "../lib/razorpay.js";

function unavailable(res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(503).send(
    `<!doctype html><meta charset="utf-8"><title>Checkout unavailable</title>` +
      `<body style="font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;` +
      `display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;">` +
      `<div><h1 style="font-size:22px;margin:0 0 10px;">Checkout is temporarily unavailable</h1>` +
      `<p style="color:#8b949e;margin:0 0 18px;">Please try again in a few minutes.</p>` +
      `<a href="/" style="color:#58a6ff;">Back to the book</a></div></body>`,
  );
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ message: "Method not allowed." });
  }

  res.setHeader("Cache-Control", "no-store");

  // Escape hatch: a fixed checkout URL, if one is configured.
  const fixedUrl = optionalEnv("RAZORPAY_PAYMENT_LINK_URL");
  if (fixedUrl && /^https:\/\/\S+$/i.test(fixedUrl)) {
    logEvent("checkout.redirect", { reason: "fixed_url" });
    res.setHeader("Location", fixedUrl);
    return res.status(302).end();
  }

  try {
    const link = await createPaymentLink({
      callbackUrl: siteLink("/api/razorpay/callback"),
    });
    logEvent("checkout.link_created", {
      paymentLinkId: link.id,
      referenceId: link.referenceId,
    });
    // 302, not 301: this destination is different for every customer.
    res.setHeader("Location", link.url);
    return res.status(302).end();
  } catch (error) {
    // Missing keys, a Razorpay outage, or a rejected request. The customer sees
    // a plain "try again" page; the reason goes to the server log only.
    logError("checkout.link_failed", error);
    return unavailable(res);
  }
}
