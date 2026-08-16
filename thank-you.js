/**
 * Thank-you page controller.
 *
 * Two jobs:
 *
 *   1. Fetch a short-lived signed download URL from /api/download. This file
 *      contains no secrets and no PDF URL — the backend only answers if the
 *      browser carries the HttpOnly purchase-session cookie that
 *      /api/razorpay/callback issues after verifying Razorpay's signature.
 *
 *   2. Decide what the page is allowed to claim. Until the server confirms a
 *      paid purchase, the headline and card stay hidden by CSS (see the
 *      #ty-headline rules in thank-you.html). Someone who simply types this URL
 *      is never told their payment succeeded — they get an honest "no purchase
 *      found here" page with a buy button.
 */
(function () {
  "use strict";

  var GENERIC_ERROR =
    "We couldn't verify your purchase. Please refresh the page or contact support.";

  var cachedUrl = null;
  var cachedUntil = 0;
  var inFlight = null;
  var autoTriggered = false;

  var COLORS = {
    idle: "oklch(0.52 0.02 255)",
    success: "oklch(0.74 0.02 255)",
    error: "oklch(0.72 0.15 25)",
  };

  function el(id) {
    return document.getElementById(id);
  }

  function setStatus(text, tone) {
    var node = el("download-status");
    if (!node) return;
    node.textContent = text;
    node.style.color = COLORS[tone] || COLORS.idle;
  }

  function setButtonEnabled(enabled) {
    var btn = el("download-btn");
    if (!btn) return;
    btn.style.opacity = enabled ? "1" : "0.55";
    btn.style.pointerEvents = enabled ? "auto" : "none";
  }

  /** Reveals the page as a genuine confirmation. */
  function revealVerified() {
    document.documentElement.classList.remove("ty-unverified");
    document.documentElement.classList.add("ty-verified");
  }

  /**
   * Reveals the page as "you are not a customer here" — rewording the headline
   * rather than leaving a success message on screen for someone who never paid.
   */
  function revealUnverified() {
    var headline = el("ty-headline");
    var sub = el("ty-sub");
    var note = el("ty-note");
    var icon = el("ty-badge-icon");
    var buy = el("ty-buy");

    if (headline) headline.textContent = "Nothing to download yet.";
    if (sub) sub.textContent = "This page is where your eBook appears after you buy it.";
    if (note) {
      note.textContent =
        "If you have already paid, open this page in the same browser you paid from, " +
        "or contact support and we'll send your copy.";
    }
    if (icon) icon.textContent = "·";
    if (buy) buy.style.display = "flex";

    document.documentElement.classList.remove("ty-verified");
    document.documentElement.classList.add("ty-unverified");
  }

  /** Asks the backend for a fresh signed URL. Resolves to a URL string. */
  function requestUrl() {
    if (inFlight) return inFlight;

    inFlight = fetch("/api/download", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            if (!res.ok || !body || !body.url) {
              var err = new Error("download_unavailable");
              // The server only ever sends safe, customer-facing copy here.
              err.userMessage = (body && body.message) || GENERIC_ERROR;
              // `customer: true` means the session was valid and the purchase is
              // real — the download just isn't available right now.
              err.isCustomer = Boolean(body && body.customer);
              throw err;
            }
            var ttl = Number(body.expiresIn) || 600;
            cachedUrl = body.url;
            // Retire the cached URL a minute before the server-side expiry so a
            // click never lands on an already-expired link.
            cachedUntil = Date.now() + Math.max(ttl - 60, 30) * 1000;
            return cachedUrl;
          });
      })
      .finally(function () {
        inFlight = null;
      });

    return inFlight;
  }

  /** Returns the cached URL while it is still comfortably valid. */
  function getUrl() {
    if (cachedUrl && Date.now() < cachedUntil) return Promise.resolve(cachedUrl);
    return requestUrl();
  }

  /**
   * Starts the download. The signed URL carries Content-Disposition: attachment,
   * so the browser saves the file and stays on this page.
   */
  function startDownload(url) {
    var a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    a.download = "";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      a.remove();
    }, 1000);
  }

  function onDownloadClick(event) {
    event.preventDefault();
    setStatus("Preparing your secure download…");
    setButtonEnabled(false);
    getUrl()
      .then(function (url) {
        startDownload(url);
        setStatus("Your download has started. Check your downloads folder.", "success");
        setButtonEnabled(true);
      })
      .catch(function (err) {
        setStatus((err && err.userMessage) || GENERIC_ERROR, "error");
        setButtonEnabled(true);
        if (err && !err.isCustomer) revealUnverified();
      });
  }

  function start() {
    var btn = el("download-btn");
    if (btn) btn.addEventListener("click", onDownloadClick);

    requestUrl()
      .then(function (url) {
        revealVerified();
        setButtonEnabled(true);
        setStatus("Your eBook is ready. Starting your download…", "success");
        if (!autoTriggered) {
          autoTriggered = true;
          // Some mobile browsers block downloads without a user gesture. That is
          // fine — the button is always there as the manual path.
          startDownload(url);
          setTimeout(function () {
            setStatus("If your download didn't start, tap the button above.", "success");
          }, 2500);
        }
      })
      .catch(function (err) {
        if (err && err.isCustomer) {
          // A real purchase with a temporary problem: refunded, still confirming,
          // limit reached, or our own outage. Keep the confirmation wording and
          // explain the specific issue.
          revealVerified();
          setButtonEnabled(true);
          setStatus((err && err.userMessage) || GENERIC_ERROR, "error");
        } else {
          revealUnverified();
          setStatus("", "idle");
        }
      });
  }

  /**
   * The page body is rendered client-side by the design runtime (support.js), so
   * the elements do not exist at DOMContentLoaded. Watch for them instead.
   */
  function whenReady(callback) {
    if (el("download-btn")) return callback();

    var observer = new MutationObserver(function () {
      if (!el("download-btn")) return;
      observer.disconnect();
      clearTimeout(giveUp);
      callback();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // If the page never renders, stop watching rather than leaving an observer
    // attached forever.
    var giveUp = setTimeout(function () {
      observer.disconnect();
    }, 20000);
  }

  whenReady(start);
})();
