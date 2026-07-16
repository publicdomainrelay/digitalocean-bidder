// DigitalOcean OAuth implementation — fetch-based OAuth2 flow + token persistence.
// Layer: impl. Uses fetch + Deno FS + Deno KV (SQLite) + PostgreSQL client.

import type { StructuredLoggerInterface } from "@publicdomainrelay/logger";
import type {
  DOOAuthFlow,
  DOOAuthFlowOptions,
  DOTokenStore,
} from "@publicdomainrelay/digitalocean-oauth-abc";
import {
  DO_ENDPOINTS,
  DO_SCOPES,
  DO_TOKEN_REFRESH_THRESHOLD_MS,
  createDOState,
  type DOAccountResponse,
  type DOAuthState,
  type DOOAuthTokenResponse,
  type DOTokenData,
} from "@publicdomainrelay/digitalocean-oauth-common";

// ═══════════════════════════════════════════════════════════════════════════════
// OAuth2 Authorization Code Grant flow (fetch-based)
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a fetch-based DigitalOcean OAuth2 flow. */
export function createDOOAuthFlow(opts: DOOAuthFlowOptions): DOOAuthFlow {
  const {
    clientId,
    clientSecret,
    redirectUri,
    scope = DO_SCOPES,
  } = opts;
  const authBase = opts.authBaseUrl ?? "https://cloud.digitalocean.com";
  const apiBase = opts.apiBaseUrl ?? "https://api.digitalocean.com";

  return {
    authorizeUrl(state: DOAuthState): string {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope,
        state: state.state,
      });
      return `${authBase}/v1/oauth/authorize?${params}`;
    },

    async exchangeCode(code: string, _state: DOAuthState): Promise<DOTokenData> {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      });

      const res = await fetch(`${authBase}/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`DO token exchange failed: ${res.status} ${text}`);
      }

      const data = (await res.json()) as DOOAuthTokenResponse;

      // Resolve team UUID from /v2/account
      const accountRes = await fetch(`${apiBase}/v2/account`, {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (!accountRes.ok) {
        const text = await accountRes.text().catch(() => "");
        throw new Error(`DO /v2/account failed: ${accountRes.status} ${text}`);
      }
      const account = (await accountRes.json()) as DOAccountResponse;

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        teamUuid: account.account.team.uuid,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
        scope: data.scope ?? scope,
      };
    },

    async refreshToken(token: DOTokenData): Promise<DOTokenData> {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      });

      const res = await fetch(`${authBase}/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`DO token refresh failed: ${res.status} ${text}`);
      }

      const data = (await res.json()) as DOOAuthTokenResponse;

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? token.refreshToken,
        teamUuid: token.teamUuid,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
        scope: data.scope ?? token.scope,
      };
    },

    async getTeamUuid(accessToken: string): Promise<string> {
      const res = await fetch(`${apiBase}/v2/account`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`DO /v2/account failed: ${res.status} ${text}`);
      }
      const account = (await res.json()) as DOAccountResponse;
      return account.account.team.uuid;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Token stores — file, SQLite (Deno KV), PostgreSQL
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a file-based token store (one JSON file mapping team UUID → token). */
export function createDOFileTokenStore(basePath: string): DOTokenStore {
  const STORE_FILE = `${basePath.replace(/\/+$/, "")}/do-tokens.json`;

  async function readStore(): Promise<Record<string, DOTokenData>> {
    try {
      const text = await Deno.readTextFile(STORE_FILE);
      return JSON.parse(text) as Record<string, DOTokenData>;
    } catch {
      return {};
    }
  }

  async function writeStore(store: Record<string, DOTokenData>): Promise<void> {
    await Deno.mkdir(basePath, { recursive: true });
    await Deno.writeTextFile(STORE_FILE, JSON.stringify(store, null, 2));
  }

  return {
    async load(teamUuid: string): Promise<DOTokenData | null> {
      const store = await readStore();
      return store[teamUuid] ?? null;
    },
    async save(token: DOTokenData): Promise<void> {
      const store = await readStore();
      store[token.teamUuid] = token;
      await writeStore(store);
    },
    async delete(teamUuid: string): Promise<void> {
      const store = await readStore();
      delete store[teamUuid];
      await writeStore(store);
    },
    async listTeams(): Promise<string[]> {
      const store = await readStore();
      return Object.keys(store);
    },
  };
}

