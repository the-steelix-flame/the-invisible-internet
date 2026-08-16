#!/usr/bin/env node
/**
 * Setup checker — `npm run check`
 *
 * Verifies the pieces you configured by hand: environment variables, the
 * purchases table, the SQL functions, the private bucket, and signed URL
 * generation. Run it locally against your `.env`, before and after going live.
 *
 * It writes nothing and creates no purchase records.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Load .env by hand so this script has no extra dependency.
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
} catch {
  console.log("· No .env file found — checking process environment instead.\n");
}

let failures = 0;
const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg, detail) => {
  failures += 1;
  console.log(`  ❌ ${msg}${detail ? `\n       ${detail}` : ""}`);
};
const warn = (msg) => console.log(`  ⚠️  ${msg}`);

console.log("Environment variables");
const required = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PUBLIC_SITE_URL",
];
for (const name of required) {
  if (process.env[name]?.trim()) pass(name);
  else fail(`${name} is missing`);
}
if (!process.env.RAZORPAY_PAYMENT_LINK_URL?.trim()) {
  warn("RAZORPAY_PAYMENT_LINK_URL is missing — /api/checkout will return 503.");
} else {
  pass("RAZORPAY_PAYMENT_LINK_URL");
}

const mode = process.env.RAZORPAY_KEY_ID?.startsWith("rzp_live_") ? "LIVE" : "TEST";
console.log(`\nRazorpay mode: ${mode}`);
if (mode === "LIVE") warn("Live keys are in use. Real money will move.");

if (failures > 0) {
  console.log("\nFix the variables above, then run this again.");
  process.exit(1);
}

const bucket = process.env.EBOOK_STORAGE_BUCKET || "ebook";
const path = process.env.EBOOK_STORAGE_PATH || "the-invisible-internet.pdf";
const expiry = Number.parseInt(process.env.DOWNLOAD_URL_EXPIRY_SECONDS || "600", 10);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

console.log("\nDatabase");
{
  const { error } = await supabase.from("purchases").select("id").limit(1);
  if (error) fail("purchases table is not readable", error.message);
  else pass("purchases table exists");
}
{
  // Query a payment id that cannot exist, so nothing is written.
  const { data, error } = await supabase.rpc("claim_download", {
    p_payment_id: "pay_setup_check_does_not_exist",
    p_max: 1,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error) fail("claim_download() is missing", error.message);
  else if (row?.reason === "not_found") pass("claim_download() works and denies unknown purchases");
  else fail("claim_download() returned something unexpected", JSON.stringify(row));
}
{
  // Postgres resolves the function signature without executing it when the
  // arguments are wrong, so probe with a deliberately invalid payment id.
  const { error } = await supabase.rpc("record_purchase_event", { p_payment_id: "" });
  if (error && /p_payment_id is required/.test(error.message)) {
    pass("record_purchase_event() works and validates its input");
  } else if (error && /Could not find the function/i.test(error.message)) {
    fail("record_purchase_event() is missing — run supabase/schema.sql", error.message);
  } else if (error) {
    fail("record_purchase_event() errored unexpectedly", error.message);
  } else {
    fail("record_purchase_event() accepted an empty payment id — schema is out of date");
  }
}

console.log("\nStorage");
{
  const { data, error } = await supabase.storage.getBucket(bucket);
  if (error) fail(`bucket "${bucket}" not found`, error.message);
  else if (data?.public) fail(`bucket "${bucket}" is PUBLIC — make it private in Supabase`);
  else pass(`bucket "${bucket}" exists and is private`);
}
{
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiry, { download: process.env.EBOOK_DOWNLOAD_FILENAME || true });
  if (error || !data?.signedUrl) {
    fail(`cannot sign ${bucket}/${path}`, error?.message ?? "no URL returned");
  } else {
    pass(`signed URL generated for ${bucket}/${path} (valid ${expiry}s)`);
    const res = await fetch(data.signedUrl, { method: "GET", headers: { Range: "bytes=0-99" } });
    if (res.ok) {
      const disposition = res.headers.get("content-disposition") || "";
      pass(`signed URL downloads (HTTP ${res.status})`);
      if (disposition.includes("attachment")) pass("served as an attachment");
      else warn(`Content-Disposition is "${disposition}" — expected attachment`);
    } else {
      fail(`signed URL did not fetch (HTTP ${res.status})`);
    }
  }
}
{
  // The permanent public URL must NOT work. If it does, the PDF is downloadable
  // by anyone who guesses the path.
  const publicUrl = `${process.env.SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${bucket}/${encodeURIComponent(path)}`;
  const res = await fetch(publicUrl).catch(() => null);
  if (res && res.ok) fail(`the PDF is reachable without a signature at ${publicUrl}`);
  else pass("the permanent public URL is blocked");
}

console.log(
  failures === 0
    ? "\nAll checks passed.\n"
    : `\n${failures} check(s) failed — see above.\n`,
);
process.exit(failures === 0 ? 0 : 1);
