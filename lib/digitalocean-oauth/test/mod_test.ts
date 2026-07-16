// DO OAuth unit tests — flow + token stores.
import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import {
  createDOOAuthFlow,
  createDOFileTokenStore,
  createDOSqliteTokenStore,
  createDOTokenHandle,
  createDOState,
  DO_SCOPES,
  DO_ENDPOINTS,
  type DOTokenData,
} from "../mod.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// DOOAuthFlow tests
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("createDOOAuthFlow — authorizeUrl builds correct URL", () => {
  const flow = createDOOAuthFlow({
    clientId: "test-client-id",
    clientSecret: "test-secret",
    redirectUri: "http://localhost:9999/do-callback",
  });

  const state = createDOState();
  const url = flow.authorizeUrl(state);

  assert(url.startsWith("https://cloud.digitalocean.com/v1/oauth/authorize"));
  assert(url.includes("client_id=test-client-id"));
  assert(url.includes("redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fdo-callback"));
  assert(url.includes("response_type=code"));
  assert(url.includes("scope=droplet%3Aread%2Bdroplet%3Acreate%2Bdroplet%3Adelete%2Baccount%3Aread%2Btag%3Acreate%2Btag%3Aread") || url.includes("scope=droplet"));
  assert(url.includes(`state=${state.state}`));
});

Deno.test("createDOOAuthFlow — authorizeUrl with custom auth base", () => {
  const flow = createDOOAuthFlow({
    clientId: "ci",
    clientSecret: "cs",
    redirectUri: "http://localhost/cb",
    authBaseUrl: "https://custom.example.com",
  });

  const state = { state: "abc123" };
  const url = flow.authorizeUrl(state);
  assert(url.startsWith("https://custom.example.com/v1/oauth/authorize"));
});

Deno.test("createDOOAuthFlow — authorizeUrl with custom scope", () => {
  const flow = createDOOAuthFlow({
    clientId: "ci",
    clientSecret: "cs",
    redirectUri: "http://localhost/cb",
    scope: "read",
  });

  const state = { state: "xyz" };
  const url = flow.authorizeUrl(state);
  assert(url.includes("scope=read"));
  assertFalse(url.includes("write"));
});

Deno.test("createDOOAuthFlow — exchangeCode with mock server", async () => {
  // Start a mock DO OAuth server
  const ac = new AbortController();
  const { promise: portReady, resolve: resolvePort } = Promise.withResolvers<number>();

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: (a) => resolvePort((a as Deno.NetAddr).port) },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "mock-access-token",
            refresh_token: "mock-refresh-token",
            expires_in: 3600,
            scope: "read write",
            token_type: "bearer",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/v2/account") {
        return new Response(
          JSON.stringify({
            account: { team: { uuid: "team-uuid-123" }, uuid: "acct-uuid", email: "test@test" },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  );

  const port = await portReady;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const flow = createDOOAuthFlow({
      clientId: "ci",
      clientSecret: "cs",
      redirectUri: "http://localhost/cb",
      authBaseUrl: baseUrl,
      apiBaseUrl: baseUrl,
    });

    const state = { state: "test-state-1" };
    const token = await flow.exchangeCode("test-auth-code", state);

    assertEquals(token.accessToken, "mock-access-token");
    assertEquals(token.refreshToken, "mock-refresh-token");
    assertEquals(token.teamUuid, "team-uuid-123");
    assertEquals(token.scope, "read write");
    assert(token.expiresAt > Date.now());
    assert(token.expiresAt <= Date.now() + 3601_000); // ~1h + buffer
  } finally {
    ac.abort();
  }
});

Deno.test("createDOOAuthFlow — refreshToken with mock server", async () => {
  const ac = new AbortController();
  const { promise: portReady, resolve: resolvePort } = Promise.withResolvers<number>();

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: (a) => resolvePort((a as Deno.NetAddr).port) },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 7200,
            scope: "read write",
            token_type: "bearer",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  );

  const port = await portReady;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const flow = createDOOAuthFlow({
      clientId: "ci",
      clientSecret: "cs",
      redirectUri: "http://localhost/cb",
      authBaseUrl: baseUrl,
      apiBaseUrl: baseUrl,
    });

    const refreshed = await flow.refreshToken({
      accessToken: "old-token",
      refreshToken: "old-refresh",
      teamUuid: "team-123",
      expiresAt: Date.now() - 1000, // expired
      scope: "read write",
    });

    assertEquals(refreshed.accessToken, "refreshed-access-token");
    assertEquals(refreshed.refreshToken, "new-refresh-token");
    assertEquals(refreshed.teamUuid, "team-123");
  } finally {
    ac.abort();
  }
});

