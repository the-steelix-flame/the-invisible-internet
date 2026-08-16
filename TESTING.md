# Test plan

Work through this in **Razorpay Test Mode**, on a deployed URL (Vercel preview or
production), before taking real money. Tests 3, 4, 9 and 10 you can also run
locally against `npm run dev`.

Set a shell variable first so you can paste the commands as-is:

```bash
SITE=https://your-project.vercel.app
```

Where a test needs a payment id, take it from Supabase → Table Editor →
`purchases`, or from the Razorpay dashboard.

---

## Test 1 — Normal successful payment

**Do:** open `$SITE`, click *Get the eBook*, pay with test card
`4111 1111 1111 1111`, any future expiry, any CVV, OTP `1234`.

**Expect:**

- [ ] You land on `$SITE/thank-you.html`, and the page looks exactly as it always did
- [ ] The status line reads "Your eBook is ready. Starting your download…"
- [ ] The PDF downloads without you clicking anything, and the page does not navigate away
- [ ] Clicking *Download the eBook* downloads it again
- [ ] Supabase `purchases`: **one** row, `status = paid`, correct `amount` (`24900` for ₹249)
- [ ] Vercel logs show `callback.verified` → `purchase.recorded` → `session.issued` → `download.granted`
- [ ] Razorpay → Webhooks shows a delivery with response `200`

**Also confirm no payment id appears in the address bar** on the thank-you page —
the session lives in an HttpOnly cookie, not the URL.

---

## Test 2 — User opens the thank-you page directly

**Do:** in a private/incognito window (no cookie), open `$SITE/thank-you.html`.

**Expect:**

- [ ] The headline reads **"Nothing to download yet."** — *not* "You're in."
- [ ] The words "Your payment was successful" appear **nowhere** on the page
- [ ] The download button is gone; a **"Get the eBook — ₹249"** button is shown instead
- [ ] That button goes to `/api/checkout` and starts a real payment
- [ ] Nothing flashes a success message first — the wording stays hidden until the
      server answers
- [ ] DevTools → Network → `/api/download` returns **401**
- [ ] The response body contains no URL, no payment id, no internal detail
- [ ] Vercel logs: `download.denied`, `reason: no_session`

Also confirm by hand:

```bash
curl -i $SITE/api/download
# HTTP/2 401 ... {"message":"We couldn't verify your purchase..."}
```

---

## Test 3 — Forged payment id

**Do:** invent a callback with a plausible payment id and no valid signature:

```bash
curl -i "$SITE/api/razorpay/callback?razorpay_payment_id=pay_FAKE123456789&razorpay_payment_link_id=plink_FAKE&razorpay_payment_link_reference_id=&razorpay_payment_link_status=paid&razorpay_signature=abc123"
```

**Expect:**

- [ ] `302` to `/?payment=unverified#pricing` — *not* to the thank-you page
- [ ] **No `Set-Cookie` header in the response**
- [ ] No new row appears in `purchases`
- [ ] Vercel logs: `callback.rejected`, `verified: false`

Then confirm the forged id buys nothing even if someone crafts a cookie: without
the signing secret they cannot produce a valid one, which is Test 10.

---

## Test 4 — Forged signature

**Do:** take the parameters from a *real* Test 1 payment and change one character
of `razorpay_signature`. Also try replaying real parameters with a different
payment id.

**Expect:**

- [ ] `302` away from the thank-you page, no `Set-Cookie`
- [ ] `callback.rejected` in the logs

Same for the webhook:

```bash
curl -i -X POST $SITE/api/razorpay/webhook \
  -H "Content-Type: application/json" \
  -H "X-Razorpay-Signature: 0000000000000000000000000000000000000000000000000000000000000000" \
  -d '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_FORGED","amount":24900,"currency":"INR","status":"captured"}}}}'
```

- [ ] **400 Invalid signature**
- [ ] No row created for `pay_FORGED`
- [ ] Logs: `webhook.rejected`, `reason: bad_signature`

A webhook with **no** signature header at all must also return 400.

---

## Test 5 — Duplicate webhook

**Do:** Razorpay dashboard → Webhooks → your webhook → find the delivery from
Test 1 → *Resend*. Do it three or four times.

**Expect:**

- [ ] Every redelivery returns `200`
- [ ] `purchases` still has exactly **one** row for that payment id
- [ ] `status` stays `paid`
- [ ] `download_count` is unchanged — recording a payment is not a download

Check the count directly:

```sql
select razorpay_payment_id, count(*)
from public.purchases group by 1 having count(*) > 1;
-- must return zero rows
```

---

## Test 6 — Payment failed

**Do:** start a payment and use a card that Razorpay declines in test mode
(`5104 0600 0000 0008`), or abandon the payment page.

**Expect:**

- [ ] You are not sent to the thank-you page with a working download
- [ ] If a `payment.failed` webhook arrives, the row has `status = failed`
- [ ] `curl` with that purchase's session (or the thank-you page in that browser)
      gets **403**
- [ ] Logs: `download.denied`, `reason: status_failed`

Then verify the ordering guarantee: after a successful payment, have Razorpay
resend an *older* `payment.failed` for a different attempt. The paid row must
stay `paid`.

---

## Test 7 — Refunded payment

**Do:** Razorpay → Payments → the Test 1 payment → *Refund*. Then return to the
still-open thank-you page and click download.

