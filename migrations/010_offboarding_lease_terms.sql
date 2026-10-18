-- Move-out (off-boarding) checklist, deposit return details, 30-day notice, and each unit's
-- usual lease term.

-- Each unit's usual lease: NULL = open contract (no end date), otherwise a number of months.
ALTER TABLE units ADD COLUMN IF NOT EXISTS lease_term_months SMALLINT UNSIGNED NULL;

-- The landlord's checklists are now two lists: move-in (as before) and move-out.
ALTER TABLE onboarding_requirements ADD COLUMN IF NOT EXISTS phase ENUM('move_in','move_out') NOT NULL DEFAULT 'move_in';

-- Move-out checklist progress, per contract (a tenant can move out of one unit and keep another).
CREATE TABLE IF NOT EXISTS contract_offboarding (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  contract_id INT UNSIGNED NOT NULL,
  requirement_id INT UNSIGNED NOT NULL,
  done TINYINT(1) NOT NULL DEFAULT 0,
  note VARCHAR(500) DEFAULT NULL,
  file_url VARCHAR(255) DEFAULT NULL,
  done_at DATETIME DEFAULT NULL,
  done_by INT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_req (contract_id, requirement_id),
  KEY idx_offb_file (file_url),
  CONSTRAINT fk_offb_contract FOREIGN KEY (contract_id) REFERENCES contracts (id) ON DELETE CASCADE,
  CONSTRAINT fk_offb_req FOREIGN KEY (requirement_id) REFERENCES onboarding_requirements (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- When the tenant's written 30-day notice was received
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS notice_given_at DATE NULL;

-- Deposit return: how much went back, when, how, and the signed acknowledgement
ALTER TABLE move_out_checklists ADD COLUMN IF NOT EXISTS refund_amount DECIMAL(10,2) NULL;
ALTER TABLE move_out_checklists ADD COLUMN IF NOT EXISTS refunded_at DATE NULL;
ALTER TABLE move_out_checklists ADD COLUMN IF NOT EXISTS refund_method VARCHAR(30) NULL;
ALTER TABLE move_out_checklists ADD COLUMN IF NOT EXISTS ack_url VARCHAR(255) NULL;
