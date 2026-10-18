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
  they join with their landlord's one join code (`L…`), by typing it, opening `/join/CODE`,
  or scanning its QR (`/api/join/CODE/qr.png`). There are no per-property codes: the
  landlord assigns the unit with a contract. A tenant can join several landlords and rent
  several units (`tenant_landlords`, one row per landlord).
- **Property Setup (modules):** each property switches features on/off (`PROPERTY_FEATURES` in
  `app.py`, saved as JSON in `properties.features`; missing keys use the default). To add a
  module, add it there, then check it where it matters (`property_features(...)[key]` on the
  server, `hasFeature(prop, key)` in the UI). The app is meant to grow into a CRM this way.
- **Past tenants:** completing a move-out with no other unit at that landlord sets
  `tenant_landlords.is_active=0` (+ `left_at`). Their contracts/bills/payments/threads stay as
  records; messaging, contracts and announcements require an active link (`still_linked`).
  Rejoining with the code reactivates them.
- **PDFs** (`pdfs.py`, fpdf2, fonts in `pdf_fonts/` for the ₱ sign): bill statements and
  receipts. Approving a payment numbers the receipt (`AR-000123`), pushes/emails it with the PDF
  and sets `receipt_sent_at`. Receipts say "Acknowledgement Receipt", not a BIR official receipt.
  PDFs open via `/api/docs/link` → a 10-minute link for that one path (`require_doc_auth`), since
  a new tab can't send the sign-in header; those tokens are rejected as sign-ins.
- **Back button:** screens are opened with `goPage(id)` or `showView(page, render)` (for views
  inside a page), which add a browser history entry — so the topbar ‹ Back and the phone's back
  gesture work. Pop-ups are history entries too (back closes them).
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
- **Uploads** (payment proofs, signed contracts, repair receipts) go to our server, not a
  public host: `POST /api/files` (signed in, right role per kind, type checked from the file's
  bytes, 10 MB) saves into `uploads/` in the app folder (not web-served; not in git; **not in
  the DB backups** — back it up separately). Records store `/api/files/<token>`; `GET` only
  serves the uploader and the tenant/landlord of the record (`file_parties`), opened through
  `/api/docs/link`. Old Cloudinary links were moved with `tools/import_cloudinary_uploads.py`.
- **Passwords & sessions:** the sign-in token carries `users.session_version`; changing or
  resetting a password, or "Sign out other devices", bumps it so every other sign-in ends
  (`set_password`). Reset links are stored hashed, expire in 1 hour, one email per 2 minutes.
  Locally, `scripts/dev.sh` prints emails (with their links) in its window instead of sending.

## Running it locally

`scripts/dev.sh` runs the real app at http://localhost:5000 with its own database: WAMP's
MariaDB started as a private server (data in `.localdb/`, port 3310, root without password,
no Windows service), `db/schema_base.sql` (live structure before migrations, no data) + all
`migrations/`, then sample data from `scripts/seed_local.py` (accounts and passwords printed on
first run, e.g. `landlord@local.test` / `Landlord#1`). Emails are not sent. `--reset` starts
over with fresh sample data. Never point it at the live database.

## Config

All secrets and URLs come from `.env` (see `.env.example`). `APP_URL` is used for links in
emails and must stay `https://hub.shilohliving.app` in production.
