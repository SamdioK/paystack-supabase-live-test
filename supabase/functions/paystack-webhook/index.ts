import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-paystack-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createSignature(secret: string, body: Uint8Array) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );

  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", cryptoKey, body),
    ),
  );
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers });
  }

  if (req.method !== "POST") {
    return respond({ error: "Method not allowed" }, 405);
  }

  try {
    const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!secret || !supabaseUrl || !serviceKey) {
      return respond({ error: "Server configuration incomplete" }, 500);
    }

    // Read the exact raw body before parsing, as required for signature validation.
    const rawBody = new Uint8Array(await req.arrayBuffer());
    const suppliedSignature =
      req.headers.get("x-paystack-signature") || "";
    const expectedSignature = await createSignature(secret, rawBody);

    if (!safeEqual(suppliedSignature.toLowerCase(), expectedSignature)) {
      return respond({ error: "Invalid Paystack signature" }, 401);
    }

    const event = JSON.parse(new TextDecoder().decode(rawBody));

    if (event.event !== "charge.success" || !event.data?.reference) {
      return respond({ received: true, ignored: true });
    }

    const reference = String(event.data.reference);
    const eventKey =
      `${event.event}:${reference}:${String(event.data.id ?? "")}`;

    const db = createClient(supabaseUrl, serviceKey);

    // Claim each event once; the unique database constraint prevents duplicates.
    const { error: insertError } = await db
      .from("paystack_webhook_events")
      .insert({
        event_key: eventKey,
        event_type: String(event.event),
        reference,
      });

    if (insertError) {
      if (insertError.code === "23505") {
        const { data: prior, error } = await db
          .from("paystack_webhook_events")
          .select("processed_at")
          .eq("event_key", eventKey)
          .maybeSingle();

        if (error) throw error;
        if (prior?.processed_at) {
          return respond({ received: true, duplicate: true });
        }

        // An unprocessed duplicate may be retried by Paystack.
        return respond({ error: "Event is already being processed" }, 503);
      }

      throw insertError;
    }

    const { data: payment, error: lookupError } = await db
      .from("payments")
      .select("*")
      .eq("reference", reference)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (!payment) {
      await db.from("paystack_webhook_events").update({
        processing_result: "unknown_reference",
        processed_at: new Date().toISOString(),
      }).eq("event_key", eventKey);

      return respond({ received: true, ignored: true });
    }

    // Re-verify directly with Paystack instead of trusting webhook data alone.
    const verifyResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );

    const verification = await verifyResponse.json().catch(() => ({}));
    const tx = verification?.data;

    const valid =
      verifyResponse.ok &&
      verification.status === true &&
      tx?.status === "success" &&
      tx.reference === payment.reference &&
      Number(tx.amount) === Number(payment.amount_kobo) &&
      tx.currency === payment.currency;

    if (valid) {
      const { error } = await db.from("payments").update({
        payment_status: "success",
        settlement_status:
          payment.settlement_status === "settled" ? "settled" : "pending",
        paystack_transaction_id:
          tx.id == null ? null : String(tx.id),
        gateway_response: String(tx.gateway_response || "success").slice(
          0,
          500,
        ),
        paid_at: tx.paid_at || new Date().toISOString(),
        raw_verify: verification,
        updated_at: new Date().toISOString(),
      }).eq("reference", reference);

      if (error) throw error;
    }

    const { error: eventUpdateError } = await db
      .from("paystack_webhook_events")
      .update({
        processing_result: valid
          ? "verified_success"
          : "verification_mismatch_or_not_success",
        processed_at: new Date().toISOString(),
      })
      .eq("event_key", eventKey);

    if (eventUpdateError) throw eventUpdateError;

    return respond({ received: true, verified: Boolean(valid) });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return respond({ error: "Webhook processing failed; retry may be attempted" }, 500);
  }
});
