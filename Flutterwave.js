// providers/flutterwave.js
// ---------------------------------------------------------------------------
// Flutterwave (Kenya): hosted checkout that accepts M-Pesa + card.
// Money settles to the account set in your Flutterwave dashboard (not in code).
// ---------------------------------------------------------------------------
const axios = require('axios');

const BASE = 'https://api.flutterwave.com/v3';
const key = () => process.env.FLW_SECRET_KEY;

async function init({ amount, email, reference, redirectUrl, name, phone }) {
  const { data } = await axios.post(
    `${BASE}/payments`,
    {
      tx_ref: reference,
      amount,
      currency: 'KES',
      redirect_url: redirectUrl,
      payment_options: 'mpesa,card',
      customer: { email, phonenumber: phone, name },
      customizations: { title: 'NURU \u00b7 First Light', description: 'Event ticket' }
    },
    { headers: { Authorization: `Bearer ${key()}` } }
  );
  return { checkoutUrl: data.data.link, reference };
}

async function verify(reference) {
  const { data } = await axios.get(
    `${BASE}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${key()}` } }
  );
  const d = data.data || {};
  return {
    success: d.status === 'successful',
    amount: d.amount,
    currency: d.currency,
    receipt: d.flw_ref || d.tx_ref,
    raw: d
  };
}

// Flutterwave sends a "verif-hash" header equal to the secret hash you configure.
function verifyWebhook(_rawBody, signature) {
  return Boolean(signature) && signature === process.env.FLW_SECRET_HASH;
}

function refFromWebhook(body) {
  return body?.data?.tx_ref || null;
}

module.exports = { init, verify, verifyWebhook, refFromWebhook };
