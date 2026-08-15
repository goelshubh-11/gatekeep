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

  // Generate QR matrix
  const qr = QRCode.create(token, {
    errorCorrectionLevel: 'M'
  });

  const modules = qr.modules;
  const size = modules.size;
  const data = modules.data;

  // Build QR as an HTML table.
  // This avoids image/data-URI blocking by email clients.
  let qrRows = '';

  for (let row = 0; row < size; row++) {
    qrRows += '<tr>';

    for (let col = 0; col < size; col++) {
      const index = row * size + col;
      const isDark = data[index];

      qrRows += `
        <td style="
          width:5px;
          height:5px;
          padding:0;
          margin:0;
          background-color:${isDark ? '#000000' : '#FFFFFF'};
          font-size:0;
          line-height:0;
        ">&nbsp;</td>
      `;
    }

    qrRows += '</tr>';
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="
      margin:0;
      padding:0;
      background:#0E1327;
      font-family:Arial,Helvetica,sans-serif;
    ">

      <div style="
        padding:32px 16px;
        background:#0E1327;
      ">

        <table
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
        >
          <tr>
            <td align="center">

              <table
                width="420"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="
                  max-width:420px;
                  width:100%;
                  background:#EDEDF4;
                  border-radius:16px;
                  overflow:hidden;
                "
              >

                <!-- Gold top border -->
                <tr>
                  <td style="
                    height:8px;
                    background:#E8A33D;
                    font-size:0;
                    line-height:0;
                  ">
                    &nbsp;
                  </td>
                </tr>

                <!-- Header -->
                <tr>
                  <td style="padding:24px 24px 8px;">

                    <div style="
                      font-size:10px;
                      text-transform:uppercase;
                      color:#6b6f85;
                      font-weight:bold;
                      letter-spacing:1px;
                    ">
                      ${escapeHtml(eventName)}
                    </div>

                    <div style="
                      font-size:22px;
                      font-weight:bold;
                      color:#0E1329;
                      margin-top:6px;
                    ">
                      ${escapeHtml(name)}
                    </div>

                    <div style="
                      font-family:monospace;
                      font-size:12px;
                      color:#54586b;
                      margin-top:4px;
                    ">
                      ${escapeHtml(studentId || '')}
                    </div>

                  </td>
                </tr>

                <!-- QR -->
                <tr>
                  <td align="center" style="padding:20px 10px;">

                    <table
                      cellpadding="0"
                      cellspacing="0"
                      border="0"
                      style="
                        background:#FFFFFF;
                        border:10px solid #FFFFFF;
                      "
                    >
                      ${qrRows}
                    </table>

                  </td>
                </tr>

                <!-- Pass code -->
                <tr>
                  <td align="center" style="
                    padding:4px 24px 8px;
                  ">

                    <div style="
                      font-family:monospace;
                      font-size:11px;
                      color:#8b8fa3;
                      word-break:break-all;
                    ">
                      ${escapeHtml(token)}
                    </div>

                  </td>
                </tr>

                <!-- Instructions -->
                <tr>
                  <td align="center" style="
                    padding:8px 24px 28px;
                  ">

                    <div style="
                      font-size:13px;
                      line-height:20px;
                      color:#54586b;
                    ">
                      Show this QR code at the entry gate.
                      <br>
                      Valid for one scan only.
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

        htmlContent: html,

        textContent:
          `Your Gatekeep entry pass for ${eventName}.\n\n` +
          `Name: ${name}\n` +
          `ID: ${studentId || ''}\n` +
          `Pass Code: ${token}\n\n` +
          `Please use the QR code shown in the HTML email.`
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
