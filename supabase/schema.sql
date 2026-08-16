-- The Invisible Internet — purchase ledger
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query
-- -> paste -> Run). It is safe to re-run: everything is created with
-- "if not exists" / "or replace".

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Idempotency key. Razorpay retries webhooks; this unique constraint is what
  -- guarantees a retry updates the existing row instead of inserting a new one.
  razorpay_payment_id text not null unique,

  razorpay_payment_link_id text,
  razorpay_payment_link_reference_id text,

  amount bigint,                 -- smallest currency unit (paise for INR)
  currency text,

  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'refunded')),

  customer_name text,
  customer_email text,

  download_count integer not null default 0,
  last_download_at timestamptz
);

create index if not exists purchases_payment_link_id_idx
  on public.purchases (razorpay_payment_link_id);
create index if not exists purchases_status_idx
  on public.purchases (status);

-- RLS on with no policies: anon and authenticated keys can read nothing at all.
-- Only the Service Role Key (server-side, in Vercel env vars) can touch this table.
alter table public.purchases enable row level security;

-- ---------------------------------------------------------------------------
-- Status precedence
-- ---------------------------------------------------------------------------
-- Statuses only ever move forward. Without this, an out-of-order webhook
-- delivery (Razorpay does not guarantee ordering) could downgrade a paid
-- purchase back to pending, or resurrect a refunded one as paid.

create or replace function public.purchase_status_rank(p_status text)
returns integer
language sql
immutable
as $$
  select case p_status
    when 'refunded' then 4
    when 'paid'     then 3
    when 'failed'   then 2
    else 1                       -- pending / anything unrecognised
  end;
$$;

create or replace function public.merge_purchase_status(p_current text, p_incoming text)
returns text
language sql
immutable
as $$
  select case
    when public.purchase_status_rank(p_incoming) > public.purchase_status_rank(p_current)
      then p_incoming
    else p_current
  end;
$$;

-- ---------------------------------------------------------------------------
-- Idempotent upsert, called by the callback and webhook endpoints
-- ---------------------------------------------------------------------------

create or replace function public.record_purchase_event(
  p_payment_id text,
  p_link_id    text default null,
  p_ref_id     text default null,
  p_amount     bigint default null,
  p_currency   text default null,
  p_status     text default 'pending',
  p_name       text default null,
  p_email      text default null
)
returns public.purchases
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.purchases;
begin
  if p_payment_id is null or p_payment_id = '' then
    raise exception 'record_purchase_event: p_payment_id is required';
  end if;

  insert into public.purchases as p (
    razorpay_payment_id, razorpay_payment_link_id, razorpay_payment_link_reference_id,
    amount, currency, status, customer_name, customer_email
  )
  values (
    p_payment_id, nullif(p_link_id, ''), nullif(p_ref_id, ''),
    p_amount, nullif(p_currency, ''), coalesce(nullif(p_status, ''), 'pending'),
    nullif(p_name, ''), nullif(p_email, '')
  )
  on conflict (razorpay_payment_id) do update set
    -- coalesce: a later event that omits a field must not blank out a value an
    -- earlier event already recorded.
    razorpay_payment_link_id           = coalesce(excluded.razorpay_payment_link_id, p.razorpay_payment_link_id),
    razorpay_payment_link_reference_id = coalesce(excluded.razorpay_payment_link_reference_id, p.razorpay_payment_link_reference_id),
    amount                             = coalesce(excluded.amount, p.amount),
    currency                           = coalesce(excluded.currency, p.currency),
    customer_name                      = coalesce(excluded.customer_name, p.customer_name),
    customer_email                     = coalesce(excluded.customer_email, p.customer_email),
    status                             = public.merge_purchase_status(p.status, excluded.status),
    updated_at                         = now()
  returning * into rec;

  return rec;
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic download authorisation, called by /api/download
-- ---------------------------------------------------------------------------
-- Locking the row and incrementing inside one transaction means two clicks
-- landing at the same instant cannot both pass a limit that only had room for one.

create or replace function public.claim_download(
  p_payment_id text,
  p_max integer default 10       -- 0 disables the limit
)
returns table (allowed boolean, reason text, downloads integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.purchases;
  new_count integer;
begin
  select * into rec
  from public.purchases
  where razorpay_payment_id = p_payment_id
  for update;

  if not found then
    return query select false, 'not_found'::text, 0;
    return;
  end if;

  if rec.status <> 'paid' then
    return query select false, ('status_' || rec.status)::text, rec.download_count;
    return;
  end if;

  if p_max > 0 and rec.download_count >= p_max then
    return query select false, 'limit_reached'::text, rec.download_count;
    return;
  end if;

  update public.purchases as p
     set download_count   = p.download_count + 1,
         last_download_at = now(),
         updated_at       = now()
   where p.id = rec.id
  returning p.download_count into new_count;

  return query select true, 'ok'::text, new_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
-- These functions are SECURITY DEFINER, so they must not be callable with the
-- public anon key that ships in browsers.

revoke all on function public.record_purchase_event(text, text, text, bigint, text, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_download(text, integer) from public, anon, authenticated;

grant execute on function public.record_purchase_event(text, text, text, bigint, text, text, text, text) to service_role;
grant execute on function public.claim_download(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Handy admin queries
-- ---------------------------------------------------------------------------
-- Recent purchases:
--   select created_at, razorpay_payment_id, status, amount, currency,
--          customer_email, download_count, last_download_at
--   from public.purchases order by created_at desc limit 50;
--
-- Revoke access after a refund Razorpay could not tell us about:
--   update public.purchases set status = 'refunded', updated_at = now()
--   where razorpay_payment_id = 'pay_XXXXXXXXXXXX';
--
-- Give a customer a fresh batch of downloads:
--   update public.purchases set download_count = 0, updated_at = now()
--   where razorpay_payment_id = 'pay_XXXXXXXXXXXX';
