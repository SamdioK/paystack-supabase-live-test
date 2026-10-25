
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

    // Identify missing server configuration without exposing secret values.
    if (!secret || !supabaseUrl || !serviceKey) {
      const missing = [
        ...(!secret ? ["PAYSTACK_SECRET_KEY"] : []),
        ...(!supabaseUrl ? ["SUPABASE_URL"] : []),
        ...(!serviceKey ? ["SUPABASE_SERVICE_ROLE_KEY"] : []),
      ];

      console.error("Missing configuration:", missing);

      return respond(
        {
          error: "Server configuration incomplete",
          missing,
        },
        500,
      );
    }

    const body = await req.json().catch(() => null);

    const email =
      typeof body?.email === "string"
        ? body.email.trim().toLowerCase()
        : "";

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return respond(
        { error: "Enter a valid email address" },
        400,
      );
    }

    // Fixed server-side amount: NGN 100 = 10,000 kobo.
    const amount = 10000;
    const reference =
      `ngn100_${crypto.randomUUID().replaceAll("-", "")}`;

    const db = createClient(supabaseUrl, serviceKey);

    const { error: insertError } = await db
      .from("payments")
      .insert({
        reference,
        email,
        amount_kobo: amount,
        currency: "NGN",
        payment_status: "pending",
        settlement_status: "not_checked",
      });

    if (insertError) {
      console.error("Payment ledger insert failed:", insertError.message);

      return respond(
        { error: "Could not create payment record" },
        500,
      );
    }

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          amount,
          currency: "NGN",
          reference,
          metadata: {
            integration: "supabase-ngn100-test",
          },
        }),
      },
    );

    const result = await response.json().catch(() => ({}));

    if (
      !response.ok ||
      result.status !== true ||
      !result.data?.authorization_url
    ) {
      await db
        .from("payments")
        .update({ payment_status: "failed" })
        .eq("reference", reference);

      console.error(
        "Paystack initialization failed:",
        result.message ?? "Unknown Paystack error",
      );

      return respond(
        { error: "Paystack could not initialize the payment" },
        502,
      );
    }

    return respond({
      authorization_url: result.data.authorization_url,
      reference: result.data.reference,
    });
  } catch (error) {
    console.error("Initialization error:", error);

    return respond(
      { error: "Payment initialization failed" },
      500,
    );
  }
});
