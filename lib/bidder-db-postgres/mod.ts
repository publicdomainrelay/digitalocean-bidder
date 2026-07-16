// Layer 2 — PostgreSQL implementation via npm:postgres.
// Used when DATABASE_URI is set.

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

export interface PostgresDbOptions {
  connectionString: string;
  logger?: { info: (msg: string, data?: Record<string, unknown>) => void };
}

export async function createBidderDbPostgres(opts: PostgresDbOptions): Promise<BidderDb> {
  // Dynamic import — only pulls in postgres when this function is called
  const { default: postgres } = await import("npm:postgres");
  const sql = postgres(opts.connectionString, { max: 5 });
  opts.logger?.info("postgres_connected", { host: new URL(opts.connectionString).hostname });

  const db: BidderDb = {
    async migrate() {
      await sql.unsafe(DDL);
      await sql.unsafe(MIGRATION_DDL);
    },

    async query<T = Record<string, unknown>>(
      query: string,
      params?: unknown[],
    ): Promise<QueryResult<T>> {
      const result = await sql.unsafe(query, params as never[]);
      return {
        // deno-lint-ignore no-explicit-any
        rows: result as any as T[],
        rowCount: result.length,
      };
    },

    async execute(query: string, params?: unknown[]): Promise<number> {
      const result = await sql.unsafe(query, params as never[]);
      // deno-lint-ignore no-explicit-any
      return (result as any).count ?? result.length;
    },

    async transaction<T>(fn: (db: BidderDb) => Promise<T>): Promise<T> {
      const tx = sql.begin(() =>
        fn(db).then(
          (val) => Promise.resolve(val),
          (err) => Promise.reject(err),
        )
      );
      return tx as Promise<T>;
    },

    // ── atproto_sessions ──────────────────────────────────────────────

    async getAtprotoSession(did: string) {
      const rows = await sql.unsafe(
        `SELECT * FROM atproto_sessions WHERE did = $1`,
        [did],
      ) as AtprotoSessionRow[];
      if (!rows.length) return null;
      return parseAtprotoRow(rows[0]);
    },

    async upsertAtprotoSession(session: AtprotoSessionInsert) {
      await sql.unsafe(
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
      await sql.unsafe(
        `UPDATE atproto_sessions SET access_jwt = $1, refresh_jwt = $2, refreshed_at = $3 WHERE did = $4`,
        [accessJwt, refreshJwt, Date.now(), did],
      );
    },

    async deleteAtprotoSession(did: string) {
      await sql.unsafe(`DELETE FROM atproto_sessions WHERE did = $1`, [did]);
    },

    async listAtprotoSessionsNeedingRefresh(thresholdMs: number) {
      const rows = await sql.unsafe(
        `SELECT * FROM atproto_sessions WHERE refreshed_at < $1 ORDER BY refreshed_at ASC`,
        [Date.now() - thresholdMs],
      ) as AtprotoSessionRow[];
      return rows.map(parseAtprotoRow);
    },

    async upsertAtprotoSessionNode(did: string, handle: string, pds: string, sessionData: Record<string, unknown>) {
      await sql.unsafe(
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
      const rows = await sql.unsafe(
        `SELECT _raw_session FROM atproto_sessions WHERE did = $1`,
        [did],
      ) as { _raw_session: unknown }[];
      if (!rows.length || !rows[0]._raw_session) return null;
      const val = rows[0]._raw_session;
      return typeof val === "string" ? JSON.parse(val) : (val as Record<string, unknown>);
    },

    async listAtprotoSessions() {
      return sql.unsafe(`SELECT * FROM atproto_sessions ORDER BY did`) as Promise<AtprotoSessionRow[]>;
    },

    // ── do_tokens ─────────────────────────────────────────────────────

    async getDOToken(teamUuid: string) {
      const rows = await sql.unsafe(
        `SELECT * FROM do_tokens WHERE team_uuid = $1`,
        [teamUuid],
      ) as DOTokenRow[];
      return rows[0] ?? null;
    },

    async getDOTokenByOwner(ownerDid: string) {
      const rows = await sql.unsafe(
        `SELECT * FROM do_tokens WHERE owner_did = $1 ORDER BY created_at DESC LIMIT 1`,
        [ownerDid],
      ) as DOTokenRow[];
      return rows[0] ?? null;
    },

    async upsertDOToken(token: DOTokenInsert) {
      await sql.unsafe(
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
      await sql.unsafe(
        `UPDATE do_tokens SET access_token = $1, refresh_token = $2, expires_at = $3, refreshed_at = $4 WHERE team_uuid = $5`,
        [accessToken, refreshToken, expiresAt, Date.now(), teamUuid],
      );
    },

    async deleteDOToken(teamUuid: string) {
      await sql.unsafe(`DELETE FROM do_tokens WHERE team_uuid = $1`, [teamUuid]);
    },

    async listDOTokensNeedingRefresh(thresholdMs: number) {
      return sql.unsafe(
        `SELECT * FROM do_tokens WHERE expires_at - $1 < $2 ORDER BY expires_at ASC`,
        [Date.now(), thresholdMs],
      ) as Promise<DOTokenRow[]>;
    },

    // ── bidder_keys ───────────────────────────────────────────────────

    async getBidderKey(id: number) {
      const rows = await sql.unsafe(
        `SELECT * FROM bidder_keys WHERE id = $1`,
        [id],
      ) as BidderKeyRow[];
      return rows[0] ?? null;
    },

    async getBidderKeyByPair(atprotoDid: string, doTeamUuid: string) {
      const rows = await sql.unsafe(
        `SELECT * FROM bidder_keys WHERE atproto_did = $1 AND do_team_uuid = $2`,
        [atprotoDid, doTeamUuid],
      ) as BidderKeyRow[];
      return rows[0] ?? null;
    },

    async insertBidderKey(key: BidderKeyInsert) {
      const rows = await sql.unsafe(
        `INSERT INTO bidder_keys (atproto_did, do_team_uuid, owner_did, private_key_hex, created_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [key.atproto_did, key.do_team_uuid, key.owner_did, key.private_key_hex, Date.now()],
      ) as BidderKeyRow[];
      return rows[0];
    },

    async deleteBidderKey(id: number) {
      await sql.unsafe(`DELETE FROM bidder_keys WHERE id = $1`, [id]);
    },

    async listBidderKeys(ownerDid?: string) {
      if (ownerDid) {
        return sql.unsafe(
          `SELECT * FROM bidder_keys WHERE owner_did = $1 ORDER BY id`,
          [ownerDid],
        ) as Promise<BidderKeyRow[]>;
      }
      return sql.unsafe(`SELECT * FROM bidder_keys ORDER BY id`) as Promise<BidderKeyRow[]>;
    },

    async listActiveAccountPairs(ownerDid?: string) {
      // deno-lint-ignore no-explicit-any
      const params: unknown[] = [];
      let whereClause = "";
      if (ownerDid) {
        whereClause = "WHERE bk.owner_did = $1";
        params.push(ownerDid);
      }
      const rows = await sql.unsafe(
        `SELECT
           bk.id as bidder_key_id, bk.private_key_hex,
           a.did, a.handle, a.access_jwt, a.refresh_jwt,
           a.dpop_public_jwk, a.dpop_private_jwk, a.pds,
           a.created_at as atp_created_at, a.refreshed_at as atp_refreshed_at,
           d.team_uuid, d.access_token, d.refresh_token,
           d.expires_at, d.scope, d.owner_did,
           d.created_at as do_created_at, d.refreshed_at as do_refreshed_at
         FROM bidder_keys bk
         JOIN atproto_sessions a ON a.did = bk.atproto_did
         JOIN do_tokens d ON d.team_uuid = bk.do_team_uuid
         ${whereClause}
         ORDER BY bk.id`,
        params.length ? (params as never[]) : undefined,
      ) as any[];
      return rows.map((row) => ({
        bidderKeyId: row.bidder_key_id,
        privateKeyHex: row.private_key_hex,
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
          owner_did: row.owner_did || "",
          created_at: row.do_created_at,
          refreshed_at: row.do_refreshed_at,
        },
      }));
    },

    // ── contracts ─────────────────────────────────────────────────────

    async getContract(id: number) {
      const rows = await sql.unsafe(
        `SELECT * FROM contracts WHERE id = $1`,
        [id],
      ) as ContractRow[];
      return rows[0] ?? null;
    },

    async insertContract(contract: ContractInsert) {
      const rows = await sql.unsafe(
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
      ) as ContractRow[];
      return rows[0];
    },

    async updateContractStatus(id: number, status: ContractStatus, vmId?: string) {
      if (vmId !== undefined) {
        await sql.unsafe(
          `UPDATE contracts SET status = $1, vm_id = $2 WHERE id = $3`,
          [status, vmId, id],
        );
      } else {
        await sql.unsafe(`UPDATE contracts SET status = $1 WHERE id = $2`, [status, id]);
      }
    },

    async updateContractProvisioned(id: number, vmId: string, provisionedAt: number) {
      await sql.unsafe(
        `UPDATE contracts SET vm_id = $1, provisioned_at = $2 WHERE id = $3`,
        [vmId, provisionedAt, id],
      );
    },

    async updateContractCompleted(id: number, completedAt: number) {
      await sql.unsafe(
        `UPDATE contracts SET status = 'completed', completed_at = $1 WHERE id = $2`,
        [completedAt, id],
      );
    },

    async listContractsByBidderKey(bidderKeyId: number, opts) {
      const limit = opts?.limit ?? 50;
      const cursor = opts?.cursor;
      let q = `SELECT * FROM contracts WHERE bidder_key_id = $1`;
      const params: unknown[] = [bidderKeyId];
      if (cursor !== undefined) {
        q += ` AND id < $${params.length + 1}`;
        params.push(cursor);
      }
      q += ` ORDER BY id DESC LIMIT $${params.length + 1}`;
      params.push(limit + 1);
      const rows = await sql.unsafe(q, params as never[]) as ContractRow[];
      const hasMore = rows.length > limit;
      const contracts = hasMore ? rows.slice(0, limit) : rows;
      return {
        contracts,
        cursor: hasMore ? contracts[contracts.length - 1].id : null,
      };
    },

    async listActiveContracts() {
      return sql.unsafe(
        `SELECT * FROM contracts WHERE status = 'active' ORDER BY id DESC`,
      ) as Promise<ContractRow[]>;
    },

    // ── server_config ─────────────────────────────────────────────────

    async getServerConfig(key: string) {
      const rows = await sql.unsafe(
        `SELECT value FROM server_config WHERE key = $1`,
        [key],
      ) as { value: string }[];
      return rows[0]?.value ?? null;
    },

    async setServerConfig(key: string, value: string) {
      await sql.unsafe(
        `INSERT INTO server_config (key, value, created_at, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [key, value, Date.now(), Date.now()],
      );
    },

    async close() {
      await sql.end();
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
