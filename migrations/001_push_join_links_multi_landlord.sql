-- Phone notifications, per-property join links, and tenants with more than one landlord.

-- Web Push: one row per phone/computer that turned notifications on (app.py push_*).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  endpoint VARCHAR(500) NOT NULL,
  p256dh_key VARCHAR(255) NOT NULL,
  auth_key VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_endpoint (endpoint),
  KEY idx_push_user (user_id),
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Failed sign-ins, for slowing down password guessing (app.py login).
CREATE TABLE IF NOT EXISTS login_failures (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_lf_email_time (email, created_at),
  KEY idx_lf_ip_time (ip_address, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Open-term contracts have no end date (the app already sends NULL for them).
ALTER TABLE contracts MODIFY end_date DATE NULL;

-- A tenant may rent from several landlords / units at once. One active contract per
-- unit is still enforced by trg_prevent_double_active_contract.
DROP TRIGGER IF EXISTS trg_prevent_double_tenant_contract;

-- The app sends these notifications itself (with phone push); the triggers made duplicates.
DROP TRIGGER IF EXISTS trg_notify_tenant_new_bill;
DROP TRIGGER IF EXISTS trg_notify_landlord_payment;

-- Per-property join code (P + 7 chars), alongside the landlord's own L code.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS join_code CHAR(8) NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_property_join_code ON properties (join_code);

-- Which property a tenant asked to join (via a property link), shown to the landlord.
ALTER TABLE tenant_landlords ADD COLUMN IF NOT EXISTS property_id INT UNSIGNED NULL;
