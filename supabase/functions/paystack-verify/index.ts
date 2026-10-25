import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
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

    const body = await req.json().catch(() => null);
    const reference =
      typeof body?.reference === "string" ? body.reference.trim() : "";

    if (
      !reference ||
      reference.length > 150 ||
      !/^[A-Za-z0-9_-]+$/.test(reference)
    ) {
      return respond({ error: "Valid payment reference required" }, 400);
    }

    const db = createClient(supabaseUrl, serviceKey);

    const { data: payment, error: lookupError } = await db
      .from("payments")
      .select("*")
      .eq("reference", reference)
      .maybeSingle();

    if (lookupError) {
      console.error("Payment lookup failed:", lookupError);
      return respond({ error: "Could not look up payment" }, 500);
    }

    if (!payment) {
      return respond({ error: "Unknown payment reference" }, 404);
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );

    const result = await response.json().catch(() => ({}));
    const transaction = result?.data;

    if (!response.ok || result.status !== true || !transaction) {
      return respond({ error: "Paystack verification failed" }, 502);
    }

    const matches =
      transaction.reference === payment.reference &&
      Number(transaction.amount) === Number(payment.amount_kobo) &&
      transaction.currency === payment.currency;

    let paymentStatus = matches
      ? String(transaction.status || "unknown").toLowerCase()
      : "unknown";

    const allowedStatuses = [
      "success",
      "failed",
      "abandoned",
      "ongoing",
      "processing",
      "reversed",
    ];

    if (!allowedStatuses.includes(paymentStatus)) {
      paymentStatus = "unknown";
    }

    const isSuccess = matches && paymentStatus === "success";

    // Successful payment is not proof of bank settlement.
    const settlementStatus = isSuccess
      ? payment.settlement_status === "settled"
        ? "settled"
        : "pending"
      : payment.settlement_status;

    const { error: updateError } = await db
      .from("payments")
      .update({
        payment_status: paymentStatus,
        settlement_status: settlementStatus,
        paystack_transaction_id:
          transaction.id == null ? null : String(transaction.id),
        gateway_response: String(transaction.gateway_response || "").slice(
          0,
          500,
        ),
        paid_at: isSuccess
          ? transaction.paid_at || new Date().toISOString()
          : null,
        raw_verify: result,
        updated_at: new Date().toISOString(),
      })
      .eq("reference", reference);

    if (updateError) {
      console.error("Payment update failed:", updateError);
      return respond({ error: "Could not save verification result" }, 500);
    }

    return respond({
      reference,
      payment_status: paymentStatus,
      settlement_status: settlementStatus,
      message: isSuccess
        ? "Payment verified. Settlement is tracked separately."
        : "Payment is not confirmed successful.",
    });
  } catch (error) {
    console.error("Verification error:", error);
    return respond({ error: "Payment verification failed" }, 500);
  }
});