Deno.test("createDOOAuthFlow — getTeamUuid", async () => {
  const ac = new AbortController();
  const { promise: portReady, resolve: resolvePort } = Promise.withResolvers<number>();

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: (a) => resolvePort((a as Deno.NetAddr).port) },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v2/account") {
        return new Response(
          JSON.stringify({
            account: { team: { uuid: "resolved-team-uuid" }, uuid: "u", email: "e" },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  );

  const port = await portReady;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const flow = createDOOAuthFlow({
      clientId: "ci",
      clientSecret: "cs",
      redirectUri: "http://localhost/cb",
      apiBaseUrl: baseUrl,
    });

    const teamUuid = await flow.getTeamUuid("some-access-token");
    assertEquals(teamUuid, "resolved-team-uuid");
  } finally {
    ac.abort();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOTokenStore — file-based tests
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("createDOFileTokenStore — save, load, list, delete", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "do-oauth-test-" });
  try {
    const store = createDOFileTokenStore(tmp);

    const token: DOTokenData = {
      accessToken: "at-1",
      refreshToken: "rt-1",
      teamUuid: "team-a",
      expiresAt: Date.now() + 3600_000,
      scope: "read write",
    };

    // Initially empty
    let teams = await store.listTeams();
    assertEquals(teams.length, 0);

    // Save and load
    await store.save(token);
    teams = await store.listTeams();
    assertEquals(teams, ["team-a"]);

    const loaded = await store.load("team-a");
    assertEquals(loaded?.accessToken, "at-1");
    assertEquals(loaded?.teamUuid, "team-a");

    // Load missing
    const missing = await store.load("team-b");
    assertEquals(missing, null);

    // Save second team
    await store.save({
      accessToken: "at-2",
      refreshToken: "rt-2",
      teamUuid: "team-b",
      expiresAt: Date.now() + 3600_000,
      scope: "read",
    });
    teams = await store.listTeams();
    assertEquals(teams.length, 2);

    // Delete
    await store.delete("team-a");
    teams = await store.listTeams();
    assertEquals(teams, ["team-b"]);
    assertEquals(await store.load("team-a"), null);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOTokenStore — SQLite (Deno KV) tests
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("createDOSqliteTokenStore — save, load, list, delete", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "do-oauth-kv-" });
  try {
    const store = createDOSqliteTokenStore(`${tmp}/tokens.db`);

    const token = {
      accessToken: "kv-at-1",
      refreshToken: "kv-rt-1",
      teamUuid: "kv-team-a",
      expiresAt: Date.now() + 3600_000,
      scope: "read write",
    };

    let teams = await store.listTeams();
    assertEquals(teams.length, 0);

    await store.save(token);
    teams = await store.listTeams();
    assertEquals(teams, ["kv-team-a"]);

    const loaded = await store.load("kv-team-a");
    assertEquals(loaded?.accessToken, "kv-at-1");

    await store.save({
      accessToken: "kv-at-2",
      refreshToken: "kv-rt-2",
      teamUuid: "kv-team-b",
      expiresAt: Date.now() + 3600_000,
      scope: "read",
    });
    teams = await store.listTeams();
    assertEquals(teams.length, 2);

    await store.delete("kv-team-a");
    teams = await store.listTeams();
    assertEquals(teams, ["kv-team-b"]);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("createDOSqliteTokenStore — in-memory", async () => {
  const store = createDOSqliteTokenStore(":memory:");

  await store.save({
    accessToken: "mem-at",
    refreshToken: "mem-rt",
    teamUuid: "mem-team",
    expiresAt: Date.now() + 3600_000,
    scope: "read write",
  });

  const loaded = await store.load("mem-team");
  assertEquals(loaded?.accessToken, "mem-at");

  const teams = await store.listTeams();
  assertEquals(teams, ["mem-team"]);

  await store.delete("mem-team");
  assertEquals(await store.load("mem-team"), null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOTokenHandle tests
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("createDOTokenHandle — resolve from store", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "do-oauth-handle-" });
  try {
    const store = createDOFileTokenStore(tmp);

    // Store a fresh token
    await store.save({
      accessToken: "handle-at",
      refreshToken: "handle-rt",
      teamUuid: "handle-team",
      expiresAt: Date.now() + 3600_000, // 1 hour from now
      scope: "read write",
    });

    const handle = createDOTokenHandle({
      flow: createDOOAuthFlow({ clientId: "ci", clientSecret: "cs", redirectUri: "http://localhost/cb" }),
      store,
      teamUuid: "handle-team",
    });

    const accessToken = await handle.resolve();
    assertEquals(accessToken, "handle-at");
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("createDOTokenHandle — resolve throws when no token", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "do-oauth-handle-" });
  try {
    const store = createDOFileTokenStore(tmp);
    const handle = createDOTokenHandle({
      flow: createDOOAuthFlow({ clientId: "ci", clientSecret: "cs", redirectUri: "http://localhost/cb" }),
      store,
    });

    await assertRejects(handle.resolve(), "No stored DO tokens");
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("createDOTokenHandle — refresh stale token with mock server", async () => {
  const ac = new AbortController();
  const { promise: portReady, resolve: resolvePort } = Promise.withResolvers<number>();

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: (a) => resolvePort((a as Deno.NetAddr).port) },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-by-handle",
            refresh_token: "new-rt",
            expires_in: 7200,
            scope: "read write",
            token_type: "bearer",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  );

  const port = await portReady;
  const baseUrl = `http://127.0.0.1:${port}`;

  const tmp = await Deno.makeTempDir({ prefix: "do-oauth-refresh-" });
  try {
    const store = createDOFileTokenStore(tmp);
    const flow = createDOOAuthFlow({
      clientId: "ci",
      clientSecret: "cs",
      redirectUri: "http://localhost/cb",
      authBaseUrl: baseUrl,
      apiBaseUrl: baseUrl,
    });

    // Store an expired token
    await store.save({
      accessToken: "expired-at",
      refreshToken: "expired-rt",
      teamUuid: "stale-team",
      expiresAt: Date.now() - 60_000, // 1 minute ago
      scope: "read write",
    });

    const handle = createDOTokenHandle({ flow, store, teamUuid: "stale-team" });
    const accessToken = await handle.resolve();
    assertEquals(accessToken, "refreshed-by-handle");
  } finally {
    ac.abort();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

async function assertRejects(promise: Promise<unknown>, expectedMessage: string) {
  try {
    await promise;
    throw new Error(`Expected rejection with "${expectedMessage}" but promise resolved`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes(expectedMessage)) {
      throw new Error(`Expected rejection containing "${expectedMessage}" but got "${msg}"`);
    }
  }
}
