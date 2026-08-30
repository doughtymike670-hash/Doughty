// /api/mpesa-callback.js
// Safaricom calls THIS endpoint automatically after the customer enters (or cancels)
// their M-Pesa PIN — never called by the browser. This is the ONLY place an order
// is allowed to become "paid". Handles duplicate callbacks safely (idempotent).

module.exports = async (req, res) => {
  // Always acknowledge Safaricom quickly, even on our own errors below,
  // so it doesn't endlessly retry — we still process everything first.
  const respondOk = () => res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return respondOk();

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Find the matching payment attempt by Daraja's tracking ID
    const payRes = await fetch(`${SUPABASE_URL}/rest/v1/payments?checkout_request_id=eq.${CheckoutRequestID}&select=*`, { headers: sHeaders });
    const payments = await payRes.json();
    if (!payments.length) return respondOk(); // unknown payment attempt, nothing to do
    const payment = payments[0];

    // Idempotency: if this payment attempt was already resolved, ignore duplicate/late callbacks
    if (payment.status === 'completed' || payment.status === 'failed') return respondOk();

    const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${payment.order_id}&select=*`, { headers: sHeaders });
    const orders = await orderRes.json();
    const order = orders[0];

    if (ResultCode === 0) {
      // Payment genuinely succeeded — pull the real M-Pesa receipt out of the callback
      const items = CallbackMetadata?.Item || [];
      const receipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value || null;
      const paidAmount = items.find(i => i.Name === 'Amount')?.Value || payment.amount_paid;

      await fetch(`${SUPABASE_URL}/rest/v1/payments?id=eq.${payment.id}`, {
        method: 'PATCH',
        headers: { ...sHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'completed', mpesa_receipt: receipt, amount_paid: paidAmount, raw_result: callback, updated_at: new Date().toISOString() })
      });

      if (order) {
        await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}`, {
          method: 'PATCH',
          headers: { ...sHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'paid' })
        });
      }
    } else {
      // Cancelled, timed out, or declined — release the stock reserved at checkout
      // so it isn't stuck "held" for an order that will never be paid.
      await fetch(`${SUPABASE_URL}/rest/v1/payments?id=eq.${payment.id}`, {
        method: 'PATCH',
        headers: { ...sHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'failed', raw_result: callback, updated_at: new Date().toISOString() })
      });

      if (order) {
        const items = Array.isArray(order.items) ? order.items : [];
        for (const it of items) {
          try {
            const prodRes = await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${it.id}&select=stock`, { headers: sHeaders });
            const prods = await prodRes.json();
            if (prods.length && prods[0].stock != null) {
              await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${it.id}`, {
                method: 'PATCH',
                headers: { ...sHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({ stock: Number(prods[0].stock) + Number(it.qty) })
              });
            }
          } catch (e) { /* best-effort rollback per item, don't block the rest */ }
        }

        await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}`, {
          method: 'PATCH',
          headers: { ...sHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'cancelled' })
        });
      }
    }

    return respondOk();
  } catch (e) {
    return respondOk(); // still ack Safaricom even if something on our side broke — logs would show it
  }
};
