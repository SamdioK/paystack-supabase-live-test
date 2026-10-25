import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacSha512(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, body)));
}
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!secret || !url || !serviceKey) return json({ error: "Server configuration is incomplete." }, 500);

    // Verify signature against the exact raw request bytes, before parsing JSON.
    const rawBody = new Uint8Array(await req.arrayBuffer());
    const suppliedSignature = req.headers.get("x-paystack-signature") || "";
    const expectedSignature = await hmacSha512(secret, rawBody);
    if (!constantTimeEqual(suppliedSignature.toLowerCase(), expectedSignature)) {
      return json({ error: "Invalid webhook signature." }, 401);
    }

    const event = JSON.parse(new TextDecoder().decode(rawBody));
    if (event.event !== "charge.success" || !event.data?.reference) {
      return json({ received: true, ignored: true });
    }

    const reference = String(event.data.reference);
    const eventKey = `${event.event}:${reference}:${String(event.data.id ?? "")}`;
    const supabase = createClient(url, serviceKey);

    // Unique event_key makes retries idempotent. A duplicate insert returns success without reprocessing.
    const { error: eventInsertError } = await supabase.from("paystack_webhook_events").insert({
      event_key: eventKey, event_type: String(event.event), reference,
    });
    if (eventInsertError) {
      if (eventInsertError.code === "23505") {
        // A fully processed duplicate can be acknowledged. An unfinished event may be a
        // prior transient failure, so allow it to retry instead of silently dropping it.
        const { data: prior, error: priorError } = await supabase
          .from("paystack_webhook_events").select("processed_at,processing_result")
          .eq("event_key", eventKey).maybeSingle();
        if (priorError) throw priorError;
        if (prior?.processed_at) return json({ received: true, duplicate: true });
        if (!prior) throw new Error("Could not inspect duplicate webhook event.");
      } else {
        throw eventInsertError;
      }
    }

    const { data: existing, error: lookupError } = await supabase
      .from("payments").select("*").eq("reference", reference).maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing) {
      await supabase.from("paystack_webhook_events").update({
        processing_result: "unknown_reference", processed_at: new Date().toISOString(),
      }).eq("event_key", eventKey);
      return json({ received: true, ignored: true, reason: "unknown_reference" });
    }

    // Do not trust webhook fields alone: re-verify transaction directly with Paystack.
    const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const verification = await verifyResponse.json();
    const tx = verification?.data;
    const valid = verifyResponse.ok && verification.status === true && tx?.status === "success"
      && tx.reference === existing.reference
      && Number(tx.amount) === Number(existing.amount_kobo)
      && tx.currency === existing.currency;

    if (valid) {
      const { error: updateError } = await supabase.from("payments").update({
        payment_status: "success",
        settlement_status: existing.settlement_status === "settled" ? "settled" : "pending",
        paystack_transaction_id: tx.id == null ? null : String(tx.id),
        gateway_response: String(tx.gateway_response || "success").slice(0, 500),
        paid_at: tx.paid_at || new Date().toISOString(),
        raw_verify: verification,
        updated_at: new Date().toISOString(),
      }).eq("reference", reference);
      if (updateError) throw updateError;
    }

    await supabase.from("paystack_webhook_events").update({
      processing_result: valid ? "verified_success" : "verification_mismatch_or_not_success",
      processed_at: new Date().toISOString(),
    }).eq("event_key", eventKey);

    return json({ received: true, verified: Boolean(valid) });
  } catch (error) {
    console.error("paystack-webhook error", error);
    // Non-2xx lets Paystack retry transient failures.
    return json({ error: error instanceof Error ? error.message : "Unexpected server error" }, 500);
  }
});
