# Deploying for real multi-phone / multi-staff use

This is the setup for event day: one public server, reachable from any
phone (scanners) and any dept computer (roster/admin) at the same time.
The app itself already supports this — Express handles concurrent requests
and the scan check is a single atomic database transaction, so multiple
scanners at multiple gates can't double-admit the same pass.

## Recommended: Railway (has a free trial with persistent storage)

1. **Push the code to GitHub** (from Termux, or any computer):
   ```
   cd checkin-server
   git init
   git add .
   git commit -m "gatekeep"
   ```
   Create an empty repo on github.com, then:
   ```
   git remote add origin https://github.com/YOUR_USERNAME/gatekeep.git
   git branch -M main
   git push -u origin main
   ```
   (GitHub will ask for a Personal Access Token instead of a password —
   generate one at github.com → Settings → Developer settings → Personal
   access tokens → give it "repo" scope.)

2. **Sign up at [railway.app](https://railway.app)** (can log in with GitHub).

3. **New Project → Deploy from GitHub repo** → pick your `gatekeep` repo.
   Railway detects it's a Node app automatically.

4. **Add environment variables** (Project → Variables): paste in everything
   from your `.env` — `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`,
   `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
   `SMTP_FROM_NAME`, `EVENT_NAME`. Also add:
   ```
   DB_PATH=/data/gatekeep.db
   ```

5. **Add a Volume** (Project → your service → Volumes → New Volume):
   - Mount path: `/data`
   This is what makes your roster survive restarts and redeploys.

6. **Deploy.** Railway gives you a public URL like
   `https://gatekeep-production.up.railway.app`. That's the address
   everyone uses — scanners, admin, and the Power Automate flow.

7. Open that URL on any phone/laptop and log in with `ADMIN_USERNAME`/
   `ADMIN_PASSWORD`. From the Team tab, create a named account for everyone
   else who needs access. Every device hitting that same URL shares the
   same live database.

## Alternative: Render

Same idea, but on Render's free tier the disk is **not** persistent — only
use Render if you're on a paid plan with a Disk attached (Render →
your service → Disks → mount at e.g. `/data`, and set `DB_PATH=/data/gatekeep.db`
the same way). On the free tier, treat any data as temporary/for testing only.

## Rolling this out to your team

- Create a named account for each person from the **Team** tab (admin
  role for people managing registrations/roster, scanner role for gate
  staff) — nobody shares a password, and each account can be removed
  individually if someone leaves the team or loses their phone.
- Share the deployed URL. Nothing to install — everyone just opens it in
  their phone/laptop browser and logs in with their own account.
- Everyone sees the same live roster and stats, since it's one shared server.
- Scanner accounts genuinely cannot reach the roster, registration, or
  export endpoints — that's enforced by the server on every request, not
  just hidden in the interface.
