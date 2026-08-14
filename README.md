# Gatekeep — automated event check-in

One app, four jobs:
1. **Register students** (one at a time or pasted in bulk) → generates a unique one-time QR pass for each.
2. **Emails the pass automatically** to the student's inbox.
3. **Scans passes at the gate** — camera-based QR scan, marks each pass used exactly once, "Already Scanned" on a repeat, with a short buzz/vibration and a pause-then-resume flow so staff can see each result clearly.
4. **Runs multiple events** — create a new event anytime from the header; each one has its own isolated roster, stats, and check-in data, and older events stay exactly as they were. Switch between them from the dropdown at any time.

There's also an **Integrations tab** in the app itself with the exact endpoint, headers, and JSON body needed to connect a Microsoft Forms registration form via Power Automate, so registration can be fully automatic.

---

## 1. Requirements

- Node.js 18+ installed
- A college Office365/Outlook mailbox you're allowed to send from (e.g. `events@college.edu`)
- 10 minutes to set up

## 2. Install

```bash
cd checkin-server
npm install
cp .env.example .env
```

Edit `.env`:

```
PORT=3000
JWT_SECRET=some-very-long-random-string
ADMIN_USERNAME=admin
ADMIN_PASSWORD=a-strong-password-you-will-change-later
SMTP_USER=events@college.edu
SMTP_PASS=your-app-password
SMTP_FROM_NAME=College Event Team
EVENT_NAME=Your Event Name
```

`JWT_SECRET` signs everyone's login session — generate a real random one with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
`ADMIN_USERNAME`/`ADMIN_PASSWORD` create exactly one admin account, the first time the server ever starts against an empty database. After that first run, log in with those credentials and create proper named accounts for everyone else from the **Team** tab — you can even change or stop using this bootstrap account's password afterward, since real accounts now live in the database, not in `.env`.

## 3. The Office365 SMTP part (read this — it's the step people get stuck on)

Microsoft disabled **SMTP AUTH (basic authentication)** tenant-wide by default a few years ago as a security measure. If `SMTP_USER`/`SMTP_PASS` login fails with an authentication error, it's almost always this. To fix it, whoever administers your college's Microsoft 365 (usually IT/the O365 admin) needs to:

1. Go to the **Exchange admin center** → Mail flow / Mail Users → find the sending mailbox → enable **"Authenticated SMTP"** for that specific mailbox (this can be done per-mailbox without exposing the whole tenant).
2. If the account has Multi-Factor Authentication on, you can't use its normal password over SMTP — you need an **App Password**, which requires MFA App Passwords to be enabled for that account (this is a per-user legacy MFA setting, not "Security Defaults").
3. Alternatively, ask IT if there's a **shared mailbox** meant for this kind of automated sending — those are usually easier to get SMTP AUTH enabled on than a personal staff mailbox.

If your IT department won't enable SMTP AUTH at all (increasingly common), the modern replacement is the **Microsoft Graph API** with OAuth2 app registration — a different, slightly more involved setup. Let me know if you hit this wall and I'll build that version instead; it's a swap of `mailer.js` only, nothing else changes.

## 4. Run it

```bash
npm start
```

Visit `http://localhost:3000` (or your server's address) and log in with the `ADMIN_USERNAME`/`ADMIN_PASSWORD` you set. From the **Team** tab, create named accounts for everyone else — pick **Admin** for people who should manage registrations/roster/events, or **Scanner** for people who should only be able to open the Gate Scanner tab and nothing else.

For real event day use, you'll want this running somewhere reachable by your scanning staff's phones, not just your laptop:
- Easiest: deploy to a free tier on **Render** or **Railway** (both support Node + a persistent disk for the SQLite file).
- Or run it on any always-on college server/VM you have access to.
- Or just run it on a laptop connected to the same venue WiFi as the scanning phones, using the laptop's local IP.

## 5. Using it

**Header** — the dropdown next to the logo switches between events. "+ New event" starts a completely fresh, empty roster without touching any existing event's data.

**Register tab** — rename the current event, add one student, or paste bulk rows as `name, id, email`. Each row instantly gets a unique pass and an emailed QR code, scoped to whichever event is currently selected.

**Gate Scanner tab** — tap "Start camera," point it at a student's QR. Green = verified (short vibration), red = already used (double-buzz), gray = invalid code. Scanning pauses briefly after each result so staff can actually read it, then auto-resumes — or tap "Scan next now" to resume immediately. The check itself is a single database transaction, so it's safe even with multiple staff scanning at multiple gates simultaneously.

**Roster tab** — live list of everyone registered in the current event, check-in status, whether their email sent, CSV export, and a "Resend" button per row. "Clear this event's data" only wipes the currently selected event — other events are untouched.

**Integrations tab** — everything needed to wire up Microsoft Forms → automatic registration via Power Automate: the exact endpoint URL, required headers (including which event new registrations should land in), and the JSON body shape. See section 6 below for the full walkthrough.

## 6. Connecting it to your Microsoft Forms registration

This app doesn't watch your Forms responses automatically (that would need a Power Automate flow calling this app's API). Two ways to bridge that:

- **Manual bridge (simplest):** export Forms responses periodically and paste them into the Bulk import box.
- **Automatic bridge:** open the **Integrations tab** in the app (as an admin) — it shows the exact endpoint URL, the `Authorization` header (your login session token), the `x-event-id` header for whichever event should receive new registrants, and the JSON body shape, ready to paste into a Power Automate HTTP action. `POWER_AUTOMATE.md` in this folder has the full step-by-step.
- Since a login session expires after 12 hours, a flow meant to run for a long time (a multi-day registration window) works best with its own dedicated admin account — create one from the Team tab just for this purpose, and refresh its token in the flow if it ever expires.

## 7. Team access and roles

Every person gets their own named account instead of one shared password:

- **Admin** — full access: register students, manage the roster, create/rename events, view Integrations, and manage other team accounts from the **Team** tab.
- **Scanner** — can only open the Gate Scanner tab. No roster, no student data, no event settings, nothing else is reachable even by guessing a URL — the server checks the account's role on every request, not just what the page shows.

Create accounts from the Team tab (admin only). The very first admin account is created automatically from `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env`, the first time the server starts with an empty database — after that, those two env values are no longer used for anything.

Removing a team member's account immediately ends their ability to log in (existing sessions expire naturally within 12 hours; there's currently no instant force-logout of an active session, only account removal preventing a *new* login).

## 8. Security notes

- Passwords are hashed (bcrypt) before being stored — nobody, including you looking at the database file, can see anyone's actual password.
- Login sessions are signed tokens (JWT) that expire automatically after 12 hours — long enough for an event day, short enough that a token left on a shared/borrowed device doesn't stay valid indefinitely.
- `JWT_SECRET` is what makes those sessions trustworthy — if it ever leaks, someone could forge a valid login without knowing anyone's password. Treat it like your most sensitive credential; regenerate it (and everyone logs out) if you ever suspect it's been exposed.
- Role checks happen on the server for every request, not just by hiding buttons in the browser — a scanner account genuinely cannot reach registration/roster/export endpoints even by calling the API directly.
- QR codes only encode a random pass code, never personal data, so a leaked/photographed QR can't expose a student's info on its own.
- The SQLite database file (`gatekeep.db`) contains names, IDs, emails, and password hashes — treat it like any other sensitive data file (don't commit it to a public repo, delete it after the event if required by your college's data policy).
