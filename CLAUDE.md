# Shiloh Living — rental management app

Flask + MySQL app for landlords and tenants (bills, payments, tickets, contracts,
water readings, messages). Single-page frontend in `templates/index.html` +
`static/js/app.js`, JSON API under `/api/*` in `app.py`.

## Where it runs

- **Live app:** https://hub.shilohliving.app — Namecheap shared hosting (cPanel, server353),
  Python 3.12 via CloudLinux "Setup Python App" / Passenger.
  - App root: `~/shilohliving_hub` (outside the web root, so source isn't downloadable)
  - Web root: `~/hub.shilohliving.app`
  - Virtualenv: `~/virtualenv/shilohliving_hub/3.12`
  - SSH: `ssh -i ~/.ssh/namecheap_ed25519 -p 21098 shilzikx@server353.web-hosting.com`
- **shilohliving.app** is a separate WordPress marketing site in `~/public_html` — not part of
  this repo. Its `.htaccess` redirects old app links (`/api/*`, `?type=reset|verify`,
  `?register=tenant`) to the hub.
- **DNS** is Namecheap BasicDNS (not cPanel's zone): `hub` is an A record to 198.187.29.138.
  New subdomains need a DNS record added at Namecheap, not just in cPanel.
- **SSL** for hub is Let's Encrypt via `~/.acme.sh` (auto-renews by cron; AutoSSL is disabled on this plan).

## Workflow — every change goes local → GitHub → live

After changing app code, always:

1. Commit the change.
2. Run `scripts/deploy.sh` — it refuses to run with uncommitted changes, pushes to GitHub,
   uploads the committed tree to the server, restarts Passenger, and runs a health check.
   - `--deps` after changing `requirements.txt`
   - `--env` after changing `.env` (secrets live only in `.env`, never committed; keep
     `.env.example` in sync with new variable names)
   - `--migrate` after adding a `migrations/NNN_*.sql` file: backs the database up to
     `~/backups` on the server, then `migrations/apply.py` runs each new file once
     (tracked in `schema_migrations`). Plain statements only — no trigger/procedure bodies.

Don't edit files directly on the server — the next deploy would overwrite them.

## How the app works (things not obvious from the code)

- **Sign-up:** anyone can register as a *landlord*. Tenants can't register on their own —
  they join through a landlord code (`L…`) or a property code (`P…`), by typing it, opening
  `/join/CODE`, or scanning its QR (`/api/join/CODE/qr.png`). A tenant can join several
  landlords/properties and rent several units (`tenant_landlords`, one row per landlord;
  `property_id` = the property they asked for).
- **Notifications:** always go through `push_notification()` in `app.py` — it saves the bell
  notification *and* sends a phone push (Web Push, VAPID keys in `.env`). Don't insert into
  `notifications` directly or from DB triggers (the old bill/payment triggers were dropped
  for that reason).
- **PWA:** `/sw.js` and `/manifest.webmanifest` are served from the site root by `app.py`
  (the files live in `static/`). Bump `CACHE` in `static/sw.js` when the shell file list changes.
- **Frontend safety:** anything from the API goes through `esc()` before `innerHTML`, and
  through `jsArg()` inside `onclick="…"` (see the top of `static/js/app.js`).
- **Look:** the styling deliberately matches the marketing site (`../shilohliving-site`,
  paper/green/lime palette, DM Sans + Manrope). Keep the two in step.
- Uploads (contracts, payment proofs) go to Cloudinary from the browser with an unsigned
  preset; the API only accepts URLs from our Cloudinary cloud (`CLOUDINARY_CLOUD`).

## Config

All secrets and URLs come from `.env` (see `.env.example`). `APP_URL` is used for links in
emails and must stay `https://hub.shilohliving.app` in production.
