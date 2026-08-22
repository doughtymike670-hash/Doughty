// /api/save-mpesa-credentials.js
// Called from the shop owner's dashboard settings. Verifies the caller is a real
// logged-in owner, encrypts their Daraja credentials, stores them server-side only.
// The encryption key and Supabase service_role key live ONLY in Vercel's
// environment variables — never in index.html, never sent to any browser.

const crypto = require('crypto');

function encrypt(text, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { consumer_key, consumer_secret, passkey, shortcode, env } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');

  if (!passkey || !shortcode) {
    return res.status(400).json({ error: 'Passkey and Shortcode are required.' });
  }
  // Consumer Key/Secret are OPTIONAL — if a shop doesn't have their own Daraja app,
  // the platform's own credentials (set in Vercel env vars) are used instead at
  // payment time. If they DO provide their own, theirs takes priority.
  if ((consumer_key && !consumer_secret) || (!consumer_key && consumer_secret)) {
    return res.status(400).json({ error: 'Provide both Consumer Key and Secret together, or leave both blank.' });
  }
  if (!token) return res.status(401).json({ error: 'Not logged in.' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ENC_KEY = process.env.ENCRYPTION_KEY;

  try {
    // 1. Verify the caller is a real logged-in user (not a forged request)
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session.' });
    const user = await userRes.json();

    // 2. Find the store this user owns
    const storeRes = await fetch(
      `${SUPABASE_URL}/rest/v1/stores?owner_auth_id=eq.${user.id}&select=id`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const stores = await storeRes.json();
    if (!stores.length) return res.status(404).json({ error: 'No store found for this account.' });
    const storeId = stores[0].id;

    // 3. Encrypt the secrets and save
    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/stores?id=eq.${storeId}`, {
      method: 'PATCH',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        mpesa_consumer_key_enc: consumer_key ? encrypt(consumer_key, ENC_KEY) : null,
        mpesa_consumer_secret_enc: consumer_secret ? encrypt(consumer_secret, ENC_KEY) : null,
        mpesa_passkey_enc: encrypt(passkey, ENC_KEY),
        mpesa_shortcode: shortcode,
        mpesa_env: env === 'production' ? 'production' : 'sandbox',
        mpesa_enabled: true
      })
    });
    if (!patchRes.ok) throw new Error(await patchRes.text());

    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: 'Could not save credentials: ' + e.message });
  }
};
