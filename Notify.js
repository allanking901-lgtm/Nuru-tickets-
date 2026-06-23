// notify.js
// ---------------------------------------------------------------------------
// Delivers the ticket two ways:
//   - Email (branded HTML + QR image attached/embedded) via any SMTP provider
//   - SMS via Africa's Talking
// ---------------------------------------------------------------------------
const nodemailer = require('nodemailer');

let transporter = null;
function mailer() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465, // 465 = SSL, 587 = STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return transporter;
}

function ticketEmailHtml({ name, tier, qty, ticketId, receipt }) {
  return `
  <div style="margin:0;padding:0;background:#0C0617;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
      <div style="font-size:22px;font-weight:800;letter-spacing:1px;color:#FFC24B;">&#9679; NURU</div>
      <div style="font-size:12px;letter-spacing:3px;color:#B6A4C9;margin-top:4px;">LIGHT TO THE PEOPLE</div>

      <div style="margin-top:28px;border-radius:18px;overflow:hidden;border:1px solid rgba(247,239,230,0.12);">
        <div style="background:linear-gradient(100deg,#6A2C9A,#FF5A6E,#FFC24B);padding:28px 24px;color:#160B24;">
          <div style="font-size:12px;letter-spacing:2px;font-weight:700;">EDITION 001 &middot; YOU'RE IN &#10022;</div>
          <div style="font-size:34px;font-weight:800;line-height:1;margin-top:10px;">FIRST LIGHT</div>
          <div style="font-size:14px;font-weight:700;margin-top:8px;">SAT &middot; AUG 15 &middot; 2026 &middot; NAIROBI</div>
        </div>
        <div style="background:#160B24;padding:24px;color:#F7EFE6;">
          <p style="margin:0 0 16px;color:#B6A4C9;font-size:14px;">Hi ${name}, your ticket is confirmed. Show the QR below at the door.</p>
          <table style="width:100%;font-size:14px;color:#F7EFE6;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#B6A4C9;">Ticket</td><td style="text-align:right;">${tier} &times; ${qty}</td></tr>
            <tr><td style="padding:6px 0;color:#B6A4C9;">Ticket ID</td><td style="text-align:right;">${ticketId}</td></tr>
            <tr><td style="padding:6px 0;color:#B6A4C9;">M-Pesa receipt</td><td style="text-align:right;">${receipt}</td></tr>
          </table>
          <div style="text-align:center;margin-top:22px;">
            <img src="cid:qr@nuru" alt="Entry QR code" width="200" height="200"
                 style="border-radius:12px;background:#fff;padding:10px;" />
            <div style="font-size:12px;letter-spacing:2px;color:#B6A4C9;margin-top:10px;">SCAN AT THE DOOR</div>
          </div>
        </div>
      </div>
      <p style="color:#6f6480;font-size:12px;margin-top:20px;text-align:center;">
        Nuru &middot; built in Nairobi. Reply to this email if anything looks off.
      </p>
    </div>
  </div>`;
}

async function sendTicketEmail({ to, name, tier, qty, ticketId, receipt, qrBuffer }) {
  await mailer().sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject: 'Your NURU \u00b7 First Light ticket \u2726',
    html: ticketEmailHtml({ name, tier, qty, ticketId, receipt }),
    attachments: [{
      filename: `nuru-ticket-${ticketId}.png`,
      content: qrBuffer,
      cid: 'qr@nuru' // referenced by the <img src="cid:qr@nuru"> above
    }]
  });
}

async function sendTicketSms({ to, name, ticketId, tier, qty }) {
  if (!process.env.AT_API_KEY) return; // SMS optional
  const at = require('africastalking')({
    apiKey: process.env.AT_API_KEY,
    username: process.env.AT_USERNAME || 'sandbox'
  });
  const message =
    `NURU \u00b7 FIRST LIGHT\n` +
    `Sat Aug 15, Nairobi\n` +
    `${tier} x${qty}\n` +
    `ID: ${ticketId}\n` +
    `Check your email for the QR. Light to the people.`;

  const opts = { to: ['+' + String(to).replace(/\D/g, '')], message };
  if (process.env.AT_SENDER_ID) opts.from = process.env.AT_SENDER_ID;
  await at.SMS.send(opts);
}

module.exports = { sendTicketEmail, sendTicketSms };
