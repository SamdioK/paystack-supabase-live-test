import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(data: unknown, status = 200): Response {
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
    const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!paystackSecret || !supabaseUrl || !serviceRoleKey) {
      return respond({ error: "Server configuration incomplete" }, 500);
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
      return respond({ error: "Enter a valid email address" }, 400);
    }

    // The server fixes the amount: NGN 100 = 10,000 kobo.
    const amount = 10000;
    const reference =
      `ngn100_${crypto.randomUUID().replaceAll("-", "")}`;

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { error: insertError } = await supabase
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
      console.error("Payment record creation failed:", insertError);
      return respond({ error: "Could not create payment record" }, 500);
    }

    const paystackResponse = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paystackSecret}`,
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

    const result = await paystackResponse.json().catch(() => ({}));

    if (
      !paystackResponse.ok ||
      result.status !== true ||
      !result.data?.authorization_url
    ) {
      await supabase
        .from("payments")
        .update({ payment_status: "failed" })
        .eq("reference", reference);

      console.error("Paystack initialization failed:", result.message);
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
    return respond({ error: "Payment initialization failed" }, 500);
  }
});
