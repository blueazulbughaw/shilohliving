-- Reminders to the landlord (Settings) get a "generate water bills" type; the daily job
-- (tools/daily_jobs.py) sends them as phone notifications.
ALTER TABLE reminders
  MODIFY reminder_type ENUM('water_reading','water_bills','bill_generation','payment_collection','custom')
    NOT NULL DEFAULT 'custom';

-- Bill reminders to tenants, per property and bill type. No row = no reminders.
CREATE TABLE IF NOT EXISTS tenant_reminder_rules (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  property_id INT UNSIGNED NOT NULL,
  bill_type ENUM('rent','water','electricity','other') NOT NULL,
  days_before TINYINT UNSIGNED NULL,          -- remind N days before the due date (NULL = off)
  on_due_day TINYINT(1) NOT NULL DEFAULT 0,   -- remind on the due date
  overdue_every TINYINT UNSIGNED NULL,        -- while unpaid after the due date, every N days (NULL = off)
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rule_property_type (property_id, bill_type),
  CONSTRAINT fk_rule_property FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One reminder of each kind per bill per day, even if the job runs several times
CREATE TABLE IF NOT EXISTS bill_reminders_sent (
  bill_id INT UNSIGNED NOT NULL,
  kind ENUM('before','due','overdue') NOT NULL,
  sent_on DATE NOT NULL,
  PRIMARY KEY (bill_id, kind, sent_on),
  CONSTRAINT fk_brs_bill FOREIGN KEY (bill_id) REFERENCES bills (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
