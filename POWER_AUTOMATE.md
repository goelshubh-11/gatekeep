# Connecting Microsoft Forms → Gatekeep (Power Automate)

This makes registration fully automatic: a student submits your Microsoft
Form, and within seconds their QR pass is generated and emailed — no manual
step in between.

## Prerequisite

Gatekeep must be running somewhere with a public HTTPS address (Render,
Railway, or a college server). Power Automate runs in Microsoft's cloud and
cannot reach `localhost`.

## Steps

1. Go to [make.powerautomate.com](https://make.powerautomate.com) → **Create** → **Automated cloud flow**.
2. Trigger: search for **Microsoft Forms** → **When a new response is submitted**.
   Select your registration form.
3. **+ New step** → **Microsoft Forms** → **Get response details**.
   - Form Id: same form
   - Response Id: pick "Response Id" from the trigger's dynamic content
4. **+ New step** → **HTTP** (if your license doesn't show the HTTP connector,
   ask IT — most Office365 Education/A3+ plans include it; otherwise a
   "HTTP with Azure AD" or a simple webhook-relay works too).
   - Method: `POST`
   - URI: `https://YOUR-SERVER-ADDRESS/api/students`
   - Headers:
     - `Content-Type` : `application/json`
     - `Authorization` : `Bearer YOUR_LOGIN_TOKEN` (copy this from the Integrations tab in the app — log in as an admin, click "Show" next to the Authorization row)
     - `x-event-id` : the event ID shown in the Integrations tab (also copyable from there)
   - Body (use the dynamic content picker to insert the actual form fields
     in place of `name`, `id`, `email` below — click inside each quoted
     value and choose the matching question from "Get response details"):
     ```json
     {
       "name": "",
       "id": "",
       "email": ""
     }
     ```
5. Save, then submit a test response on the form to confirm:
   - The flow run succeeds (check the Power Automate run history)
   - The test email with the QR pass arrives
   - The student shows up in Gatekeep's Roster tab

## Troubleshooting

- **401 from the HTTP step** → the `Authorization` token has expired (sessions last 12 hours) or doesn't match. Log in as an admin, open the Integrations tab, and copy a fresh token in.
- **Flow succeeds but no email** → check the Roster tab; the "Email" column
  will show "Failed" with a reason (usually the Office365 SMTP AUTH issue
  described in the main README).
- **Flow can't reach the server at all** → confirm the server's URL is
  public HTTPS, not `localhost` or a private/college-VPN-only address.
