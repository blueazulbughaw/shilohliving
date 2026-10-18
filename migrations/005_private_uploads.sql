-- Uploads (payment proofs, contracts, repair receipts) are stored on our server instead of a
-- public Cloudinary link. The record (payments.proof_url, contracts.contract_doc_url,
-- move_out_checklists.repair_proof_url) holds /api/files/<token>; this table holds the file's details.
CREATE TABLE IF NOT EXISTS files (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  token VARCHAR(64) NOT NULL,
  owner_user_id INT UNSIGNED NOT NULL,
  kind VARCHAR(30) NOT NULL,
  original_name VARCHAR(255) DEFAULT NULL,
  mime VARCHAR(100) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_files_token (token),
  KEY idx_files_owner_time (owner_user_id, created_at),
  CONSTRAINT fk_files_owner FOREIGN KEY (owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
