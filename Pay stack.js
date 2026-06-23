// providers/paystack.js
// ---------------------------------------------------------------------------
// Paystack (Kenya): hosted checkout that accepts M-Pesa + card.
// We initialize a transaction, redirect the buyer to Paystack, then verify.
// Money settles to the account set in your Paystack dashboard (not in code).
// ---------------------------------------------------------------------------
const axios = require('axios');
const crypto = require('crypto');

const BASE = 'https://api.paystack.co';
const key = () => process.env.PAYSTACK_SECRET_KEY;

async function init({ amount, email, reference, callbackUrl, name, phone }) {
  const { data } = await axios.post(
    `${BASE}/transaction/initialize`,
    {
      email,
      amount: Math.round(amount * 100), // KES -> cents
      currency: 'KES',
      reference,
      callback_url: callbackUrl,
      channels: ['mobile_money', 'card'], // M-Pesa shows under mobile_money
      metadata: { name, phone }
    },
    { headers: { Authorization: `Bearer ${key()}` } }
  );
  return { checkoutUrl: data.data.authorization_url, reference: data.data.reference };
}

async function verify(reference) {
  const { data } = await axios.get(
    `${BASE}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${key()}` } }
  );
  const d = data.data || {};
  return {
    success: d.status === 'success',
    amount: (d.amount || 0) / 100, // back to KES
    currency: d.currency,
    receipt: d.reference,
    raw: d
  };
}

// Paystack signs webhooks with HMAC-SHA512 of the raw body using your secret key.
function verifyWebhook(rawBody, signature) {
  if (!signature || !rawBody) return false;
  const hash = crypto.createHmac('sha512', key()).update(rawBody).digest('hex');
  return hash === signature;
}

function refFromWebhook(body) {
  return body?.data?.reference || null;
}

module.exports = { init, verify, verifyWebhook, refFromWebhook };
