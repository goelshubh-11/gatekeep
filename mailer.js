const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE || 'false') === 'true', // true for port 465, false for 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    tls: { ciphers: 'TLSv1.2' }
  });
  return transporter;
}

async function sendPassEmail({ to, name, studentId, token, eventName }) {
  if (!to) throw new Error('No recipient email address provided');

  const qrBuffer = await QRCode.toBuffer(token, {
    width: 480,
    margin: 1,
    color: { dark: '#0E1327', light: '#EDEDF4' }
  });

  const fromName = process.env.SMTP_FROM_NAME || 'Event Team';
  const html = `
  <div style="font-family:Arial,sans-serif;background:#0E1327;padding:32px;">
    <div style="max-width:420px;margin:0 auto;background:#EDEDF4;border-radius:16px;overflow:hidden;">
      <div style="height:8px;background:repeating-linear-gradient(-45deg,#E8A33D,#E8A33D 10px,#c98529 10px,#c98529 20px);"></div>
      <div style="padding:20px 24px 4px;">
        <div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#6b6f85;font-weight:bold;">${escapeHtml(eventName)}</div>
        <div style="font-size:20px;font-weight:bold;color:#0E1327;margin-top:4px;">${escapeHtml(name)}</div>
        <div style="font-family:monospace;font-size:12px;color:#54586b;margin-top:2px;">${escapeHtml(studentId || '')}</div>
      </div>
      <div style="text-align:center;padding:16px 0 8px;">
        <img src="cid:passqr" width="220" height="220" alt="Entry QR code" style="border-radius:8px;" />
      </div>
      <div style="padding:0 24px 20px;text-align:center;">
        <div style="font-family:monospace;font-size:11px;color:#8b8fa3;">${token}</div>
        <div style="font-size:12px;color:#54586b;margin-top:10px;line-height:1.5;">
          Show this QR code at the entry gate. It is valid for one scan only —
          please don't forward or screenshot-share it.
        </div>
      </div>
    </div>
  </div>`;

  await getTransporter().sendMail({
    from: `"${fromName}" <${process.env.SMTP_USER}>`,
    to,
    subject: `Your entry pass — ${eventName}`,
    html,
    attachments: [
      { filename: 'entry-pass.png', content: qrBuffer, cid: 'passqr' },
      { filename: 'entry-pass.png', content: qrBuffer }
    ]
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

module.exports = { sendPassEmail };
