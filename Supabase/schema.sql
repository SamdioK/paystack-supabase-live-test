-- Payment records for the NGN 100 Paystack test
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  email text not null,
  amount_kobo bigint not null check (amount_kobo > 0),
  currency text not null default 'NGN',
  payment_status text not null default 'pending'
    check (payment_status in (
      'pending', 'success', 'failed', 'abandoned',
      'ongoing', 'processing', 'reversed', 'unknown'
    )),
  settlement_status text not null default 'not_checked'
    check (settlement_status in (
      'not_checked', 'pending', 'settled', 'failed', 'unknown'
    )),
  paystack_transaction_id text,
  gateway_response text,
  paid_at timestamptz,
  settlement_reference text,
  raw_verify jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Prevent duplicate webhook events
create table if not exists public.paystack_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event_type text not null,
  reference text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_result text
);

-- Keep both tables inaccessible through public client policies
alter table public.payments enable row level security;
alter table public.paystack_webhook_events enable row level security;

-- Do not add public read or write policies.
-- Edge Functions must use the server-side service role key.
