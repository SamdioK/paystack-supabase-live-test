
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
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
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
      console.error("Payment verification configuration is incomplete.");

      return respond(
        { error: "Server configuration incomplete" },
        500,
      );
    }

    const body = await req.json().catch(() => null);

    const reference =
      typeof body?.reference === "string"
        ? body.reference.trim()
        : "";

    if (
      !reference ||
      reference.length > 150 ||
      !/^[A-Za-z0-9_-]+$/.test(reference)
    ) {
      return respond(
        { error: "Valid payment reference required" },
        400,
      );
    }

    const db = createClient(supabaseUrl, serviceKey);

    // Only verify references created and recorded by this application.
    const { data: payment, error: lookupError } = await db
      .from("payments")
      .select(
        "reference, email, amount_kobo, currency, payment_status, paid_at",
      )
      .eq("reference", reference)
      .maybeSingle();

    if (lookupError) {
      console.error("Payment lookup failed:", lookupError.message);

      return respond(
        { error: "Could not look up payment" },
        500,
      );
    }

    if (!payment) {
      return respond(
        { error: "Unknown payment reference" },
        404,
      );
    }

    // Verify the transaction directly with Paystack.
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: "application/json",
        },
      },
    );

    const result = await response.json().catch(() => ({}));
    const transaction = result?.data;

    if (
      !response.ok ||
      result.status !== true ||
      !transaction
    ) {
      console.error(
        "Paystack verification request failed:",
        result?.message || response.status,
      );

      return respond(
        { error: "Paystack verification failed" },
        502,
      );
    }

    // Validate the transaction against the server-created payment record.
    const matches =
      transaction.reference === payment.reference &&
      Number(transaction.amount) === Number(payment.amount_kobo) &&
      transaction.currency === payment.currency &&
      typeof transaction.status === "string";

    let paymentStatus = matches
      ? transaction.status.toLowerCase()
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

    const isSuccess =
      matches && paymentStatus === "success";

    // Use the actual Paystack paid_at timestamp for a successful receipt.
    const verifiedPaidAt =
      isSuccess && typeof transaction.paid_at === "string"
        ? transaction.paid_at
        : null;

    const { error: updateError } = await db
      .from("payments")
      .update({
        payment_status: paymentStatus,
        paystack_transaction_id:
          transaction.id == null
            ? null
            : String(transaction.id),
        gateway_response: String(
          transaction.gateway_response || "",
        ).slice(0, 500),
        paid_at: isSuccess
          ? verifiedPaidAt || payment.paid_at || null
          : null,
        raw_verify: result,
        updated_at: new Date().toISOString(),
      })
      .eq("reference", reference);

    if (updateError) {
      console.error("Payment update failed:", updateError.message);

      return respond(
        { error: "Could not save verification result" },
        500,
      );
    }

    // The frontend uses these verified fields to construct the receipt.
    // Settlement details are deliberately not returned.
    return respond({
      reference: payment.reference,
      payment_status: paymentStatus,
      email: payment.email,
      amount_kobo: Number(payment.amount_kobo),
      currency: payment.currency,
      paid_at: isSuccess
        ? verifiedPaidAt || payment.paid_at || null
        : null,
      message: isSuccess
        ? "Payment verified successfully."
        : paymentStatus === "unknown"
          ? "Payment details could not be fully verified."
          : "Payment is not confirmed successful.",
    });
  } catch (error) {
    console.error("Verification error:", error);

    return respond(
      { error: "Payment verification failed" },
      500,
    );
  }
});
