// tickets.js
// ---------------------------------------------------------------------------
// Ticket identity + QR code. QR is rendered to a PNG buffer (pure JS, no
// native build dependencies) so it deploys anywhere.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const QRCode = require('qrcode');

function newTicketId() {
  return 'NURU-FL-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

// The QR encodes "ticketId|receipt" so the door scanner can both identify the
// ticket and see the M-Pesa receipt it was paid with.
async function qrPng(payload) {
  return QRCode.toBuffer(payload, {
    type: 'png',
    width: 600,
    margin: 1,
    color: { dark: '#160B24', light: '#FFFFFF' }
  });
}

module.exports = { newTicketId, qrPng };
