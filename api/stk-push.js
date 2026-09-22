// /api/stk-push.js
// Starts a Daraja STK Push only for the caller's own checkout order.
const crypto = require('crypto');

function decrypt(b64, keyHex) {
  if (!b64 || !/^[0-9a-f]{64}$/i.test(keyHex || '')) throw new Error('Payment encryption is not configured correctly.');
  const key = Buffer.from(keyHex, 'hex');
  const data = Buffer.from(b64, 'base64');
  if (data.length < 29) throw new Error('Invalid encrypted payment credentials.');
  const iv = data.subarray(0, 12); const tag = data.subarray(12, 28); const enc = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
function daraja(env) { return env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke'; }
function normalizePhone(value) {
  let p=String(value||'').replace(/[^0-9+]/g,'').replace(/^\+/,'');
  if(p.startsWith('0')) p='254'+p.slice(1);
  return p;
}
async function releaseOrder(url, key, orderId) {
  await fetch(url + '/rest/v1/rpc/release_order_stock', { method:'POST', headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'}, body:JSON.stringify({p_order_id:orderId}) });
}
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  const {order_id, username, phone} = req.body || {};
  if (typeof order_id !== 'string' || typeof username !== 'string' || typeof phone !== 'string' || !order_id || !username || !phone) return res.status(400).json({error:'Missing required fields.'});
  const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY, ENC_KEY=process.env.ENCRYPTION_KEY, CALLBACK_URL=process.env.MPESA_CALLBACK_URL;
  if(!SUPABASE_URL || !SERVICE_KEY || !ENC_KEY || !CALLBACK_URL) return res.status(500).json({error:'M-Pesa server configuration is incomplete.'});
  const sHeaders={apikey:SERVICE_KEY,Authorization:'Bearer '+SERVICE_KEY};
  let paymentAccepted=false;
  try {
    const storeRes=await fetch(SUPABASE_URL+'/rest/v1/stores?username=eq.'+encodeURIComponent(username)+'&status=eq.active&select=id,mpesa_enabled,mpesa_consumer_key_enc,mpesa_consumer_secret_enc,mpesa_passkey_enc,mpesa_shortcode,mpesa_env');
    if(!storeRes.ok) throw new Error('Could not load store payment settings.');
    const stores=await storeRes.json(); const store=stores[0];
    if(!store || !store.mpesa_enabled) { await releaseOrder(SUPABASE_URL,SERVICE_KEY,order_id); return res.status(400).json({error:'This store has not set up M-Pesa payments.'}); }
    const orderRes=await fetch(SUPABASE_URL+'/rest/v1/orders?id=eq.'+encodeURIComponent(order_id)+'&store_id=eq.'+encodeURIComponent(store.id)+'&select=id,store_id,phone,total,status', {headers:sHeaders});
    const orders=await orderRes.json(); const order=orders[0];
    if(!order) return res.status(404).json({error:'Order not found.'});
    if(normalizePhone(order.phone)!==normalizePhone(phone)) return res.status(403).json({error:'The payment phone must match the checkout phone.'});
    if(order.status==='paid' || order.status==='cancelled') return res.status(400).json({error:'This order is no longer payable.'});
    const existingRes=await fetch(SUPABASE_URL+'/rest/v1/payments?order_id=eq.'+encodeURIComponent(order_id)+'&status=in.(pending,completed)&select=id,status', {headers:sHeaders});
    const existing=await existingRes.json();
    if(existing.some(p=>p.status==='completed')) return res.status(400).json({error:'This order is already paid.'});
    if(existing.some(p=>p.status==='pending')) return res.status(409).json({error:'A payment prompt is already in progress for this order.'});
    if(!store.mpesa_passkey_enc || !store.mpesa_shortcode) { await releaseOrder(SUPABASE_URL,SERVICE_KEY,order_id); return res.status(500).json({error:'This store has incomplete M-Pesa settings.'}); }
    const consumerKey=store.mpesa_consumer_key_enc?decrypt(store.mpesa_consumer_key_enc,ENC_KEY):process.env.DARAJA_CONSUMER_KEY;
    const consumerSecret=store.mpesa_consumer_secret_enc?decrypt(store.mpesa_consumer_secret_enc,ENC_KEY):process.env.DARAJA_CONSUMER_SECRET;
    const passkey=decrypt(store.mpesa_passkey_enc,ENC_KEY);
    if(!consumerKey || !consumerSecret) { await releaseOrder(SUPABASE_URL,SERVICE_KEY,order_id); return res.status(500).json({error:'No Daraja app credentials are configured.'}); }
    const cleanPhone=normalizePhone(phone); if(!/^254[0-9]{9}$/.test(cleanPhone)) { await releaseOrder(SUPABASE_URL,SERVICE_KEY,order_id); return res.status(400).json({error:'Enter a valid Kenyan phone number.'}); }
    const amount=Math.round(Number(order.total)); if(!Number.isFinite(amount)||amount<1) throw new Error('Invalid order amount.');
    const base=daraja(store.mpesa_env);
    const authRes=await fetch(base+'/oauth/v1/generate?grant_type=client_credentials',{headers:{Authorization:'Basic '+Buffer.from(consumerKey+':'+consumerSecret).toString('base64')}});
    if(!authRes.ok) throw new Error('Could not authenticate with Safaricom — check this store's Daraja credentials.');
    const auth=await authRes.json(); const timestamp=new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
    const password=Buffer.from(store.mpesa_shortcode+passkey+timestamp).toString('base64');
    const stkRes=await fetch(base+'/mpesa/stkpush/v1/processrequest',{method:'POST',headers:{Authorization:'Bearer '+auth.access_token,'Content-Type':'application/json'},body:JSON.stringify({BusinessShortCode:store.mpesa_shortcode,Password:password,Timestamp:timestamp,TransactionType:'CustomerPayBillOnline',Amount:amount,PartyA:cleanPhone,PartyB:store.mpesa_shortcode,PhoneNumber:cleanPhone,CallBackURL:CALLBACK_URL,AccountReference:makeMpesaReference(order_id),TransactionDesc:'Doughty order'})});
    const stkData=await stkRes.json();
    if(stkData.ResponseCode!=='0') { await releaseOrder(SUPABASE_URL,SERVICE_KEY,order_id); return res.status(400).json({error:stkData.errorMessage||stkData.ResponseDescription||'Could not start payment.'}); }
    paymentAccepted=true;
    const payRes=await fetch(SUPABASE_URL+'/rest/v1/payments',{method:'POST',headers:{...sHeaders,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify({order_id,checkout_request_id:stkData.CheckoutRequestID,merchant_request_id:stkData.MerchantRequestID,status:'pending',amount_paid:amount})});
    if(!payRes.ok) return res.status(500).json({error:'The payment prompt started, but the payment record could not be saved. Please do not retry yet.'});
    return res.status(200).json({success:true,checkoutRequestId:stkData.CheckoutRequestID});
  } catch(e) {
    if(!paymentAccepted) { try { await releaseOrder(SUPABASE_URL,SERVICE_KEY,order_id); } catch(_) {} }
    return res.status(500).json({error:e.message||'Could not start payment.'});
  }
};