/** Create a SQLite-backed token store via Deno.openKv (zero deps, built-in). */
export function createDOSqliteTokenStore(dbPath?: string): DOTokenStore {
  let kvPromise: Promise<Deno.Kv> | null = null;

  function getKv(): Promise<Deno.Kv> {
    if (!kvPromise) {
      kvPromise = Deno.openKv(dbPath);
    }
    return kvPromise;
  }

  return {
    async load(teamUuid: string): Promise<DOTokenData | null> {
      const kv = await getKv();
      const result = await kv.get<DOTokenData>(["do-tokens", teamUuid]);
      return result.value ?? null;
    },
    async save(token: DOTokenData): Promise<void> {
      const kv = await getKv();
      await kv.set(["do-tokens", token.teamUuid], token);
    },
    async delete(teamUuid: string): Promise<void> {
      const kv = await getKv();
      await kv.delete(["do-tokens", teamUuid]);
    },
    async listTeams(): Promise<string[]> {
      const kv = await getKv();
      const teams: string[] = [];
      const iter = kv.list<DOTokenData>({ prefix: ["do-tokens"] });
      for await (const entry of iter) {
        const key = entry.key[1];
        if (typeof key === "string") teams.push(key);
      }
      return teams;
    },
  };
}

/** Create a PostgreSQL-backed token store. */
export function createDOPostgresTokenStore(
  connectionString: string,
  logger?: StructuredLoggerInterface,
): DOTokenStore {
  // Lazy-import postgres client so the file loads without the npm dep installed
  // until this store is actually selected.
  // deno-lint-ignore no-explicit-any
  let sql: any = null;
  let initPromise: Promise<void> | null = null;

  // deno-lint-ignore no-explicit-any
  async function getSql(): Promise<any> {
    if (!sql) {
      const postgres = (await import("npm:postgres")).default;
      sql = postgres(connectionString);
      if (!initPromise) {
        initPromise = sql.unsafe(`
          CREATE TABLE IF NOT EXISTS do_tokens (
            team_uuid TEXT PRIMARY KEY,
            access_token TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            expires_at BIGINT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'read write'
          )
        `).then(() => {
          logger?.info?.("do_postgres_token_store_initialized", {});
        });
      }
    }
    await initPromise;
    return sql;
  }

  return {
    async load(teamUuid: string): Promise<DOTokenData | null> {
      const s = await getSql();
      const rows = await s.unsafe(
        "SELECT * FROM do_tokens WHERE team_uuid = $1",
        [teamUuid],
      ) as { team_uuid: string; access_token: string; refresh_token: string; expires_at: string; scope: string }[];
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        accessToken: r.access_token,
        refreshToken: r.refresh_token,
        teamUuid: r.team_uuid,
        expiresAt: Number(r.expires_at),
        scope: r.scope,
      };
    },
    async save(token: DOTokenData): Promise<void> {
      const s = await getSql();
      await s.unsafe(
        `INSERT INTO do_tokens (team_uuid, access_token, refresh_token, expires_at, scope)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (team_uuid)
         DO UPDATE SET
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at,
           scope = EXCLUDED.scope`,
        [token.teamUuid, token.accessToken, token.refreshToken, token.expiresAt, token.scope],
      );
    },
    async delete(teamUuid: string): Promise<void> {
      const s = await getSql();
      await s.unsafe("DELETE FROM do_tokens WHERE team_uuid = $1", [teamUuid]);
    },
    async listTeams(): Promise<string[]> {
      const s = await getSql();
      const rows = await s.unsafe("SELECT team_uuid FROM do_tokens") as { team_uuid: string }[];
      return rows.map((r: { team_uuid: string }) => r.team_uuid);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Token resolution helper — checks freshness, refreshes if stale
// ═══════════════════════════════════════════════════════════════════════════════

/** Options for resolveDOToken. */
export interface ResolveDOTokenOptions {
  flow: DOOAuthFlow;
  store: DOTokenStore;
  logger?: StructuredLoggerInterface;
  /** Team UUID to select when multiple teams have stored tokens. Omit to use first. */
  teamUuid?: string;
}

/** Persistent token handle: holds the latest token and can proactively refresh. */
export interface DOTokenHandle {
  /** The currently-resolved token data (may be stale — check expiresAt). */
  current(): DOTokenData | null;
  /** Resolve a fresh access token: load from store, refresh if expiring, or throw. */
  resolve(): Promise<string>;
  /** Proactively refresh if within threshold of expiry. No-op if no token stored. */
  proactiveRefresh(): Promise<void>;
}

/** Create a DOTokenHandle that loads/refreshes tokens on demand. */
export function createDOTokenHandle(opts: ResolveDOTokenOptions): DOTokenHandle {
  const { flow, store, logger, teamUuid } = opts;
  let currentToken: DOTokenData | null = null;

  return {
    current(): DOTokenData | null {
      return currentToken;
    },

    async resolve(): Promise<string> {
      // If still fresh (outside refresh threshold), return cached token.
      if (
        currentToken &&
        currentToken.expiresAt > Date.now() + DO_TOKEN_REFRESH_THRESHOLD_MS
      ) {
        return currentToken.accessToken;
      }

      // Try refresh if we have a token with a refresh token.
      if (currentToken?.refreshToken) {
        try {
          currentToken = await flow.refreshToken(currentToken);
          await store.save(currentToken);
          logger?.info?.("do_token_refreshed", { teamUuid: currentToken.teamUuid });
          return currentToken.accessToken;
        } catch (err) {
          logger?.warn?.("do_token_refresh_failed_trying_store", {
            teamUuid: currentToken.teamUuid,
            error: String(err),
          });
        }
      }

      // Load from persistent store.
      if (teamUuid) {
        const stored = await store.load(teamUuid);
        if (stored) {
          currentToken = stored;
          // Check expiry — refresh if stale.
          if (stored.expiresAt <= Date.now() + DO_TOKEN_REFRESH_THRESHOLD_MS) {
            if (stored.refreshToken) {
              try {
                currentToken = await flow.refreshToken(stored);
                await store.save(currentToken);
                logger?.info?.("do_token_refreshed_from_store", { teamUuid });
                return currentToken.accessToken;
              } catch (err) {
                logger?.warn?.("do_token_refresh_failed", { teamUuid, error: String(err) });
                throw new Error(
                  `DO token expired for team ${teamUuid} and refresh failed. Re-authenticate with DO OAuth.`,
                );
              }
            }
            throw new Error(
              `DO token expired for team ${teamUuid} and no refresh token available. Re-authenticate with DO OAuth.`,
            );
          }
          return stored.accessToken;
        }
        throw new Error(`No stored DO token for team ${teamUuid}. Run DO OAuth flow first.`);
      }

      // No team specified — try first available.
      const teams = await store.listTeams();
      if (teams.length === 0) {
        throw new Error("No stored DO tokens. Run DO OAuth flow first.");
      }

      const firstToken = await store.load(teams[0]);
      if (!firstToken) {
        throw new Error(`Stored DO token for team ${teams[0]} not found.`);
      }

      currentToken = firstToken;
      if (firstToken.expiresAt <= Date.now() + DO_TOKEN_REFRESH_THRESHOLD_MS) {
        if (firstToken.refreshToken) {
          currentToken = await flow.refreshToken(firstToken);
          await store.save(currentToken);
          logger?.info?.("do_token_refreshed_from_store", { teamUuid: currentToken.teamUuid });
        } else {
          throw new Error(
            `DO token expired for team ${teams[0]} and no refresh token. Re-authenticate.`,
          );
        }
      }

      return currentToken.accessToken;
    },

    async proactiveRefresh(): Promise<void> {
      if (
        currentToken &&
        currentToken.expiresAt <= Date.now() + DO_TOKEN_REFRESH_THRESHOLD_MS &&
        currentToken.refreshToken
      ) {
        try {
          currentToken = await flow.refreshToken(currentToken);
          await store.save(currentToken);
          logger?.info?.("do_token_proactive_refresh", { teamUuid: currentToken.teamUuid });
        } catch (err) {
          logger?.warn?.("do_token_proactive_refresh_failed", {
            teamUuid: currentToken.teamUuid,
            error: String(err),
          });
        }
      }
    },
  };
}

// Re-export for consumers
export { createDOState, DO_SCOPES, DO_ENDPOINTS };
export type { DOAuthState, DOOAuthFlowOptions, DOTokenData };
