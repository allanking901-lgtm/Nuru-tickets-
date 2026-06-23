// server.js
// ---------------------------------------------------------------------------
// Nuru - First Light ticketing API (Paystack + Flutterwave)
//
// Flow:
//   1. Website calls  POST /api/pay {provider,...} -> we create a checkout link
//   2. Buyer is redirected to Paystack/Flutterwave, pays with M-Pesa or card
//   3. Provider redirects back to  GET /api/return  -> we verify + issue ticket
//   4. Provider also calls our webhook (backup, in case the buyer closes the tab)
//   5. Ticket is emailed + texted automatically
//   6. At the door:  GET /api/verify/:id   POST /api/checkin/:id
// ---------------------------------------------------------------------------
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const { newTicketId, qrPng } = require('./tickets');
const { sendTicketEmail, sendTicketSms } = require('./notify');
const store = require('./store');

const providers = {
  paystack: require('./paystack'),
  flutterwave: require('./flutterwave')
};

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
// keep the raw body so we can verify Paystack webhook signatures
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ---- Event config (edit prices / capacity here) ----
const EVENT = { name: 'First Light', date: 'Sat, Aug 15 2026', city: 'Nairobi', capacity: 800 };
const TIERS = {
  early:   { name: 'Early Light',        price: 1500 },
  general: { name: 'General',            price: 2500 },
  vip:     { name: 'Inner Circle \u00b7 VIP', price: 5000 }
};

const settling = new Set(); // simple guard against double-issuing

app.get('/', (_req, res) => res.json({ ok: true, service: 'nuru-tickets' }));

app.get('/api/event', (_req, res) => {
  const sold = store.countSold();
  res.json({ ...EVENT, sold, remaining: Math.max(0, EVENT.capacity - sold), tiers: TIERS });
});

// 1) Create a payment and return the provider checkout URL
app.post('/api/pay', async (req, res) => {
  try {
    const { provider, tier, qty, name, email, phone } = req.body || {};
    const prov = providers[provider];
    const t = TIERS[tier];
    const q = Math.max(1, Math.min(10, parseInt(qty, 10) || 1));

    if (!prov) return res.status(400).json({ error: 'Unknown payment provider.' });
    if (!t) return res.status(400).json({ error: 'Unknown ticket type.' });
    if (!name || !email || !phone) return res.status(400).json({ error: 'Name, email and phone are required.' });
    if (store.countSold() + q > EVENT.capacity) return res.status(409).json({ error: 'Sold out.' });

    const amount = t.price * q;
    const reference = 'NURU-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const returnUrl = `${process.env.PUBLIC_BASE_URL}/api/return`;

    store.saveOrder(reference, {
      reference, provider, status: 'pending',
      tier, tierName: t.name, qty: q, amount,
      name, email, phone, createdAt: Date.now()
    });

    const out = await prov.init({
      amount, email, reference, name, phone,
      callbackUrl: returnUrl,  // Paystack
      redirectUrl: returnUrl   // Flutterwave
    });

    res.json({ checkoutUrl: out.checkoutUrl, reference });
  } catch (e) {
    console.error('pay error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not start payment. Try again.' });
  }
});

// Verify a payment, and (once) issue + deliver the ticket. Safe to call twice.
async function settleOrder(reference) {
  const order = store.getOrder(reference);
  if (!order) return { error: 'unknown' };
  if (order.status === 'paid') return { paid: true, ticketId: order.ticketId };
  if (settling.has(reference)) return { pending: true };
  settling.add(reference);

  try {
    const prov = providers[order.provider];
    const v = await prov.verify(reference);

    if (!v.success) { store.updateOrder(reference, { status: 'failed' }); return { paid: false }; }
    if (Math.round(v.amount) < order.amount) {
      store.updateOrder(reference, { status: 'amount_mismatch' });
      return { paid: false, error: 'amount' };
    }

    // Mark paid BEFORE notifying so a second call can't re-issue.
    const ticketId = newTicketId();
    store.updateOrder(reference, { status: 'paid', ticketId, receipt: v.receipt });

    const qr = await qrPng(`${ticketId}|${v.receipt || reference}`);
    store.saveTicket({
      id: ticketId, tier: order.tier, tierName: order.tierName, qty: order.qty,
      name: order.name, email: order.email, phone: order.phone,
      receipt: v.receipt, used: false, issuedAt: new Date().toISOString()
    });

    sendTicketEmail({
      to: order.email, name: order.name, tier: order.tierName,
      qty: order.qty, ticketId, receipt: v.receipt || reference, qrBuffer: qr
    }).catch((e) => console.error('email failed:', e.message));

    sendTicketSms({
      to: order.phone, name: order.name, ticketId,
      tier: order.tierName, qty: order.qty
    }).catch((e) => console.error('sms failed:', e.message));

    return { paid: true, ticketId };
  } catch (e) {
    console.error('settle error:', e.response?.data || e.message);
    return { error: 'verify_failed' };
  } finally {
    settling.delete(reference);
  }
}