**Expect:**

- [ ] The `purchases` row moves to `status = refunded` (via `refund.created` /
      `refund.processed`)
- [ ] `/api/download` returns **403** with *"This purchase is no longer active."*
- [ ] The session cookie is still present and still valid — access is revoked by
      the purchase record, not by logging the customer out
- [ ] Logs: `download.denied`, `reason: status_refunded`

Also test the manual path, for refunds issued outside Razorpay:

```sql
update public.purchases set status = 'refunded' where razorpay_payment_id = 'pay_XXXX';
```

- [ ] Downloads are refused immediately, with no redeploy

---

## Test 8 — Expired signed URL

**Do:** complete a purchase, open DevTools → Network → copy the `url` value from
the `/api/download` response. Wait longer than `DOWNLOAD_URL_EXPIRY_SECONDS`
(10 minutes by default), then paste it into a browser.

To make this quick, temporarily set `DOWNLOAD_URL_EXPIRY_SECONDS=30` in Vercel,
redeploy, and wait 40 seconds.

**Expect:**

- [ ] Inside the window: the PDF downloads
- [ ] After expiry: Supabase returns an error (`400`, "expired"), **not** the file
- [ ] Reloading the thank-you page produces a fresh working URL
- [ ] Restore `DOWNLOAD_URL_EXPIRY_SECONDS=600` and redeploy afterwards

Also confirm the URL is unguessable and time-boxed — it carries a `token` query
parameter; strip it and the request must fail.

---

## Test 9 — Maximum downloads exceeded

**Do:** set `MAX_DOWNLOADS_PER_PURCHASE=2` in Vercel, redeploy, complete a
purchase, then reload the thank-you page repeatedly.

**Expect:**

- [ ] The first two `/api/download` calls succeed
- [ ] The third returns **403** with exactly *"Download limit reached."*
- [ ] `purchases.download_count` reads `2` and stops incrementing
- [ ] Logs: `download.denied`, `reason: limit_reached`

Then verify the off switch:

- [ ] Set `MAX_DOWNLOADS_PER_PURCHASE=0`, redeploy → downloads work again with no
      limit, though `download_count` keeps counting
- [ ] Restore your real value (default `10`) and redeploy

**Race safety** (already verified against a real Postgres, worth re-checking if
you edit the SQL): with a limit of 5, twenty simultaneous claims must grant
exactly five.

---

## Test 10 — Invalid download token

**Do:** try each of these in turn:

```bash
# no cookie at all
curl -i $SITE/api/download

# garbage cookie
curl -i $SITE/api/download -H "Cookie: ii_purchase=nonsense"

# structurally plausible but unsigned
curl -i $SITE/api/download -H "Cookie: ii_purchase=v1.eyJwaWQiOiJwYXlfRkFLRSIsImV4cCI6OTk5OTk5OTk5OX0.aaaa"

# a real token from your own purchase, with one character changed
curl -i $SITE/api/download -H "Cookie: ii_purchase=<real token, one char edited>"
```

**Expect:**

- [ ] All four return **401**
- [ ] All four return the identical generic message — an attacker learns nothing
      about which part failed
- [ ] No `url` field in any response
- [ ] A valid signature naming a payment id that does not exist returns **403**
      `not_found` (you cannot produce this one without the signing secret, which
      is the point)

---

## Test 11 — Mobile device

**Do:** complete a full purchase on a real phone — both iOS Safari and Android
Chrome if you can.

**Expect:**

- [ ] The sales page renders as before, and the sticky bottom CTA works
- [ ] Razorpay's checkout opens and completes (try UPI in test mode)
- [ ] You return to the thank-you page and the session cookie survives the
      round trip through Razorpay
- [ ] The PDF downloads — on iOS Safari the automatic download may be blocked,
      in which case tapping *Download the eBook* must work
- [ ] The status line is legible and does not overflow the card

The manual button is the guaranteed path on mobile; the automatic start is a
convenience. Confirm the button alone is sufficient.

---

## Test 12 — Customer closes the browser after payment

**Do:** start a payment, complete it on Razorpay, and **close the tab the instant
it says success** — before the redirect back completes. (Killing your network
after payment works too.)

**Expect:**

- [ ] The callback never runs, so no session cookie is issued and the customer
      never reaches the thank-you page
- [ ] The webhook still arrives, and `purchases` has the row with `status = paid`
- [ ] Razorpay → Webhooks shows the `payment_link.paid` / `payment.captured`
      delivery with a `200`
- [ ] Logs show `purchase.recorded` with no preceding `callback.verified`

**This is the case that protects you from an angry customer:** the money is
recorded even though the browser gave up. To deliver the book, find the payment
in Razorpay, confirm the row in Supabase, and email them the PDF.

---

## Regression checks after any change

```bash
npm run check     # env vars, table, functions, private bucket, signed URL
```

- [ ] `npm run check` passes end to end
- [ ] `curl -i $SITE/api/download` → 401
- [ ] `curl -i $SITE/api/razorpay/webhook -X POST -d '{}'` → 400
- [ ] `curl -I $SITE/uploads/The%20Invisible%20Internet.pdf` → **404**
- [ ] The Supabase public object URL → **400/404**, never the PDF
- [ ] The sales page still looks exactly as designed
