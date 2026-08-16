const QRCode = require('qrcode');

// Shared by the email (attachment) and the public /api/qr/:token route (the
// inline <img> in the email points at that route instead of embedding the
// image data directly - see sendPassEmail below for why).
async function generateQrPngBuffer(token) {
  return QRCode.toBuffer(token, {
    width: 480,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' }
  });
}

async function sendPassEmail({ to, name, studentId, token, eventName, baseUrl }) {
  if (!to) {
    throw new Error('No recipient email address provided');
  }
  if (!process.env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY is not configured');
  }
  if (!process.env.BREVO_FROM_EMAIL) {
    throw new Error('BREVO_FROM_EMAIL is not configured');
  }

  // Real PNG, not an HTML table - this is what makes it reliably scannable.
  const qrBuffer = await generateQrPngBuffer(token);
  const qrBase64 = qrBuffer.toString('base64');
  const attachmentName = 'entry-pass.png';
  // Inline image: a real hosted URL, not a cid: reference (Brevo's API
  // doesn't support those) and not a base64 data: URI either - most mail
  // clients (Gmail, Outlook, corporate filters) strip or refuse to render
  // embedded base64 images, so it silently showed nothing even though the
  // HTML was technically valid. A normal https:// image URL is the one
  // format every mail client actually knows how to load, same as any
  // ordinary "load images" prompt they already show every day. The PNG
  // attachment stays too, as an offline fallback if images are blocked.
  const qrImageUrl = baseUrl ? `${baseUrl}/api/qr/${encodeURIComponent(token)}` : null;

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;background:#0E1327;font-family:Arial,Helvetica,sans-serif;">
      <div style="padding:32px 16px;background:#0E1327;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center">
              <table width="420" cellpadding="0" cellspacing="0" border="0" style="max-width:420px;width:100%;background:#EDEDF4;border-radius:16px;overflow:hidden;">
                <tr>
                  <td style="height:8px;background:#E8A33D;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
                <tr>
                  <td style="padding:24px 24px 8px;">
                    <div style="font-size:10px;text-transform:uppercase;color:#6b6f85;font-weight:bold;letter-spacing:1px;">${escapeHtml(eventName)}</div>
                    <div style="font-size:22px;font-weight:bold;color:#0E1329;margin-top:6px;">${escapeHtml(name)}</div>
                    <div style="font-family:monospace;font-size:12px;color:#54586b;margin-top:4px;">${escapeHtml(studentId || '')}</div>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:20px 10px;">
                    <img src="${qrImageUrl || `data:image/png;base64,${qrBase64}`}" width="260" height="260" alt="Entry QR code" style="display:block;border:10px solid #FFFFFF;background:#FFFFFF;" />
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:4px 24px 8px;">
                    <div style="font-family:monospace;font-size:11px;color:#8b8fa3;word-break:break-all;">${escapeHtml(token)}</div>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:8px 24px 28px;">
                    <div style="font-size:13px;line-height:20px;color:#54586b;">
                      Show this QR code at the entry gate. Valid for one scan only.<br>
                      If the image above doesn't display, open the attached <strong>entry-pass.png</strong> file instead.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>
    </body>
    </html>
  `;

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Gatekeep', email: process.env.BREVO_FROM_EMAIL },
      to: [{ email: to, name: name }],
      subject: `Your entry pass — ${eventName}`,
      htmlContent: html,
      textContent:
        `Your Gatekeep entry pass for ${eventName}.\n\n` +
        `Name: ${name}\nID: ${studentId || ''}\nPass Code: ${token}\n\n` +
        `Open the attached entry-pass.png and show it at the gate.`,
      attachment: [
        { content: qrBase64, name: attachmentName }
      ]
    })
  });

  const result = await response.json();
  if (!response.ok) {
    console.error('Brevo API error:', result);
    throw new Error(result.message || 'Brevo email sending failed');
  }
  console.log('Brevo email sent:', result.messageId);
  return result;
}

async function sendOtpEmail({ to, name, otp }) {
  if (!to) throw new Error('No recipient email address provided');
  if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY is not configured');
  if (!process.env.BREVO_FROM_EMAIL) throw new Error('BREVO_FROM_EMAIL is not configured');

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;background:#0E1327;font-family:Arial,Helvetica,sans-serif;">
      <div style="padding:32px 16px;background:#0E1327;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center">
            <table width="380" cellpadding="0" cellspacing="0" border="0" style="max-width:380px;width:100%;background:#EDEDF4;border-radius:16px;overflow:hidden;">
              <tr><td style="height:8px;background:#5FD9C4;font-size:0;line-height:0;">&nbsp;</td></tr>
              <tr><td style="padding:28px 28px 6px;">
                <div style="font-size:10px;text-transform:uppercase;color:#6b6f85;font-weight:bold;letter-spacing:1px;">GATEKEEP ACCOUNT VERIFICATION</div>
                <div style="font-size:18px;font-weight:bold;color:#0E1329;margin-top:6px;">Hi ${escapeHtml(name)},</div>
              </td></tr>
              <tr><td style="padding:10px 28px 6px;">
                <div style="font-size:13px;color:#54586b;line-height:20px;">Use this code to verify your email and finish creating your account:</div>
              </td></tr>
              <tr><td align="center" style="padding:18px 28px;">
                <div style="font-family:monospace;font-size:34px;font-weight:bold;letter-spacing:8px;color:#0E1329;background:#FFFFFF;border-radius:10px;padding:14px 10px;">${escapeHtml(otp)}</div>
              </td></tr>
              <tr><td style="padding:0 28px 28px;">
                <div style="font-size:12px;color:#8b8fa3;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</div>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </div>
    </body>
    </html>`;

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Gatekeep', email: process.env.BREVO_FROM_EMAIL },
      to: [{ email: to, name: name }],
      subject: `Your Gatekeep verification code: ${otp}`,
      htmlContent: html,
      textContent: `Hi ${name},\n\nYour Gatekeep verification code is: ${otp}\n\nThis code expires in 10 minutes.`
    })
  });

  const result = await response.json();
  if (!response.ok) {
    console.error('Brevo API error (OTP):', result);
    throw new Error(result.message || 'Brevo email sending failed');
  }
  return result;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

module.exports = { sendPassEmail, sendOtpEmail, generateQrPngBuffer };
