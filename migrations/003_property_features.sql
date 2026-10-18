-- Property Setup: which features each property uses (JSON; NULL = the defaults in app.py
-- PROPERTY_FEATURES, which keep everything on as before).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS features TEXT NULL;
