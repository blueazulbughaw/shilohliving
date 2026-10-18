-- Receipts for approved payments, and past (moved-out) tenants kept as records.

-- AR-000123 style receipt number, and when the receipt went to the tenant
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_no VARCHAR(20) NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_sent_at DATETIME NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_receipt_no ON payments (receipt_no);

-- When a tenant became a past tenant of a landlord (tenant_landlords.is_active = 0)
ALTER TABLE tenant_landlords ADD COLUMN IF NOT EXISTS left_at DATETIME NULL;

-- Tenants who already completed a move-out and rent nothing else from that landlord become
-- past tenants now (records kept; no new messages). Rejoining with the code restores them.
UPDATE tenant_landlords tl
   SET tl.is_active = 0, tl.left_at = NOW()
 WHERE tl.is_active = 1
   AND EXISTS (SELECT 1 FROM contracts c JOIN units un ON un.id = c.unit_id JOIN properties p ON p.id = un.property_id
               WHERE c.tenant_id = tl.tenant_id AND p.landlord_id = tl.landlord_id AND c.status IN ('terminated','expired'))
   AND NOT EXISTS (SELECT 1 FROM contracts c JOIN units un ON un.id = c.unit_id JOIN properties p ON p.id = un.property_id
                   WHERE c.tenant_id = tl.tenant_id AND p.landlord_id = tl.landlord_id AND c.status IN ('active','move_out_pending'));
