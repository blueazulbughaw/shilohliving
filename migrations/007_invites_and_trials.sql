-- Invite-only landlord sign-up, a free trial for new landlords, and a paid-until date.

-- One-time invite codes the admin hands out (I + 7 chars). email, when set, is the only
-- address that may use it. free_forever = no trial clock (family, friends, early testers).
CREATE TABLE IF NOT EXISTS invites (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(16) NOT NULL,
  email VARCHAR(255) NULL,
  note VARCHAR(255) NULL,
  free_forever TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NULL,
  used_by INT NULL,
  used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invite_code (code)
);

-- A landlord can make changes while: billing_exempt = 1, or before trial_ends_at, or up to paid_until
ALTER TABLE landlord_profiles ADD COLUMN IF NOT EXISTS trial_ends_at DATETIME NULL;
ALTER TABLE landlord_profiles ADD COLUMN IF NOT EXISTS paid_until DATE NULL;
ALTER TABLE landlord_profiles ADD COLUMN IF NOT EXISTS billing_exempt TINYINT(1) NOT NULL DEFAULT 0;

-- Landlords who signed up before trials existed keep full access (the admin can change this)
UPDATE landlord_profiles SET billing_exempt = 1 WHERE trial_ends_at IS NULL AND paid_until IS NULL;
