/**
 * Environment configuration.
 *
 * Every secret lives here and only here. Nothing in this file is ever bundled
 * into the browser — these modules are imported exclusively by functions under
 * /api, which run server-side on Vercel.
 */

/** Reads a required variable, or throws a message that is safe to log. */
export function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function optionalEnv(name, fallback = null) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function intEnv(name, fallback) {
  const raw = optionalEnv(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Public origin of the site, e.g. https://the-invisible-internet.vercel.app */
export function siteUrl() {
  const configured = optionalEnv("PUBLIC_SITE_URL");
  if (configured) return configured.replace(/\/+$/, "");
  // Vercel injects this on every deployment; a useful fallback for previews.
  const vercelUrl = optionalEnv("VERCEL_URL");
  if (vercelUrl) return `https://${vercelUrl}`;
  throw new Error("Missing required environment variable: PUBLIC_SITE_URL");
}

/** Builds an absolute URL on the public site. */
export function siteLink(path) {
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Cookies get the Secure flag on https only, so `vercel dev` over http works. */
export function isSecureSite() {
  try {
    return siteUrl().startsWith("https://");
  } catch {
    return true;
  }
}

export const storage = {
  get bucket() {
    return optionalEnv("EBOOK_STORAGE_BUCKET", "ebook");
  },
  get path() {
    return optionalEnv("EBOOK_STORAGE_PATH", "the-invisible-internet.pdf");
  },
  /** Filename the customer's browser saves the PDF as. */
  get downloadFilename() {
    return optionalEnv("EBOOK_DOWNLOAD_FILENAME", "The Invisible Internet.pdf");
  },
};

export const product = {
  /** Price in the smallest currency unit. 24900 paise = ₹249. */
  get amount() {
    return intEnv("EBOOK_PRICE_PAISE", 24900);
  },
  get currency() {
    return optionalEnv("EBOOK_CURRENCY", "INR");
  },
  get description() {
    return optionalEnv(
      "EBOOK_PRODUCT_DESCRIPTION",
      "The Invisible Internet — What Really Happens When You Click a Link? (PDF eBook)",
    );
  },
  /**
   * How long a freshly created Payment Link stays payable. Razorpay requires at
   * least 15 minutes; the default of 24 hours covers a customer who wanders off
   * mid-checkout and comes back.
   */
  get linkExpirySeconds() {
    const value = intEnv("CHECKOUT_LINK_EXPIRY_SECONDS", 86400);
    return Math.min(Math.max(value, 20 * 60), 60 * 60 * 24 * 180);
  },
};

export const limits = {
  /** Lifetime of each Supabase signed URL. */
  get downloadUrlExpirySeconds() {
    const value = intEnv("DOWNLOAD_URL_EXPIRY_SECONDS", 600);
    return Math.min(Math.max(value, 30), 86400);
  },
  /** Downloads allowed per purchase. 0 disables the limit entirely. */
  get maxDownloadsPerPurchase() {
    const value = intEnv("MAX_DOWNLOADS_PER_PURCHASE", 10);
    return value < 0 ? 0 : value;
  },
  /** How long a verified purchase session stays usable. Default 30 days. */
  get sessionTtlSeconds() {
    const value = intEnv("DOWNLOAD_SESSION_TTL_SECONDS", 60 * 60 * 24 * 30);
    return Math.min(Math.max(value, 300), 60 * 60 * 24 * 365);
  },
};
