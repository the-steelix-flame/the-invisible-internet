/**
 * Secure download client for thank-you.html.
 *
 * This file contains no secrets and no PDF URL. It asks the backend for a
 * short-lived signed URL; the backend only answers if the browser is carrying a
 * valid, server-issued purchase session cookie (set by /api/razorpay/callback
 * after Razorpay's signature was verified server-side).
 *
 * Simply opening /thank-you.html in a browser therefore gets you nothing.
 */
(function () {
  "use strict";

  var GENERIC_ERROR =
    "We couldn't verify your purchase. Please refresh the page or contact support.";

  // The signed URL is cached so the visible button can be clicked repeatedly
  // without burning a fresh download against the per-purchase limit each time.
  var cachedUrl = null;
  var cachedUntil = 0;
  var inFlight = null;
  var autoTriggered = false;

  function setStatus(el, text, tone) {
    if (!el) return;
    el.textContent = text;
    el.style.color =
      tone === "error"
        ? "oklch(0.72 0.15 25)"
        : tone === "success"
          ? "oklch(0.74 0.02 255)"
          : "oklch(0.52 0.02 255)";
  }

  function setButtonEnabled(btn, enabled) {
    if (!btn) return;
    btn.style.opacity = enabled ? "1" : "0.55";
    btn.style.pointerEvents = enabled ? "auto" : "none";
  }

  /** Ask the backend for a fresh signed URL. Resolves to a URL string. */
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
            if (!res.ok) {
              var err = new Error("download_request_failed");
              // The server only ever sends safe, customer-facing copy here.
              err.userMessage = body && body.message ? body.message : GENERIC_ERROR;
              throw err;
            }
            if (!body || !body.url) {
              var missing = new Error("missing_url");
              missing.userMessage = GENERIC_ERROR;
              throw missing;
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

  /** Returns the cached URL when it is still comfortably valid. */
  function getUrl() {
    if (cachedUrl && Date.now() < cachedUntil) return Promise.resolve(cachedUrl);
    return requestUrl();
  }

  /**
   * Start the download. The signed URL is served with a
   * Content-Disposition: attachment header, so the browser saves the file and
   * stays on this page rather than navigating away.
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

  function wire(btn, status) {
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      setStatus(status, "Preparing your secure download…");
      setButtonEnabled(btn, false);
      getUrl()
        .then(function (url) {
          startDownload(url);
          setStatus(status, "Your download has started. Check your downloads folder.", "success");
          setButtonEnabled(btn, true);
        })
        .catch(function (err) {
          setStatus(status, (err && err.userMessage) || GENERIC_ERROR, "error");
          setButtonEnabled(btn, true);
        });
    });

    // Prepare the download as soon as the page settles, so the button is live by
    // the time the customer reaches for it.
    requestUrl()
      .then(function (url) {
        setButtonEnabled(btn, true);
        setStatus(status, "Your eBook is ready. Starting your download…", "success");
        if (!autoTriggered) {
          autoTriggered = true;
          // Some mobile browsers block downloads without a user gesture. That is
          // fine — the button below is always available as the manual path.
          startDownload(url);
          setTimeout(function () {
            setStatus(
              status,
              "If your download didn't start, tap the button above.",
              "success",
            );
          }, 2500);
        }
      })
      .catch(function (err) {
        // Leave the button clickable so the customer can retry after, say, a
        // flaky connection — the server re-checks the session on every attempt.
        setButtonEnabled(btn, true);
        setStatus(status, (err && err.userMessage) || GENERIC_ERROR, "error");
      });
  }

  /**
   * The page body is rendered client-side by the design runtime (support.js),
   * so the button does not exist at DOMContentLoaded. Watch for it instead.
   */
  function whenReady(callback) {
    var found = document.getElementById("download-btn");
    if (found) {
      callback(found, document.getElementById("download-status"));
      return;
    }

    var observer = new MutationObserver(function () {
      var btn = document.getElementById("download-btn");
      if (!btn) return;
      observer.disconnect();
      clearTimeout(giveUp);
      callback(btn, document.getElementById("download-status"));
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // If the page never renders (e.g. the runtime failed to load) stop watching
    // rather than leaving an observer attached forever.
    var giveUp = setTimeout(function () {
      observer.disconnect();
    }, 20000);
  }

  whenReady(wire);
})();
