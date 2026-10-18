-- Tenants join with the landlord's one code only; per-property join codes are gone.
ALTER TABLE properties DROP INDEX IF EXISTS uq_property_join_code;
ALTER TABLE properties DROP COLUMN IF EXISTS join_code;
ALTER TABLE tenant_landlords DROP COLUMN IF EXISTS property_id;
