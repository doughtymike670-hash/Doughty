// /api/stk-push.js
// Called at checkout when the store has real M-Pesa configured. Decrypts that
// store's Daraja credentials server-side, requests an STK Push from Safaricom.
// The amount is ALWAYS read from the order record in the database, never taken
// from what the browser sends — a client can lie about the price, the database can't.

const crypto = require('crypto');

function decrypt(b64, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const data = Buffer.from(b64, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const enc = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function daraja(env) {
  return env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { order_id, username, phone } = req.body || {};
  if (!order_id || !username || !phone) return res.status(400).json({ error: 'Missing required fields.' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ENC_KEY = process.env.ENCRYPTION_KEY;
  const CALLBACK_URL = process.env.MPESA_CALLBACK_URL; // e.g. https://yoursite.vercel.app/api/mpesa-callback

  const sHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  try {
    // 1. Look up the store by username, confirm M-Pesa is actually enabled for it
    const storeRes = await fetch(`${SUPABASE_URL}/rest/v1/stores?username=eq.${username}&status=eq.active&select=*`, { headers: sHeaders });
    const stores = await storeRes.json();
    if (!stores.length || !stores[0].mpesa_enabled) return res.status(400).json({ error: 'This store has not set up M-Pesa payments.' });
    const store = stores[0];

    // 2. Fetch the REAL order and its REAL total — never trust an amount from the browser
    const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order_id}&store_id=eq.${store.id}&select=*`, { headers: sHeaders });
    const orders = await orderRes.json();
    if (!orders.length) return res.status(404).json({ error: 'Order not found.' });
    const order = orders[0];
    // Check if there's already a completed payment for this order
    const existingPayRes = await fetch(`${SUPABASE_URL}/rest/v1/payments?order_id=eq.${order_id}&status=eq.completed&select=id`, { headers: sHeaders });
    const existingPay = await existingPayRes.json();
    if (existingPay.length) return res.status(400).json({ error: 'This order is already paid.' });
    const amount = Math.round(Number(order.total));

    // 3. Decrypt this store's own Daraja credentials
    const consumerKey = store.mpesa_consumer_key_enc ? decrypt(store.mpesa_consumer_key_enc, ENC_KEY) : process.env.DARAJA_CONSUMER_KEY;
    const consumerSecret = store.mpesa_consumer_secret_enc ? decrypt(store.mpesa_consumer_secret_enc, ENC_KEY) : process.env.DARAJA_CONSUMER_SECRET;
    const passkey = decrypt(store.mpesa_passkey_enc, ENC_KEY); // shortcode+passkey are always the shop's own — this is what routes money to THEM
    if (!consumerKey || !consumerSecret) {
      return res.status(500).json({ error: 'No Daraja app credentials available for this payment (neither the shop nor the platform has any configured).' });
    }
    const base = daraja(store.mpesa_env);

    // 4. Get an OAuth token from Safaricom
    const authRes = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64') }
    });
    if (!authRes.ok) throw new Error('Could not authenticate with Safaricom — check this store\'s Daraja credentials.');
    const { access_token } = await authRes.json();

    // 5. Send the actual STK Push request
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${store.mpesa_shortcode}${passkey}${timestamp}`).toString('base64');
    const cleanPhone = phone.replace(/^0/, '254').replace(/^\+/, '');

    const stkRes = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: store.mpesa_shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: cleanPhone,
        PartyB: store.mpesa_shortcode,
        PhoneNumber: cleanPhone,
        CallBackURL: CALLBACK_URL,
        AccountReference: order_id,
        TransactionDesc: `Order ${order_id}`
      })
    });
    const stkData = await stkRes.json();
    if (stkData.ResponseCode !== '0') {
      return res.status(400).json({ error: stkData.errorMessage || stkData.ResponseDescription || 'Could not start payment.' });
    }

    // 6. Create a payment attempt record — this is what the callback will match against
    await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
      method: 'POST',
      headers: { ...sHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        order_id,
        checkout_request_id: stkData.CheckoutRequestID,
        merchant_request_id: stkData.MerchantRequestID,
        status: 'pending',
        amount_paid: amount
      })
    });

    return res.status(200).json({ success: true, checkoutRequestId: stkData.CheckoutRequestID });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
