const QRCode = require('qrcode');

async function sendPassEmail({
  to,
  name,
  studentId,
  token,
  eventName
}) {
  if (!to) {
    throw new Error('No recipient email address provided');
  }

  if (!process.env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY is not configured');
  }

  if (!process.env.BREVO_FROM_EMAIL) {
    throw new Error('BREVO_FROM_EMAIL is not configured');
  }

  const qrBuffer = await QRCode.toBuffer(token, {
    width: 480,
    margin: 1,
    color: {
      dark: '#0E1327',
      light: '#EDEDF4'
    }
  });

  const qrBase64 = qrBuffer.toString('base64');

  const html = `
    <div style="
      font-family: Arial, sans-serif;
      background: #0E1327;
      padding: 32px;
    ">

      <div style="
        max-width: 420px;
        margin: 0 auto;
        background: #EDEDF4;
        border-radius: 16px;
        overflow: hidden;
      ">

        <div style="
          height: 8px;
          background: #E8A33D;
        "></div>

        <div style="padding: 20px 24px 4px;">

          <div style="
            font-size: 10px;
            text-transform: uppercase;
            color: #6b6f85;
            font-weight: bold;
          ">
            ${escapeHtml(eventName)}
          </div>

          <div style="
            font-size: 20px;
            font-weight: bold;
            color: #0E1329;
            margin-top: 4px;
          ">
            ${escapeHtml(name)}
          </div>

          <div style="
            font-family: monospace;
            font-size: 12px;
            color: #54586b;
          ">
            ${escapeHtml(studentId || '')}
          </div>

        </div>

        <div style="
          text-align: center;
          padding: 16px 0 8px;
        ">
          <img
            src="data:image/png;base64,${qrBase64}"
            width="220"
            height="220"
            alt="Entry QR code"
          />
        </div>

        <div style="
          padding: 0 24px 20px;
          text-align: center;
        ">

          <div style="
            font-family: monospace;
            font-size: 11px;
            color: #8b8fa3;
          ">
            ${escapeHtml(token)}
          </div>

          <div style="
            font-size: 12px;
            color: #54586b;
            margin-top: 10px;
          ">
            Show this QR code at the entry gate.
            Valid for one scan only.
          </div>

        </div>

      </div>

    </div>
  `;

  const response = await fetch(
    'https://api.brevo.com/v3/smtp/email',
    {
      method: 'POST',

      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json'
      },

      body: JSON.stringify({
        sender: {
          name: 'Gatekeep',
          email: process.env.BREVO_FROM_EMAIL
        },

        to: [
          {
            email: to,
            name: name
          }
        ],

        subject: `Your entry pass — ${eventName}`,

        htmlContent: html
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    console.error('Brevo API error:', result);
    throw new Error(
      result.message || 'Brevo email sending failed'
    );
  }

  console.log('Brevo email sent:', result.messageId);

  return result;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
}

module.exports = {
  sendPassEmail
};
