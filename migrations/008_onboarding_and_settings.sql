-- Move-in checklist (requirements the landlord asks every new tenant for), and landlord settings.

-- The landlord's list. kind: document = tenant uploads a file, info = tenant types an answer,
-- landlord = the landlord ticks it off (lease signed, keys handed over...), optionally with a photo.
CREATE TABLE IF NOT EXISTS onboarding_requirements (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  landlord_id INT UNSIGNED NOT NULL,
  label VARCHAR(255) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  kind ENUM('document','info','landlord') NOT NULL DEFAULT 'document',
  required TINYINT(1) NOT NULL DEFAULT 1,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_req_landlord (landlord_id, is_active, sort_order),
  CONSTRAINT fk_req_landlord FOREIGN KEY (landlord_id) REFERENCES landlord_profiles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each tenant's progress on each requirement
CREATE TABLE IF NOT EXISTS tenant_requirements (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  requirement_id INT UNSIGNED NOT NULL,
  status ENUM('pending','submitted','approved','rejected','waived') NOT NULL DEFAULT 'pending',
  answer TEXT DEFAULT NULL,
  file_url VARCHAR(255) DEFAULT NULL,
  note VARCHAR(500) DEFAULT NULL,
  submitted_at DATETIME DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  reviewed_by INT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tenant_req (tenant_id, requirement_id),
  KEY idx_treq_file (file_url),
  CONSTRAINT fk_treq_tenant FOREIGN KEY (tenant_id) REFERENCES tenant_profiles (id) ON DELETE CASCADE,
  CONSTRAINT fk_treq_req FOREIGN KEY (requirement_id) REFERENCES onboarding_requirements (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Day of the month rent is due (used by Generate Bills → Monthly Rent)
ALTER TABLE landlord_profiles ADD COLUMN IF NOT EXISTS rent_due_day TINYINT UNSIGNED NOT NULL DEFAULT 7;
