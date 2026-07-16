// Layer 2 — PGlite implementation. Embedded Postgres via WASM.
// Zero external deps beyond @electric-sql/pglite.

import { PGlite } from "@electric-sql/pglite";
import type {
  BidderDb,
  QueryResult,
  AtprotoSessionRow,
  AtprotoSessionInsert,
  DOTokenRow,
  DOTokenInsert,
  BidderKeyRow,
  BidderKeyInsert,
  ContractRow,
  ContractInsert,
  ContractStatus,
} from "@publicdomainrelay/bidder-db-abc";
import { DDL, MIGRATION_DDL } from "@publicdomainrelay/bidder-db-common";

export type { BidderDb };

export interface PGliteDbOptions {
  dataDir: string;
  logger?: { info: (msg: string, data?: Record<string, unknown>) => void };
}

export async function createBidderDbPglite(opts: PGliteDbOptions): Promise<BidderDb> {
  const pg = new PGlite(opts.dataDir);
  opts.logger?.info("pglite_ready", { dataDir: opts.dataDir });

  const db: BidderDb = {
    async migrate() {
      await pg.exec(DDL);
      await pg.exec(MIGRATION_DDL);
    },

    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<T>> {
      const result = await pg.query<T>(sql, params);
      return {
        rows: result.rows,
        rowCount: result.rows.length,
      };
    },

    async execute(sql: string, params?: unknown[]): Promise<number> {
      const result = await pg.query(sql, params);
      return result.affectedRows ?? result.rows.length;
    },

    async transaction<T>(fn: (db: BidderDb) => Promise<T>): Promise<T> {
      // PGlite doesn't have native transaction support via the query API.
      // Use BEGIN/COMMIT/ROLLBACK manually.
      await pg.query("BEGIN");
      try {
        const result = await fn(db);
        await pg.query("COMMIT");
        return result;
      } catch (err) {
        await pg.query("ROLLBACK");
        throw err;
      }
    },

    // ── atproto_sessions ──────────────────────────────────────────────

    async getAtprotoSession(did: string) {
      const r = await pg.query<AtprotoSessionRow>(
        `SELECT * FROM atproto_sessions WHERE did = $1`,
        [did],
      );
      if (!r.rows.length) return null;
      const row = r.rows[0];
      return {
        ...row,
        dpop_public_jwk: typeof row.dpop_public_jwk === "string"
          ? JSON.parse(row.dpop_public_jwk as unknown as string)
          : row.dpop_public_jwk,
        dpop_private_jwk: typeof row.dpop_private_jwk === "string"
          ? JSON.parse(row.dpop_private_jwk as unknown as string)
          : row.dpop_private_jwk,
      };
    },

    async upsertAtprotoSession(session: AtprotoSessionInsert) {
      await pg.query(
        `INSERT INTO atproto_sessions (did, handle, access_jwt, refresh_jwt, dpop_public_jwk, dpop_private_jwk, pds, created_at, refreshed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (did) DO UPDATE SET
           handle = EXCLUDED.handle,
           access_jwt = EXCLUDED.access_jwt,
           refresh_jwt = EXCLUDED.refresh_jwt,
           dpop_public_jwk = EXCLUDED.dpop_public_jwk,
           dpop_private_jwk = EXCLUDED.dpop_private_jwk,
           pds = EXCLUDED.pds,
           refreshed_at = EXCLUDED.refreshed_at`,
        [
          session.did,
          session.handle,
          session.access_jwt,
          session.refresh_jwt,
          JSON.stringify(session.dpop_public_jwk),
          JSON.stringify(session.dpop_private_jwk),
          session.pds,
          Date.now(),
          Date.now(),
        ],
      );
    },

    async updateAtprotoSessionRefreshed(did: string, accessJwt: string, refreshJwt: string) {
      await pg.query(
        `UPDATE atproto_sessions SET access_jwt = $1, refresh_jwt = $2, refreshed_at = $3 WHERE did = $4`,
        [accessJwt, refreshJwt, Date.now(), did],
      );
    },

    async deleteAtprotoSession(did: string) {
      await pg.query(`DELETE FROM atproto_sessions WHERE did = $1`, [did]);
    },

    async listAtprotoSessionsNeedingRefresh(thresholdMs: number) {
      const r = await pg.query<AtprotoSessionRow>(
        `SELECT * FROM atproto_sessions WHERE refreshed_at < $1 ORDER BY refreshed_at ASC`,
        [Date.now() - thresholdMs],
      );
      return r.rows.map(parseAtprotoRow);
    },

    async upsertAtprotoSessionNode(did: string, handle: string, pds: string, sessionData: Record<string, unknown>) {
      await pg.query(
        `INSERT INTO atproto_sessions (did, handle, access_jwt, refresh_jwt, dpop_public_jwk, dpop_private_jwk, pds, _raw_session, created_at, refreshed_at)
         VALUES ($1, $2, '', '', '{}', '{}', $3, $4, $5, $6)
         ON CONFLICT (did) DO UPDATE SET
           handle = EXCLUDED.handle,
           pds = EXCLUDED.pds,
           _raw_session = EXCLUDED._raw_session,
           refreshed_at = EXCLUDED.refreshed_at`,
        [did, handle, pds, JSON.stringify(sessionData), Date.now(), Date.now()],
      );
    },

    async getAtprotoSessionNode(did: string) {
      const r = await pg.query<AtprotoSessionRow>(
        `SELECT _raw_session FROM atproto_sessions WHERE did = $1`,
        [did],
      );
      if (!r.rows.length) return null;
      const row = r.rows[0];
      if (!row._raw_session) return null;
      return typeof row._raw_session === "string"
        ? JSON.parse(row._raw_session as unknown as string)
        : (row._raw_session as unknown as Record<string, unknown>);
    },

    async listAtprotoSessions() {
      const r = await pg.query<AtprotoSessionRow>(`SELECT * FROM atproto_sessions ORDER BY did`);
      return r.rows.map(parseAtprotoRow);
    },

    // ── do_tokens ─────────────────────────────────────────────────────

    async getDOToken(teamUuid: string) {
      const r = await pg.query<DOTokenRow>(
        `SELECT * FROM do_tokens WHERE team_uuid = $1`,
        [teamUuid],
      );
      return r.rows[0] ?? null;
    },

    async getDOTokenByOwner(ownerDid: string) {
      const r = await pg.query<DOTokenRow>(
        `SELECT * FROM do_tokens WHERE owner_did = $1 ORDER BY created_at DESC LIMIT 1`,
        [ownerDid],
      );
      return r.rows[0] ?? null;
    },

    async upsertDOToken(token: DOTokenInsert) {
      await pg.query(
        `INSERT INTO do_tokens (team_uuid, access_token, refresh_token, expires_at, scope, owner_did, created_at, refreshed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (team_uuid) DO UPDATE SET
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at,
           scope = EXCLUDED.scope,
           owner_did = EXCLUDED.owner_did,
           refreshed_at = EXCLUDED.refreshed_at`,
        [
          token.team_uuid,
          token.access_token,
          token.refresh_token,
          token.expires_at,
          token.scope,
          token.owner_did,
          Date.now(),
          Date.now(),
        ],
      );
    },

    async updateDOTokenRefreshed(
      teamUuid: string,
      accessToken: string,
      refreshToken: string,
      expiresAt: number,
    ) {
      await pg.query(
        `UPDATE do_tokens SET access_token = $1, refresh_token = $2, expires_at = $3, refreshed_at = $4 WHERE team_uuid = $5`,
        [accessToken, refreshToken, expiresAt, Date.now(), teamUuid],
      );
    },

    async deleteDOToken(teamUuid: string) {
      await pg.query(`DELETE FROM do_tokens WHERE team_uuid = $1`, [teamUuid]);
    },

    async listDOTokensNeedingRefresh(thresholdMs: number) {
      const r = await pg.query<DOTokenRow>(
        `SELECT * FROM do_tokens WHERE expires_at - $1 < $2 ORDER BY expires_at ASC`,
        [Date.now(), thresholdMs],
      );
      return r.rows;
    },

    // ── bidder_keys ───────────────────────────────────────────────────

    async getBidderKey(id: number) {
      const r = await pg.query<BidderKeyRow>(
        `SELECT * FROM bidder_keys WHERE id = $1`,
        [id],
      );
      return r.rows[0] ?? null;
    },

    async getBidderKeyByPair(atprotoDid: string, doTeamUuid: string) {
      const r = await pg.query<BidderKeyRow>(
        `SELECT * FROM bidder_keys WHERE atproto_did = $1 AND do_team_uuid = $2`,
        [atprotoDid, doTeamUuid],
      );
      return r.rows[0] ?? null;
    },

    async insertBidderKey(key: BidderKeyInsert) {
      const r = await pg.query<BidderKeyRow>(
        `INSERT INTO bidder_keys (atproto_did, do_team_uuid, owner_did, private_key_hex, policy_mode, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [key.atproto_did, key.do_team_uuid, key.owner_did, key.private_key_hex, key.policy_mode ?? 'only-me', Date.now()],
      );
      return r.rows[0];
    },

    async deleteBidderKey(id: number) {
      await pg.query(`DELETE FROM bidder_keys WHERE id = $1`, [id]);
    },

    async updateBidderKeyPolicyMode(id: number, policyMode: string) {
      await pg.query(
        `UPDATE bidder_keys SET policy_mode = $1 WHERE id = $2`,
        [policyMode, id],
      );
    },

    async listBidderKeys(ownerDid?: string) {
      if (ownerDid) {
        const r = await pg.query<BidderKeyRow>(
          `SELECT * FROM bidder_keys WHERE owner_did = $1 ORDER BY id`,
          [ownerDid],
        );
        return r.rows;
      }
      const r = await pg.query<BidderKeyRow>(`SELECT * FROM bidder_keys ORDER BY id`);
      return r.rows;
    },

    async listActiveAccountPairs(ownerDid?: string) {
      const params: unknown[] = [];
      let whereClause = "";
      if (ownerDid) {
        whereClause = "WHERE bk.owner_did = $1";
        params.push(ownerDid);
      }
      const r = await pg.query<{
        bidder_key_id: number;
        private_key_hex: string;
        policy_mode: string;
        did: string;
        handle: string;
        access_jwt: string;
        refresh_jwt: string;
        dpop_public_jwk: string;
        dpop_private_jwk: string;
        pds: string;
        atp_created_at: number;
        atp_refreshed_at: number;
        team_uuid: string;
        access_token: string;
        refresh_token: string;
        expires_at: number;
        scope: string;
        do_created_at: number;
        do_refreshed_at: number;
      }>(
        `SELECT
           bk.id as bidder_key_id, bk.private_key_hex, bk.policy_mode,
           a.*, d.team_uuid, d.access_token, d.refresh_token,
           d.expires_at, d.scope, d.owner_did,
           d.created_at as do_created_at, d.refreshed_at as do_refreshed_at
         FROM bidder_keys bk
         JOIN atproto_sessions a ON a.did = bk.atproto_did
         JOIN do_tokens d ON d.team_uuid = bk.do_team_uuid
         ${whereClause}
         ORDER BY bk.id`,
        params.length ? params : undefined,
      );
      return r.rows.map((row) => ({
        bidderKeyId: row.bidder_key_id,
        privateKeyHex: row.private_key_hex,
        policyMode: row.policy_mode,
        atprotoSession: {
          did: row.did,
          handle: row.handle,
          access_jwt: row.access_jwt,
          refresh_jwt: row.refresh_jwt,
          dpop_public_jwk: typeof row.dpop_public_jwk === "string"
            ? JSON.parse(row.dpop_public_jwk)
            : row.dpop_public_jwk,
          dpop_private_jwk: typeof row.dpop_private_jwk === "string"
            ? JSON.parse(row.dpop_private_jwk)
            : row.dpop_private_jwk,
          pds: row.pds,
          created_at: row.atp_created_at,
          refreshed_at: row.atp_refreshed_at,
        },
        doToken: {
          team_uuid: row.team_uuid,
          access_token: row.access_token,
          refresh_token: row.refresh_token,
          expires_at: row.expires_at,
          scope: row.scope,
          owner_did: (row as Record<string, unknown>).owner_did as string || "",
          created_at: row.do_created_at,
          refreshed_at: row.do_refreshed_at,
        },
      }));
    },

    // ── contracts ─────────────────────────────────────────────────────

    async getContract(id: number) {
      const r = await pg.query<ContractRow>(
        `SELECT * FROM contracts WHERE id = $1`,
        [id],
      );
      return r.rows[0] ?? null;
    },

    async insertContract(contract: ContractInsert) {
      const r = await pg.query<ContractRow>(
        `INSERT INTO contracts (bidder_key_id, requester_did, requester_handle, contract_uri, rfp_uri, vm_id, status, provisioned_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          contract.bidder_key_id,
          contract.requester_did,
          contract.requester_handle ?? null,
          contract.contract_uri,
          contract.rfp_uri,
          contract.vm_id ?? null,
          contract.status ?? "active",
          contract.provisioned_at ?? null,
          Date.now(),
        ],
      );
      return r.rows[0];
    },

    async updateContractStatus(id: number, status: ContractStatus, vmId?: string) {
      const params: unknown[] = [status, Date.now(), id];
      let sql = `UPDATE contracts SET status = $1`;
      if (vmId !== undefined) {
        sql += `, vm_id = $${params.length + 1}`;
        params.splice(params.length - 1, 0, vmId);
      }
      sql += ` WHERE id = $${params.length}`;
      await pg.query(sql, params);
    },

    async updateContractProvisioned(id: number, vmId: string, provisionedAt: number) {
      await pg.query(
        `UPDATE contracts SET vm_id = $1, provisioned_at = $2 WHERE id = $3`,
        [vmId, provisionedAt, id],
      );
    },

    async updateContractCompleted(id: number, completedAt: number) {
      await pg.query(
        `UPDATE contracts SET status = 'completed', completed_at = $1 WHERE id = $2`,
        [completedAt, id],
      );
    },

    async listContractsByBidderKey(bidderKeyId: number, opts) {
      const limit = opts?.limit ?? 50;
      const cursor = opts?.cursor;
      const params: unknown[] = [bidderKeyId, limit + 1];
      let sql = `SELECT * FROM contracts WHERE bidder_key_id = $1`;
      if (cursor !== undefined) {
        sql += ` AND id < $${params.length + 1}`;
        params.push(cursor);
      }
      sql += ` ORDER BY id DESC LIMIT $2`;
      const r = await pg.query<ContractRow>(sql, params);
      const hasMore = r.rows.length > limit;
      const contracts = hasMore ? r.rows.slice(0, limit) : r.rows;
      return {
        contracts,
        cursor: hasMore ? contracts[contracts.length - 1].id : null,
      };
    },

    async listActiveContracts() {
      const r = await pg.query<ContractRow>(
        `SELECT * FROM contracts WHERE status = 'active' ORDER BY id DESC`,
      );
      return r.rows;
    },

    // ── server_config ─────────────────────────────────────────────────

    async getServerConfig(key: string) {
      const r = await pg.query<{ value: string }>(
        `SELECT value FROM server_config WHERE key = $1`,
        [key],
      );
      return r.rows[0]?.value ?? null;
    },

    async setServerConfig(key: string, value: string) {
      await pg.query(
        `INSERT INTO server_config (key, value, created_at, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [key, value, Date.now(), Date.now()],
      );
    },

    async close() {
      await pg.close();
    },
  };

  return db;
}

function parseAtprotoRow(row: AtprotoSessionRow): AtprotoSessionRow {
  return {
    ...row,
    dpop_public_jwk: typeof row.dpop_public_jwk === "string"
      ? JSON.parse(row.dpop_public_jwk as unknown as string)
      : row.dpop_public_jwk,
    dpop_private_jwk: typeof row.dpop_private_jwk === "string"
      ? JSON.parse(row.dpop_private_jwk as unknown as string)
      : row.dpop_private_jwk,
    _raw_session: typeof row._raw_session === "string"
      ? JSON.parse(row._raw_session as unknown as string)
      : row._raw_session,
  };
}