// 2) Buyer is redirected back here after paying
app.get('/api/return', async (req, res) => {
  const reference = req.query.reference || req.query.trxref || req.query.tx_ref;
  if (!reference) return res.send(pageFail('We could not read your payment reference.'));
  const r = await settleOrder(String(reference));
  if (r.paid) return res.send(pageSuccess(r.ticketId));
  if (r.pending) return res.send(pagePending());
  return res.send(pageFail('Your payment was not completed.'));
});

// Optional: website can poll this instead of redirecting
app.get('/api/status/:reference', (req, res) => {
  const o = store.getOrder(req.params.reference);
  if (!o) return res.status(404).json({ status: 'unknown' });
  res.json({ status: o.status, ticketId: o.ticketId || null, receipt: o.receipt || null });
});

// 3) Webhooks (authoritative backup if the buyer closes the tab)
app.post('/api/webhook/paystack', async (req, res) => {
  res.sendStatus(200);
  try {
    const sig = req.headers['x-paystack-signature'];
    if (!providers.paystack.verifyWebhook(req.rawBody, sig)) return;
    const ref = providers.paystack.refFromWebhook(req.body);
    if (ref) await settleOrder(ref);
  } catch (e) { console.error('paystack webhook:', e.message); }
});

app.post('/api/webhook/flutterwave', async (req, res) => {
  res.sendStatus(200);
  try {
    const sig = req.headers['verif-hash'];
    if (!providers.flutterwave.verifyWebhook(req.rawBody, sig)) return;
    const ref = providers.flutterwave.refFromWebhook(req.body);
    if (ref) await settleOrder(ref);
  } catch (e) { console.error('flutterwave webhook:', e.message); }
});

// 4) Door check-in (optionally protected by a staff token)
function door(req, res, next) {
  const need = process.env.STAFF_TOKEN;
  if (!need) return next(); // no token configured = open
  if (req.headers['x-staff-token'] === need) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/verify/:ticketId', door, (req, res) => {
  const t = store.getTicket(req.params.ticketId);
  if (!t) return res.status(404).json({ valid: false, reason: 'Not found' });
  res.json({ valid: true, used: !!t.used, name: t.name, tier: t.tierName, qty: t.qty, receipt: t.receipt });
});

app.post('/api/checkin/:ticketId', door, (req, res) => {
  const r = store.markUsed(req.params.ticketId);
  if (!r.ticket) return res.status(404).json({ ok: false, reason: 'Not found' });
  res.json({ ok: r.ok, reason: r.reason, name: r.ticket.name, tier: r.ticket.tierName, qty: r.ticket.qty });
});

// ---- tiny branded result pages shown after the redirect ----
function shell(body) {
  const back = process.env.WEBSITE_URL || '/';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NURU</title></head>
<body style="margin:0;background:#0C0617;color:#F7EFE6;font-family:Arial,Helvetica,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;">
<div style="max-width:440px;padding:32px;">
<div style="font-size:22px;font-weight:800;color:#FFC24B;letter-spacing:1px;">&#9679; NURU</div>
<div style="font-size:11px;letter-spacing:3px;color:#B6A4C9;margin-top:4px;">LIGHT TO THE PEOPLE</div>
${body}
<a href="${back}" style="display:inline-block;margin-top:26px;color:#160B24;background:#FFC24B;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:100px;">Back to Nuru</a>
</div></body></html>`;
}
function pageSuccess(ticketId) {
  return shell(`<div style="font-size:30px;font-weight:800;margin-top:26px;">You're in. &#10022;</div>
<p style="color:#B6A4C9;line-height:1.6;margin-top:12px;">Payment confirmed. Ticket <b style="color:#FFC24B;">${ticketId}</b> has been sent to your email and phone. Show the QR at the door.</p>`);
}
function pagePending() {
  return shell(`<div style="font-size:26px;font-weight:800;margin-top:26px;">Confirming&hellip;</div>
<p style="color:#B6A4C9;line-height:1.6;margin-top:12px;">Your payment is being confirmed. Your ticket arrives by email and SMS shortly.</p>`);
}
function pageFail(msg) {
  return shell(`<div style="font-size:26px;font-weight:800;margin-top:26px;color:#FF5A6E;">Not completed</div>
<p style="color:#B6A4C9;line-height:1.6;margin-top:12px;">${msg} If money left your account, contact us with your M-Pesa code and we'll sort it.</p>`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nuru tickets API on :${PORT}`));
