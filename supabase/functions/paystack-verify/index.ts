
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
      "Cache-Control": "no-store",
    },
  });
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "An unexpected error occurred.";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
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

      return respond({
        error: "Server configuration incomplete",
      }, 500);
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(supabaseUrl);
    } catch {
      console.error("SUPABASE_URL is invalid.");

      return respond({
        error: "Server database configuration is invalid",
      }, 500);
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
      return respond({
        error: "Valid payment reference required",
      }, 400);
    }

    const db = createClient(supabaseUrl, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    // Find the payment created by this application.
    const { data: payment, error: lookupError } = await db
      .from("payments")
      .select(
        "reference, email, amount_kobo, currency, payment_status, paid_at"
      )
      .eq("reference", reference)
      .maybeSingle();

    if (lookupError) {
      console.error("Payment database lookup failed:", {
        projectHost: parsedUrl.host,
        code: lookupError.code,
        message: lookupError.message,
      });

      return respond({
        error: "Could not look up payment",
        diagnostic: "DATABASE_LOOKUP_FAILED",
      }, 500);
    }

    if (!payment) {
      // Do not log the full reference or any secret credentials.
      console.error("Payment record not found:", {
        projectHost: parsedUrl.host,
        referenceLength: reference.length,
        referencePrefix: reference.slice(0, 8),
      });

      return respond({
        error: "Unknown payment reference",
        diagnostic: "PAYMENT_RECORD_NOT_FOUND",
      }, 404);
    }

    // Ask Paystack to verify the transaction independently.
    const paystackResponse = await fetch(
      "https://api.paystack.co/transaction/verify/" +
        encodeURIComponent(reference),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      }
    );

    const paystackResult = await paystackResponse
      .json()
      .catch(() => ({}));

    const transaction = paystackResult?.data;

    if (
      !paystackResponse.ok ||
      paystackResult?.status !== true ||
      !transaction
    ) {
      console.error("Paystack verification request failed:", {
        httpStatus: paystackResponse.status,
        message: paystackResult?.message || "No transaction data returned",
      });

      return respond({
        error: "Paystack verification failed",
        diagnostic: "GATEWAY_VERIFICATION_FAILED",
      }, 502);
    }

    // Require all core transaction details to match the stored record.
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

    const verifiedPaidAt =
      isSuccess &&
      typeof transaction.paid_at === "string" &&
      !Number.isNaN(Date.parse(transaction.paid_at))
        ? transaction.paid_at
        : null;

    // Preserve an existing paid_at value if Paystack omits it.
    const paidAtToSave = isSuccess
      ? verifiedPaidAt || payment.paid_at || null
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
          transaction.gateway_response || ""
        ).slice(0, 500),
        paid_at: paidAtToSave,
        raw_verify: paystackResult,
        updated_at: new Date().toISOString(),
      })
      .eq("reference", reference);

    if (updateError) {
      console.error("Payment verification update failed:", {
        code: updateError.code,
        message: updateError.message,
      });

      return respond({
        error: "Could not save verification result",
        diagnostic: "DATABASE_UPDATE_FAILED",
      }, 500);
    }

    // Return only the fields required by the receipt frontend.
    // Settlement details are intentionally excluded.
    return respond({
      reference: payment.reference,
      payment_status: paymentStatus,
      email: payment.email,
      amount_kobo: Number(payment.amount_kobo),
      currency: payment.currency,
      paid_at: paidAtToSave,
      message: isSuccess
        ? "Payment verified successfully."
        : paymentStatus === "unknown"
          ? "Payment details could not be fully verified."
          : "Payment is not confirmed successful.",
    });
  } catch (error) {
    console.error("Payment verification exception:", safeMessage(error));

    return respond({
      error: "Payment verification failed",
      diagnostic: "VERIFICATION_EXCEPTION",
    }, 500);
  }
});
