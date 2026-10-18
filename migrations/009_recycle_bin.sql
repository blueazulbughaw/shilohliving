-- Deleting accounts and properties moves them to the admin's Recycle Bin (restorable); nothing
-- about them is erased, so landlords keep their bookkeeping and mistakes can be undone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by INT UNSIGNED NULL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS deleted_by INT UNSIGNED NULL;
