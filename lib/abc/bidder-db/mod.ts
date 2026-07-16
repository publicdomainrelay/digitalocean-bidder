// Layer 1 — pure interfaces. Zero I/O. Type-only imports from common.

import type {
  AtprotoSessionRow,
  AtprotoSessionInsert,
  DOTokenRow,
  DOTokenInsert,
  BidderKeyRow,
  BidderKeyInsert,
  ContractRow,
  ContractInsert,
  ContractStatus,
} from "@publicdomainrelay/bidder-db-common";

export type {
  AtprotoSessionRow,
  AtprotoSessionInsert,
  DOTokenRow,
  DOTokenInsert,
  BidderKeyRow,
  BidderKeyInsert,
  ContractRow,
  ContractInsert,
  ContractStatus,
};

export type QueryResult<T> = {
  rows: T[];
  rowCount: number;
};

export interface BidderDb {
  /** Run DDL migration — idempotent (CREATE IF NOT EXISTS). */
  migrate(): Promise<void>;

  /** Execute raw SQL, return rows typed by caller. */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;

  /** Execute a statement with no result rows (INSERT/UPDATE/DELETE). */
  execute(sql: string, params?: unknown[]): Promise<number>;

  /** Run multiple statements in a transaction. */
  transaction<T>(fn: (db: BidderDb) => Promise<T>): Promise<T>;

  // ── atproto_sessions ──────────────────────────────────────────────────

  getAtprotoSession(did: string): Promise<AtprotoSessionRow | null>;
  upsertAtprotoSession(session: AtprotoSessionInsert): Promise<void>;
  updateAtprotoSessionRefreshed(did: string, accessJwt: string, refreshJwt: string): Promise<void>;
  deleteAtprotoSession(did: string): Promise<void>;
  listAtprotoSessionsNeedingRefresh(thresholdMs: number): Promise<AtprotoSessionRow[]>;
  /** Store full NodeOAuthClient session blob (used by sessionStore). */
  upsertAtprotoSessionNode(did: string, handle: string, pds: string, sessionData: Record<string, unknown>): Promise<void>;
  /** Read full NodeOAuthClient session blob. */
  getAtprotoSessionNode(did: string): Promise<Record<string, unknown> | null>;
  /** List all atproto sessions (for session lookup). */
  listAtprotoSessions(): Promise<AtprotoSessionRow[]>;

  // ── do_tokens ─────────────────────────────────────────────────────────

  getDOToken(teamUuid: string): Promise<DOTokenRow | null>;
  getDOTokenByOwner(ownerDid: string): Promise<DOTokenRow | null>;
  upsertDOToken(token: DOTokenInsert): Promise<void>;
  updateDOTokenRefreshed(teamUuid: string, accessToken: string, refreshToken: string, expiresAt: number): Promise<void>;
  deleteDOToken(teamUuid: string): Promise<void>;
  listDOTokensNeedingRefresh(thresholdMs: number): Promise<DOTokenRow[]>;

  // ── bidder_keys ───────────────────────────────────────────────────────

  getBidderKey(id: number): Promise<BidderKeyRow | null>;
  getBidderKeyByPair(atprotoDid: string, doTeamUuid: string): Promise<BidderKeyRow | null>;
  insertBidderKey(key: BidderKeyInsert): Promise<BidderKeyRow>;
  deleteBidderKey(id: number): Promise<void>;
  listBidderKeys(ownerDid?: string): Promise<BidderKeyRow[]>;
  /** Update policy mode for a specific bidder key. */
  updateBidderKeyPolicyMode(id: number, policyMode: string): Promise<void>;
  /** Join with sessions+tokens to get full account pairs, optionally scoped to owner. */
  listActiveAccountPairs(ownerDid?: string): Promise<Array<{
    bidderKeyId: number;
    privateKeyHex: string;
    atprotoSession: AtprotoSessionRow;
    doToken: DOTokenRow;
  }>>;

  // ── server_config ─────────────────────────────────────────────────────

  getServerConfig(key: string): Promise<string | null>;
  setServerConfig(key: string, value: string): Promise<void>;

  // ── contracts ─────────────────────────────────────────────────────────

  getContract(id: number): Promise<ContractRow | null>;
  insertContract(contract: ContractInsert): Promise<ContractRow>;
  updateContractStatus(id: number, status: ContractStatus, vmId?: string): Promise<void>;
  updateContractProvisioned(id: number, vmId: string, provisionedAt: number): Promise<void>;
  updateContractCompleted(id: number, completedAt: number): Promise<void>;
  /** Paginated — cursor is last contract id, limit defaults to 50. */
  listContractsByBidderKey(
    bidderKeyId: number,
    opts?: { cursor?: number; limit?: number },
  ): Promise<{ contracts: ContractRow[]; cursor: number | null }>;
  /** All active contracts across all bidder keys. */
  listActiveContracts(): Promise<ContractRow[]>;

  close(): Promise<void>;
}
