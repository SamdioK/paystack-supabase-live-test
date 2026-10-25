# Paystack NGN 100 Test Site — Supabase Edge Functions

A small local HTML frontend backed by Supabase Edge Functions. It initializes a fixed **NGN 100 (10,000 kobo)** Paystack transaction, verifies the transaction server-side, validates webhook signatures using the exact raw request body, and protects webhook retries with a unique event key.

> **Live mode:** This is configured for real payments when you add a Paystack **live secret key**. Clicking Pay can charge a real payer. Start with a payment method and account you control. Paystack fees and settlement timing apply. A successful charge does **not** prove that your bank account has already been credited.

## Files

- `index.html` — local frontend. Fill in the Supabase URL and anon/publishable key.
- `supabase/schema.sql` — payment ledger and idempotent webhook-event table.
- `supabase/functions/paystack-initialize/` — server-side transaction initialization; amount is fixed on the server.
- `supabase/functions/paystack-verify/` — verifies reference, status, amount and currency with Paystack.
- `supabase/functions/paystack-webhook/` — HMAC-SHA512 signature check, Paystack re-verification, duplicate-event protection.
- `supabase/config.toml` — disables Supabase JWT verification for these functions because the simple public checkout calls them with the anon key. The functions validate all payment claims with Paystack. For a production app, add user authentication, rate limiting, abuse monitoring and tighter CORS.

## 1. Create/configure your Supabase project

1. Create or open a Supabase project.
2. In **SQL Editor**, run `supabase/schema.sql`.
3. In Project Settings → API, copy the project URL and anon/publishable key.
4. Edit `index.html`, replacing:
   - `https://YOUR_PROJECT_REF.supabase.co`
   - `YOUR_SUPABASE_ANON_OR_PUBLISHABLE_KEY`

Never put a Supabase `service_role` key or Paystack secret key in `index.html`.

## 2. Install Supabase CLI

Install the Supabase CLI using the official instructions: https://supabase.com/docs/guides/cli

Then sign in and link the project from this directory:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

## 3. Set server-side secrets

Use your Paystack **live secret key** only in Supabase function secrets. Never paste it into source code, chat, frontend HTML or GitHub.

```bash
supabase secrets set PAYSTACK_SECRET_KEY=sk_live_REPLACE_WITH_YOUR_KEY
```

Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to deployed Edge Functions automatically. If your project setup does not provide these runtime variables, set them through Supabase secrets using the values from your project's API settings, keeping the service-role key server-side only.

Optional: set `APP_ORIGIN` to the URL that will host your frontend. For local testing, leave it unset; the Paystack callback can be set in the Paystack dashboard to a public URL later. A callback is a browser redirect, not a webhook endpoint.

## 4. Deploy functions

From the project root:

```bash
supabase functions deploy paystack-initialize
supabase functions deploy paystack-verify
supabase functions deploy paystack-webhook
```

`supabase/config.toml` disables platform JWT verification for these three endpoints. The webhook must be callable by Paystack, which cannot provide your Supabase user JWT. Since this demo also allows anonymous initialization/verification, it is a prototype: before using it for a public business, add abuse/rate controls and authentication appropriate to your checkout.

## 5. Run the local website

You can open `index.html` directly in a browser, but a local HTTP server is more reliable:

```bash
python -m http.server 8080
```

Visit http://localhost:8080.

The local browser page can call the deployed Supabase functions over HTTPS. It does **not** need a local backend process.

## 6. Configure the Paystack webhook

Paystack cannot call `localhost`. For webhook delivery, the endpoint must be publicly reachable. In Paystack Dashboard → Settings/Developers → Webhooks, configure:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/paystack-webhook
```

Configure it for the **live environment**. Keep the test and live environments/keys separate. The function verifies `x-paystack-signature` as HMAC-SHA512 of the raw request body using the live secret key, and independently calls Paystack's Verify Transaction API before updating the ledger.

## 7. Perform the NGN 100 test

1. Confirm your Paystack live account is enabled to accept payments and its settlement bank account is correctly configured.
2. Open the local page and enter your email.
3. Click **Continue to secure Paystack checkout**.
4. Complete the real NGN 100 payment with a payment method you control.
5. On return, the page calls `paystack-verify`. A successful transaction should show `Payment status: success`.
6. In Supabase Table Editor, inspect `public.payments` by the transaction reference.
7. In Paystack Dashboard, inspect the transaction, then separately inspect settlement/payout information and your destination bank account.

### Payment vs settlement

- `payment_status = success` means Paystack's Verify Transaction API confirmed the charge and the expected amount/currency/reference matched.
- `settlement_status = pending` means the payment succeeded but this demo has not independently confirmed a bank settlement.
- This demo deliberately does not automatically mark a payment `settled`. It has no authoritative settlement-feed integration. Confirm settlement in Paystack's dashboard/bank account and update the ledger only from a trusted, independently verified settlement source.

## Security and production caveats

- Never expose `PAYSTACK_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`.
- The payment amount is fixed at 10,000 kobo on the server; do not accept a client-provided amount.
- Webhook signatures are validated before parsing the payload; repeated successful events are protected by a unique database key.
- The webhook re-verifies the transaction with Paystack and checks amount/currency/reference before updating a payment.
- For a production application, authenticate customers where appropriate, apply rate limits/CAPTCHA or abuse controls, restrict CORS to your real origin, add monitoring, define retention for `raw_verify`, and review applicable legal, tax and privacy requirements.
- This minimal test page is not a full merchant checkout or settlement reconciliation system.

## Official references

- Accept payments: https://paystack.com/docs/payments/accept-payments/
- Verify payments: https://paystack.com/docs/payments/verify-payments/
- Webhooks: https://paystack.com/docs/payments/webhooks/
- API keys: https://paystack.com/docs/developer-tools/api-keys/
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
