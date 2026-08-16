# The Invisible Internet — sales page + secure eBook delivery

A static sales page, a Razorpay Payment Link checkout, server-side payment
verification, and a private PDF that is only ever handed out through a
short-lived signed URL.

The PDF is never a public file. It lives in a private Supabase Storage bucket,
and the only route to it is `/api/download`, which refuses to answer unless the
server has already verified a real Razorpay payment for that browser.

---

## Contents

1. [How it works](#how-it-works)
2. [Project structure](#project-structure)
3. [Environment variables](#environment-variables)
4. [Supabase setup](#supabase-setup)
5. [Vercel deployment](#vercel-deployment)
6. [Razorpay setup](#razorpay-setup)
7. [Local development](#local-development)
8. [Testing](#testing)
9. [Going live: Test Mode → Live Mode](#going-live-test-mode--live-mode)
10. [Security review](#security-review)
11. [Day-to-day admin](#day-to-day-admin)
12. [Payment Links vs Standard Checkout](#payment-links-vs-standard-checkout)

---

## How it works

```
Visitor  →  index.html  →  "Get the eBook"
                              │
                              ▼
                    GET /api/checkout     creates a Payment Link for
                              │           this one buyer, 302s to it
                              ▼
                   Razorpay hosted checkout
                              │
              ┌───────────────┴────────────────┐
              ▼                                ▼
  GET /api/razorpay/callback        POST /api/razorpay/webhook
  (customer's browser)              (Razorpay's servers, always)
              │                                │
   verify signature (HMAC)          verify signature (HMAC of raw body)
   record purchase                  record purchase  ← idempotent
   set HttpOnly session cookie      mark paid / failed / refunded
              │
              ▼
      302 → /thank-you.html
              │
              ▼
   thank-you.js → GET /api/download
              │
   ① valid session cookie?  ② purchase still `paid`?  ③ under download limit?
              │
              ▼
   short-lived Supabase signed URL  →  PDF downloads
```

### The two Razorpay endpoints, and why both exist

**`/api/razorpay/callback`** is where Razorpay sends the *customer's browser*
after payment. It exists because Razorpay cannot redirect straight to
`thank-you.html` safely — if it did, the only evidence of payment would be the
fact that a browser is sitting on a URL, and anyone can type a URL. The callback
receives a signature that only Razorpay could have generated, verifies it
server-side with your key secret, and only then issues the session cookie that
makes the download button work.

**`/api/razorpay/webhook`** is where Razorpay's *servers* report what happened,
regardless of what the customer's browser did. If someone pays and immediately
closes the tab, the callback never fires — the webhook still records the sale.
It is also how refunds revoke access later.

Both write to the same `purchases` row, keyed on the Razorpay payment id, so
duplicate deliveries update one row instead of creating several.

### Why the thank-you page is not proof of payment

Opening `https://your-site/thank-you.html` directly does nothing. The page has no
PDF URL in it. Its download button calls `/api/download`, which requires the
`ii_purchase` cookie — an HttpOnly, server-signed token that is only ever set by
`/api/razorpay/callback` after a signature check. Without it the endpoint
returns `401` and the page shows the "couldn't verify your purchase" message.

Even *with* a valid cookie the server re-reads the purchase row on every single
request, so a refund revokes access immediately and the download limit is
enforced per attempt.

---

## Project structure

```
/
├── index.html                  Sales page (design unchanged; buttons → /api/checkout)
├── thank-you.html              Thank-you page (design unchanged; button → /api/download)
├── thank-you.js                Download button logic: states, retry, auto-start
├── support.js                  Existing design runtime — untouched
├── image-slot.js               Existing image component — untouched
├── assets/                     Page images, WebP only — this ships to the CDN
├── local-source/images/        Master PNGs for assets/ — git- and Vercel-ignored
│
├── api/
│   ├── checkout.js             GET  → creates a per-buyer Payment Link, 302s to it
│   ├── download.js             GET  → short-lived signed URL, after 3 checks
│   └── razorpay/
│       ├── callback.js         GET  ← Razorpay callback_url (verifies + issues session)
│       └── webhook.js          POST ← Razorpay webhook (verifies + records)
│
├── lib/
│   ├── env.js                  Env parsing, defaults, clamping
│   ├── log.js                  Structured logs with an allow-list of safe fields
│   ├── razorpay.js             Signature verification + API lookups
│   ├── session.js              Signed purchase-session tokens and cookies
│   └── supabase.js             Service-role client, purchase writes, signed URLs
│
├── supabase/schema.sql         Table + SQL functions. Run once in the SQL editor.
├── scripts/check.js            `npm run check` — verifies your whole setup
│
├── package.json
├── vercel.json                 Function limits + security headers
├── .env.example                Copy to .env for local work
├── .gitignore / .vercelignore  Keep the PDF and secrets out of Git and the CDN
├── README.md
└── TESTING.md                  The 12-case test plan
```

> **The sales page and thank-you page were renamed, not redesigned.**
> `Landing Page.dc.html` → `index.html` and `Thank You.dc.html` → `thank-you.html`,
> because Vercel serves `/` from `index.html`. The markup, copy, styling and
> animations are byte-for-byte the originals apart from three changes: the CTA
> links now point at `/api/checkout`, the download button lost its hard-coded PDF
> URL, and a status line was added under it for the loading/error states.

> **`uploads/` is excluded from Git and from Vercel** by `.gitignore` and
> `.vercelignore`. It holds the PDF and the extracted manuscript text — if either
> were deployed, the whole product would be a public URL away. Keep the PDF there
> for your own reference; the copy customers receive is the one in Supabase.

---

## Environment variables

Every one of these is server-side only. None is ever sent to a browser.

| Variable | Required | Where to get it | What it does |
| --- | --- | --- | --- |
| `RAZORPAY_KEY_ID` | ✅ | Razorpay → Account & Settings → API Keys | Authenticates payment lookups |
| `RAZORPAY_KEY_SECRET` | ✅ | Same screen, shown once at creation | **Verifies the callback signature.** Also derives the session-cookie key |
| `RAZORPAY_WEBHOOK_SECRET` | ✅ | The secret you type when creating the webhook | Verifies webhook signatures |
| `EBOOK_PRICE_PAISE` | — | default `24900` (= ₹249) | The amount each Payment Link charges |
| `EBOOK_CURRENCY` | — | default `INR` | Currency of that amount |
| `RAZORPAY_PAYMENT_LINK_URL` | — | **leave unset** | Escape hatch: forces every buyer at one fixed URL instead of a per-buyer link |
| `SUPABASE_URL` | ✅ | Supabase → Project Settings → Data API | Which project to talk to |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase → Project Settings → API Keys → `service_role` | Reads the private bucket, writes purchases. **Bypasses all security rules — server only** |
| `PUBLIC_SITE_URL` | ✅ | Your Vercel URL or custom domain, no trailing slash | Builds the redirect back to the thank-you page |
| `EBOOK_STORAGE_BUCKET` | — | default `ebook` | Bucket name |
| `EBOOK_STORAGE_PATH` | — | default `the-invisible-internet.pdf` | Object path inside the bucket |
| `EBOOK_DOWNLOAD_FILENAME` | — | default `The Invisible Internet.pdf` | Filename the customer's browser saves |
| `DOWNLOAD_URL_EXPIRY_SECONDS` | — | default `600` (10 min) | Signed URL lifetime; clamped to 30–86400 |
| `MAX_DOWNLOADS_PER_PURCHASE` | — | default `10` | Downloads per purchase; **`0` = unlimited** |
| `DOWNLOAD_SESSION_TTL_SECONDS` | — | default `2592000` (30 days) | How long a purchase session stays valid |
| `DOWNLOAD_SESSION_SECRET` | — | generate your own | Signs session cookies. If unset, derived from `RAZORPAY_KEY_SECRET` |
| `CHECKOUT_LINK_EXPIRY_SECONDS` | — | default `86400` (24h) | How long a generated link stays payable |

### Exactly where each secret goes

| Secret | Goes in | Never goes in |
| --- | --- | --- |
| `RAZORPAY_KEY_SECRET` | Vercel env vars, and local `.env` | Any `.html`, `.js` served to browsers, Git |
| `RAZORPAY_WEBHOOK_SECRET` | Vercel env vars + the Razorpay webhook form | Anywhere else |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env vars, and local `.env` | Any browser file, Git, the Supabase client SDK in a page |
| `RAZORPAY_KEY_ID` | Vercel env vars | (Not secret, but no reason to publish) |

`.env` is listed in `.gitignore`. Confirm with `git status` that it never appears
as a tracked file.

---

## Supabase setup

1. **Create a project** at [supabase.com](https://supabase.com) → *New project*.
   Pick a region near your buyers (Mumbai / `ap-south-1` for India). Save the
   database password somewhere safe.

2. **Create the private bucket.** Storage → *New bucket*.
   - Name: `ebook`
   - **Public bucket: OFF.** This is the setting that matters most in the whole
     project. A public bucket means a permanent URL to your product.
   - Create.

3. **Upload the PDF.** Open the `ebook` bucket → *Upload file* → select your PDF.

   The object must end up at exactly:

   ```
   ebook/the-invisible-internet.pdf
   ```

   Your local file is `uploads/The Invisible Internet.pdf`. **Rename it to
   `the-invisible-internet.pdf` before or after uploading** — no spaces, no
   capitals — or set `EBOOK_STORAGE_PATH` to whatever name you actually used.
   Do not put it in a subfolder unless you also update that variable.

4. **Create the database objects.** SQL Editor → *New query* → paste the entire
   contents of [`supabase/schema.sql`](supabase/schema.sql) → *Run*. It is safe
   to re-run. This creates the `purchases` table, the idempotent
   `record_purchase_event()` upsert, and the atomic `claim_download()` function,
   turns on Row Level Security with no policies (so only the service role can
   read anything), and revokes the functions from the anon key.

5. **Copy your credentials.** Project Settings →
   - *Data API* → **Project URL** → `SUPABASE_URL`
   - *API Keys* → **`service_role`** (click to reveal) → `SUPABASE_SERVICE_ROLE_KEY`

   The `service_role` key ignores Row Level Security entirely. It belongs in
   Vercel's environment variables and your local `.env`, and nowhere else. Never
   paste it into a page, a frontend `.js` file, or a Git commit.

6. **Confirm signed URLs work.** With your `.env` filled in, run:

   ```bash
   npm run check
   ```

   It verifies the bucket is private, generates a real signed URL, fetches it,
   confirms it downloads as an attachment, and confirms the *permanent public
   URL is blocked*.

---

## Vercel deployment

1. **Push to GitHub.**

   ```bash
   git init
   git add .
   git commit -m "Sales page with secure Razorpay + Supabase eBook delivery"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/the-invisible-internet.git
   git push -u origin main
   ```

   Before pushing, confirm `git status` does not list `.env` or anything under
   `uploads/`. Both are git-ignored.

2. **Import into Vercel.** [vercel.com/new](https://vercel.com/new) → import the
   repository. Framework preset: **Other**. No build command, no output
   directory — the HTML is served as-is and everything under `api/` becomes a
   serverless function automatically.

3. **Deploy.** You get a URL like `https://the-invisible-internet.vercel.app`.
   The page will render, but the buy button returns 503 until step 4.

4. **Add environment variables.** Project → Settings → Environment Variables. Add
   every required variable from the table above, for **Production** (and
   Preview, if you want previews to work). Set `PUBLIC_SITE_URL` to the URL from
   step 3, with no trailing slash.

5. **Redeploy.** Environment variables are read at runtime, but a redeploy is the
   reliable way to pick them up: Deployments → latest → ⋯ → *Redeploy*.
   **Any time you change an environment variable, redeploy.**

6. **Test the production URL.** Visit it. The page should look exactly as it did
   before. Clicking *Get the eBook* should land you on Razorpay's checkout.

7. **Configure the Razorpay callback and webhook URLs** — see the next section.

### Two things to check on your first deploy

Neither is caused by the payment work — both are properties of how the page was
already built — but both are worth eyeballing once, on the live URL.

- **The page images.** All seven slots now carry an explicit `src` pointing at a
  WebP in `assets/`, so nothing depends on the old `.image-slots.state.json`
  sidecar (a dotfile the host may not have served) — that file has been deleted.
  Rebuild the WebPs from the master PNGs in `local-source/images/` with:

  ```
  npm run images
  ```

  `image-slot.js` prefers a stored sidecar entry over the `src` attribute, so if
  you ever re-open the page in the design tool and it writes a new sidecar,
  delete it again before deploying.

- **The page renders client-side.** `support.js` loads React and Babel from
  `unpkg.com` and builds the page in the browser. That is how the design was
  authored and I have left it alone, but it does mean the sales page depends on a
  third-party CDN being reachable, and first paint is slower on a weak mobile
  connection. The checkout, verification and download paths do not depend on it
  at all. If you later want the sales page to be plain static HTML with no CDN
  call, that is a self-contained change to the two page files — ask and I'll do
  it, keeping the design identical.

### Custom domain

Add it under Project → Settings → Domains, then change `PUBLIC_SITE_URL` to
`https://yourdomain.com`, redeploy, and update the callback URL in Razorpay and
the webhook URL in Razorpay. No URL is hard-coded anywhere in the code, so those
three edits are the whole migration.

---

## Razorpay setup

Work through this in **Test Mode** first. The toggle is at the top of the
Razorpay dashboard, and test and live modes have completely separate keys,
payment links, and webhooks.

1. **Create your account** at [razorpay.com](https://razorpay.com) and complete
   KYC. Live payments do not work until KYC is approved; Test Mode works
   immediately.

2. **Generate API keys.** Account & Settings → API Keys → *Generate Test Key*.
   Copy both halves — **the key secret is shown only once**.
   → `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`

3. **Do not create a Payment Link by hand.** There is nothing to do in this step
   — and that is deliberate. Two facts about Razorpay make a hand-made link the
   wrong tool here:

   - **A Payment Link is single-use.** Razorpay's FAQ: *"No, you can only accept
     payments from a single customer using a Payment Link."* One link pasted into
     the sales page would sell one copy and then start refusing buyers.
   - **`callback_url` cannot be set in the dashboard.** It is an API-only
     parameter, so there is no field in the Create Payment Link form where the
     verification URL could go.

   So `/api/checkout` creates a fresh Payment Link per buyer through the API,
   with these set automatically:

   | Field | Value |
   | --- | --- |
   | `amount` | `EBOOK_PRICE_PAISE` (24900 = ₹249) |
   | `currency` | `EBOOK_CURRENCY` (INR) |
   | `callback_url` | `PUBLIC_SITE_URL` + `/api/razorpay/callback` |
   | `callback_method` | `get` |
   | `reference_id` | a fresh unique id per checkout |
   | `expire_by` | 24 hours out |

   The callback points at `/api/razorpay/callback`, **not** `/thank-you.html`.
   That endpoint verifies the signature and then forwards the customer to the
   thank-you page itself; sending Razorpay straight to the static page would skip
   verification entirely.

   **To change the price, change `EBOOK_PRICE_PAISE` and redeploy** — then update
   the displayed price in `index.html` to match.

   *If you would rather have one permanent checkout URL*, Razorpay's reusable
   equivalent is a **Payment Page** (Dashboard → Payment Pages). Create one, put
   its URL in `RAZORPAY_PAYMENT_LINK_URL`, and `/api/checkout` will redirect
   there instead. Note that Payment Pages have their own redirect settings, so
   you would need to re-check that the callback still reaches
   `/api/razorpay/callback` with a signature.

4. **Create the webhook.** Account & Settings → Webhooks → *Add New Webhook*.

   - **Webhook URL:**
     ```
     https://YOUR-DOMAIN/api/razorpay/webhook
     ```
   - **Secret:** invent a long random string and paste it in. Generate one with:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
     → `RAZORPAY_WEBHOOK_SECRET` (the same value in both places)
   - **Active events** — tick exactly these five:
     - `payment_link.paid`
     - `payment.captured`
     - `payment.failed`
     - `refund.created`
     - `refund.processed`

     Any other event you subscribe to is safely ignored with a `200`.

5. **Put the values in Vercel** (Settings → Environment Variables) and
   **redeploy**.

6. **Make a test payment.** Open your site, click *Get the eBook*, and pay with a
   Razorpay test card:

   | Field | Value |
   | --- | --- |
   | Card number | `4111 1111 1111 1111` |
   | Expiry | any future date |
   | CVV | any 3 digits |
   | OTP | `1234` (or whatever the test dialog shows) |

   You should land on the thank-you page and the PDF should download.

7. **Check the evidence.**
   - Razorpay → Payment Links → a link for this buyer, marked paid.
   - Razorpay → Webhooks → your webhook shows a delivery with a `200` response.
   - Supabase → Table Editor → `purchases` shows **one** row, `status = paid`,
     `download_count = 1`.
   - Vercel → your project → Logs shows `callback.verified`, `purchase.recorded`,
     `download.granted`.

8. Work through [`TESTING.md`](TESTING.md) before switching to Live Mode.

---

## Local development

```bash
npm install
cp .env.example .env      # then fill in real values
npm run check             # verifies Supabase, the bucket, and signed URLs
npm run dev               # http://localhost:3000
```

`npm run dev` runs `vercel dev`, which serves the static pages and runs the
functions under `api/` exactly as production does. The first run asks you to log
in and link a project.

For local work set `PUBLIC_SITE_URL=http://localhost:3000`. Session cookies drop
the `Secure` flag automatically on `http`, so the flow works without HTTPS.

Two things cannot be fully exercised locally:

- **Razorpay's callback** cannot reach `localhost`. Either test the callback on a
  Vercel preview deployment, or forge a valid callback locally — see TESTING.md,
  Test 1.
- **Webhooks** cannot reach `localhost` either. Use a tunnel
  (`npx localtunnel --port 3000`, `ngrok http 3000`) and point a second, separate
  test webhook at the tunnel URL.

---

## Testing

[`TESTING.md`](TESTING.md) has the full 12-case plan with the exact commands:
successful payment, direct thank-you page access, forged payment id, forged
signature, duplicate webhook, failed payment, refund, expired signed URL,
download limit, invalid token, mobile, and closed-browser-after-payment.

Run `npm run check` any time you change environment variables or Supabase
settings.

---

## Going live: Test Mode → Live Mode

Everything in Razorpay is duplicated between modes. Nothing carries over.

| Step | What to change |
| --- | --- |
| 1 | Complete Razorpay KYC. Live Mode is locked until it is approved. |
| 2 | Flip the dashboard to **Live Mode**. |
| 3 | Generate **live** API keys → new `RAZORPAY_KEY_ID` (`rzp_live_…`) and `RAZORPAY_KEY_SECRET`. |
| 4 | *Nothing to do.* Payment Links are created by `/api/checkout` at runtime, so switching the keys switches the links to live automatically. |
| 5 | *Nothing to do.* The callback URL is built from `PUBLIC_SITE_URL` on every checkout. |
| 6 | Create the webhook **again** in Live Mode, same URL, same five events, and a **new** secret → `RAZORPAY_WEBHOOK_SECRET`. |
| 7 | Update `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` in Vercel → Settings → Environment Variables (Production). |
| 8 | If you moved to a custom domain, update `PUBLIC_SITE_URL` too. |
| 9 | **Redeploy.** |
| 10 | Run `npm run check` — it prints `Razorpay mode: LIVE` when live keys are in use. |
| 11 | Buy your own book with a real card, confirm the download works, then refund yourself from the Razorpay dashboard and confirm the download is refused afterwards. |

Changing `RAZORPAY_KEY_SECRET` invalidates every outstanding session cookie,
because the cookie signing key is derived from it — existing customers would have
to buy again. If that matters to you, set an explicit `DOWNLOAD_SESSION_SECRET`
*before* you take your first real payment, so key rotation and customer sessions
are independent.

Test-mode purchases stay in the `purchases` table. Clear them before launch if
you want clean numbers:

```sql
delete from public.purchases where razorpay_payment_id like 'pay_%';  -- see the table first!
```

---

## Security review

Checked against the requirements, with where each is enforced:

| Requirement | Status | Where |
| --- | --- | --- |
| No secret keys in frontend code | ✅ | `index.html`, `thank-you.html`, `thank-you.js` contain no keys and no PDF URL. Secrets are read only in `lib/` and `api/`, which run server-side |
| No permanent public PDF URL | ✅ | Private bucket; `scripts/check.js` actively asserts the public URL 404s |
| PDF not deployed as a static asset | ✅ | `uploads/` in both `.gitignore` and `.vercelignore` |
| Razorpay callback signature verified | ✅ | `lib/razorpay.js` → `verifyPaymentLinkSignature`, HMAC-SHA256 of `link_id\|ref_id\|status\|payment_id` |
| Razorpay webhook signature verified | ✅ | `verifyWebhookSignature`, HMAC-SHA256 over the **raw** body; body parsing disabled |
| Signature comparison is timing-safe | ✅ | `crypto.timingSafeEqual` on every comparison |
| Duplicate webhooks handled | ✅ | `unique (razorpay_payment_id)` + `record_purchase_event` upsert. Verified: 4 deliveries → 1 row |
| Status can never go backwards | ✅ | `merge_purchase_status`; a late `payment.failed` cannot revoke a paid purchase, and `paid` cannot resurrect a refund |
| Paid status stored server-side | ✅ | `purchases.status` in Postgres; the client is never asked |
| Thank-you page is not proof of payment | ✅ | No cookie → `/api/download` returns 401 and the page shows the error state |
| `?paid=true` / arbitrary `payment_id` not trusted | ✅ | The only accepted evidence is a server-signed cookie; query parameters are used solely as signed input to the HMAC check |
| Download endpoint protected | ✅ | Three independent checks: signed session, current `paid` status, download limit |
| Signed URL generated server-side | ✅ | `lib/supabase.js`; the browser only ever receives the finished URL |
| Supabase bucket private | ✅ | Created private; asserted by `npm run check` |
| Service role key server-only | ✅ | Imported only by `api/` functions; never referenced in any file the browser loads |
| Refunds revoke access | ✅ | `refund.created` / `refund.processed` → status `refunded` → all downloads denied |
| Download limit is race-safe | ✅ | `claim_download` locks the row with `FOR UPDATE` and increments in one transaction. Verified: 20 simultaneous claims against a limit of 5 → exactly 5 allowed |
| Database not readable by the anon key | ✅ | RLS enabled with zero policies; both SQL functions revoked from `anon`/`authenticated` |
| Safe error messages | ✅ | Customers see fixed copy; details go to server logs only |
| Logs exclude secrets | ✅ | `lib/log.js` uses an allow-list of fields; emails are masked; raw payloads are never logged |
| HTTPS in production | ✅ | Vercel is HTTPS-only; HSTS set in `vercel.json`; session cookies are `Secure` + `HttpOnly` + `SameSite=Lax` |

Two things worth knowing rather than fixing:

- **Your source files are publicly readable.** With no build step, Vercel serves
  the repository root, so `https://your-site/lib/session.js` returns that file's
  source. This is intended: those files contain logic and environment *names*,
  never values. Just never write a real secret into a file — always use an
  environment variable.
- **The session cookie is per-browser.** A customer who pays on their phone and
  then opens the thank-you page on their laptop has no session there, and will
  see the verification error. Your recovery path is to look up their payment in
  the Razorpay dashboard and email them the PDF directly. If that becomes
  common, the natural next step is emailing a signed download link at purchase
  time.

---

## Day-to-day admin

**See recent sales** — Supabase → SQL Editor:

```sql
select created_at, razorpay_payment_id, status, amount, currency,
       customer_email, download_count, last_download_at
from public.purchases
order by created_at desc
limit 50;
```

**A customer used all their downloads** — give them a fresh batch:

```sql
update public.purchases
set download_count = 0, updated_at = now()
where razorpay_payment_id = 'pay_XXXXXXXXXXXX';
```

**Revoke access** (e.g. a refund issued outside Razorpay, or abuse):

```sql
update public.purchases
set status = 'refunded', updated_at = now()
where razorpay_payment_id = 'pay_XXXXXXXXXXXX';
```

**Reading the logs** — Vercel → your project → Logs. One JSON line per event:

| Event | Meaning |
| --- | --- |
| `checkout.redirect` | Someone clicked a buy button |
| `callback.verified` | A real, signature-checked payment arrived |
| `callback.rejected` | A callback failed verification — forged, tampered, or not `paid` |
| `purchase.recorded` | A row was written or updated; includes the resulting status |
| `session.issued` | A purchase session cookie was handed out |
| `webhook.rejected` | A webhook failed signature verification |
| `webhook.ignored` | A subscribed event we do not act on |
| `download.granted` | A signed URL was issued; includes the running download count |
| `download.denied` | Refused; `reason` says why (`no_session`, `not_found`, `status_refunded`, `limit_reached`, …) |

A burst of `download.denied` with `reason: no_session` normally means people are
finding `/thank-you.html` directly — which is exactly what should happen to them.

---

## Payment Links vs Standard Checkout

This project implements **Payment Links**, as specified. It works, it is
verified server-side, and it is the least code.

For the record, the trade-off: Standard Checkout (Razorpay's `checkout.js` modal)
keeps the customer on your page instead of sending them to a Razorpay-hosted one,
which usually converts a few percent better, and it lets you collect the
customer's email into the order before payment rather than reading it back
afterwards. The cost is more moving parts — you must create an Order server-side
before opening the modal, and handle the modal's success callback in the browser.

Switching later is not a rewrite: the webhook, the `purchases` table, the session
cookie and `/api/download` all stay exactly as they are. You would replace
`/api/checkout` with an order-creating endpoint and `/api/razorpay/callback` with
a verification endpoint that checks the `order_id|payment_id` signature instead
of the payment-link one. Everything downstream is unchanged.
