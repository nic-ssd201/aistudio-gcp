-- Migration 066: Rename auth_type 'cognito_passthrough' -> 'session_passthrough' (SSD201 GCP fork)
--
-- Migration 060 added 'cognito_passthrough' as a Nexus MCP auth_type. The name was always a
-- misnomer (the value forwards whatever ID token the NextAuth session holds, not specifically
-- a Cognito token), and after the GCP migration removed Cognito entirely the name became
-- actively misleading. Rename the enum value in place.
--
-- Strategy is expand-then-contract so a partially-deployed app keeps working:
--   1. Widen the CHECK constraint to allow BOTH old and new values.
--   2. UPDATE existing rows from the old value to the new value.
--   3. Tighten the CHECK constraint to only allow the new value.
-- For SSD201 today step 2 likely UPDATEs zero rows (no MCP connectors configured yet),
-- but the migration must still run so the constraint reflects the renamed enum.

-- Step 1: widen constraint to accept both old and new values
ALTER TABLE nexus_mcp_servers DROP CONSTRAINT IF EXISTS nexus_mcp_servers_auth_type_check;
ALTER TABLE nexus_mcp_servers ADD CONSTRAINT nexus_mcp_servers_auth_type_check
  CHECK (auth_type IN ('api_key', 'oauth', 'jwt', 'none', 'cognito_passthrough', 'session_passthrough'));

-- Step 2: rewrite existing rows
UPDATE nexus_mcp_servers
SET auth_type = 'session_passthrough'
WHERE auth_type = 'cognito_passthrough';

-- Step 3: drop the old value, leaving only the new one
ALTER TABLE nexus_mcp_servers DROP CONSTRAINT nexus_mcp_servers_auth_type_check;
ALTER TABLE nexus_mcp_servers ADD CONSTRAINT nexus_mcp_servers_auth_type_check
  CHECK (auth_type IN ('api_key', 'oauth', 'jwt', 'none', 'session_passthrough'));
