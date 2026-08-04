// Layer 0 — DB types, SQL DDL, constants. Pure data, zero I/O.
// No project-local imports.

/** Row types returned from DB queries. JSONB fields are parsed objects. */

export interface AtprotoSessionRow {
  did: string;
  handle: string;
  access_jwt: string;
  refresh_jwt: string;
  dpop_public_jwk: Record<string, string>;
  dpop_private_jwk: Record<string, string>;
  pds: string;
  created_at: number;
  refreshed_at: number;
  /** Full NodeOAuthClient session blob (JSONB). Set by sessionStore, read by client.restore(). */
  _raw_session?: Record<string, unknown>;
}

export interface DOTokenRow {
  team_uuid: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  owner_did: string;
  created_at: number;
  refreshed_at: number;
}

export interface BidderKeyRow {
  id: number;
  atproto_did: string;
  do_team_uuid: string;
  owner_did: string;
  private_key_hex: string;
  policy: string;
  policy_args: string;
  created_at: number;
}

export type ContractStatus = "active" | "completed" | "cancelled";

export interface ContractRow {
  id: number;
  bidder_key_id: number;
  requester_did: string;
  requester_handle: string | null;
  contract_uri: string;
  rfp_uri: string;
  vm_id: string | null;
  status: ContractStatus;
  provisioned_at: number | null;
  completed_at: number | null;
  created_at: number;
}

/** Input types for inserts (omit auto-generated fields). */

export interface AtprotoSessionInsert {
  did: string;
  handle: string;
  access_jwt: string;
  refresh_jwt: string;
  dpop_public_jwk: Record<string, string>;
  dpop_private_jwk: Record<string, string>;
  pds: string;
  _raw_session?: unknown;
}

export interface DOTokenInsert {
  team_uuid: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  owner_did: string;
}

export interface BidderKeyInsert {
  atproto_did: string;
  do_team_uuid: string;
  owner_did: string;
  private_key_hex: string;
  policy?: string;
  policy_args?: string;
}

export interface ContractInsert {
  bidder_key_id: number;
  requester_did: string;
  requester_handle?: string;
  contract_uri: string;
  rfp_uri: string;
  vm_id?: string;
  status?: ContractStatus;
  provisioned_at?: number;
}

/** SQL DDL — same for PGlite and real Postgres. */

export const DDL = `
CREATE TABLE IF NOT EXISTS atproto_sessions (
  did TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  access_jwt TEXT NOT NULL,
  refresh_jwt TEXT NOT NULL,
  dpop_public_jwk JSONB NOT NULL,
  dpop_private_jwk JSONB NOT NULL,
  pds TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  refreshed_at BIGINT NOT NULL,
  _raw_session JSONB
);

CREATE TABLE IF NOT EXISTS do_tokens (
  team_uuid TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  scope TEXT NOT NULL,
  owner_did TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  refreshed_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bidder_keys (
  id SERIAL PRIMARY KEY,
  atproto_did TEXT NOT NULL REFERENCES atproto_sessions(did) ON DELETE CASCADE,
  do_team_uuid TEXT NOT NULL REFERENCES do_tokens(team_uuid) ON DELETE CASCADE,
  owner_did TEXT NOT NULL DEFAULT '',
  private_key_hex TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(atproto_did, do_team_uuid)
);

CREATE TABLE IF NOT EXISTS server_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id SERIAL PRIMARY KEY,
  bidder_key_id INTEGER NOT NULL REFERENCES bidder_keys(id) ON DELETE CASCADE,
  requester_did TEXT NOT NULL,
  requester_handle TEXT,
  contract_uri TEXT NOT NULL,
  rfp_uri TEXT NOT NULL,
  vm_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled')),
  provisioned_at BIGINT,
  completed_at BIGINT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contracts_bidder_key_id ON contracts(bidder_key_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_created_at ON contracts(created_at DESC);
`;

/** Migration DDL — ALTER statements to upgrade existing DBs. Idempotent. */
export const MIGRATION_DDL = `
ALTER TABLE bidder_keys ADD COLUMN IF NOT EXISTS owner_did TEXT NOT NULL DEFAULT '';
ALTER TABLE bidder_keys ADD COLUMN IF NOT EXISTS policy TEXT NOT NULL DEFAULT 'only-me';
ALTER TABLE bidder_keys ADD COLUMN IF NOT EXISTS policy_args TEXT NOT NULL DEFAULT '{}';
ALTER TABLE do_tokens ADD COLUMN IF NOT EXISTS owner_did TEXT NOT NULL DEFAULT '';
ALTER TABLE atproto_sessions ADD COLUMN IF NOT EXISTS _raw_session JSONB;
CREATE TABLE IF NOT EXISTS server_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bidder_keys_owner_did ON bidder_keys(owner_did);
`;

/** Table name constants. */
export const TABLE_ATPROTO_SESSIONS = "atproto_sessions";
export const TABLE_DO_TOKENS = "do_tokens";
export const TABLE_BIDDER_KEYS = "bidder_keys";
export const TABLE_CONTRACTS = "contracts";
export const TABLE_SERVER_CONFIG = "server_config";
