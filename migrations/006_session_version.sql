-- Changing or resetting a password (or "Sign out other devices") bumps this number; sign-ins
-- made before that stop working (app.py make_token / require_auth).
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INT UNSIGNED NOT NULL DEFAULT 0;

-- Reset links are now stored hashed; links sent before this are dropped (they last 1 hour anyway).
DELETE FROM password_resets;
