import { Command } from "@publicdomainrelay/cli-args-env";
import { createLogger } from "@publicdomainrelay/logger";
import { createServe } from "@publicdomainrelay/serve";
import { createStaticFilesApp } from "@publicdomainrelay/hono-factory-static-files-fs";
import { EventBus } from "@publicdomainrelay/event-bus";
import type { AtprotoAgentLike } from "@publicdomainrelay/atproto-helpers";
import { createATProto } from "@publicdomainrelay/atproto-helpers";
import { createDigitalOceanComputeProvider } from "@publicdomainrelay/compute-provider-digitalocean";
import { createMarketBidder } from "@publicdomainrelay/market-bidder";
import { createComputeProviderHooks } from "@publicdomainrelay/market-bidder-compute";
import { createIngress } from "@publicdomainrelay/did-key-ingress-proxy";
import { loadOrGenerateKeypair } from "@publicdomainrelay/market-atproto";
import { createPlcDirectoryClient } from "@publicdomainrelay/did-plc";
import { createDefaultATProtoEventStreamsClient } from "@publicdomainrelay/atproto-event-streams-client";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
  createDOOAuthFlow,
  createDOTokenHandle,
  createDOState,
  type DOTokenData,
} from "@publicdomainrelay/digitalocean-oauth";
import { createBidderDbPglite } from "@publicdomainrelay/bidder-db-pglite";
import { createBidderDbPostgres } from "@publicdomainrelay/bidder-db-postgres";
import { createBidderManager } from "@publicdomainrelay/bidder-manager";
import type { BidderDb } from "@publicdomainrelay/bidder-db-abc";
import type { BidderManager, BidderManagerVMEvent } from "@publicdomainrelay/bidder-manager";
import type { AtprotoSessionRow, DOTokenRow } from "@publicdomainrelay/bidder-db-abc";
import { createBidderSessionJwt, generateSessionSecret } from "@publicdomainrelay/bidder-session-jwt";
import type { SessionStore } from "@publicdomainrelay/bidder-session-abc";
import { BIDDER_SESSION_COOKIE } from "@publicdomainrelay/bidder-session-common";
// Deno compat: NodeOAuthClient → unicastFetchWrap checks process.versions.undici >= 6.11.1.
// Deno's Node compat layer doesn't set undici version. Patch before import.
import process from "node:process";
(process.versions as Record<string, string>).undici ??= "6.11.1";

import { NodeOAuthClient } from "@atproto/oauth-client-node";
import { JoseKey } from "@atproto/jwk-jose";
import type { OAuthSession } from "@atproto/oauth-client-node";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

// ── Config ────────────────────────────────────────────────────────────────

let runtimeConfig: Record<string, unknown> | null = null;
try {
  runtimeConfig = (await import("./config.json", { with: { type: "json" } })).default;
} catch { /* optional */ }
const { options } = await new Command(
  "CONFIG_PATH_DIGITALOCEAN_BIDDER",
  cliArgsEnv,
  runtimeConfig,
).resolve();

const logger = createLogger({ serviceName: "digitalocean-bidder" });
const plcDirectoryUrl = (options.plcDirectoryUrl as string) || "https://plc.directory";

// ── Database ───────────────────────────────────────────────────────────────

const dbUri = (options.dbUri as string) || Deno.env.get("DATABASE_URI");
const dbPath = (options.dbPath as string) || "./data/pgdata";

let db: BidderDb;
if (dbUri) {
  logger.info("using_postgres", { host: new URL(dbUri).hostname });
  db = await createBidderDbPostgres({ connectionString: dbUri, logger });
} else {
  logger.info("using_pglite", { dataDir: dbPath });
  try { await Deno.mkdir(dbPath, { recursive: true }); } catch { /* exists */ }
  db = await createBidderDbPglite({ dataDir: dbPath, logger });
}
await db.migrate();

// ── Serve ──────────────────────────────────────────────────────────────────

const bidderServe = createServe({
  logger,
  tcp: { addr: (options.serveAddr as string) || "0.0.0.0", port: (options.servePort as number) ?? 0 },
});
await bidderServe.beginServe();
const serveBaseUrl = `http://127.0.0.1:${bidderServe.tcpPort}`;
logger.info("serve_started", { url: serveBaseUrl });

// ── Public origin (for OAuth metadata + callbacks) ─────────────────────────

const publicOrigin = (options.publicOrigin as string) || serveBaseUrl;
const isLocalhost = publicOrigin.startsWith("http://127.0.0.1") || publicOrigin.startsWith("http://localhost");
// ATProto localhost carveout: client_id must be http://localhost, redirect on 127.0.0.1
const clientMetadataUrl = isLocalhost
  ? "http://localhost"
  : `${publicOrigin}/oauth-client-metadata.json`;
const oauthRedirectUri = isLocalhost
  ? `${serveBaseUrl}/auth/atproto/callback`
  : `${publicOrigin}/auth/atproto/callback`;

// ── Static files ───────────────────────────────────────────────────────────

const staticApp = createStaticFilesApp(
  new URL("./static", import.meta.url).pathname,
  logger,
  new EventBus(),
);
bidderServe.app.route("/", staticApp);
bidderServe.app.get("/", (c) => c.redirect("/index.html"));

// ── OAuth scopes ───────────────────────────────────────────────────────────

const OAUTH_SCOPE_FULL = [
  "atproto",
  "repo:com.publicdomainrelay.temp.market.offering?action=create&action=update",
  "repo:com.publicdomainrelay.temp.auth.allowlist.rbacDid?action=create",
  "repo:com.publicdomainrelay.temp.market.bids.free?action=create",
  "repo:com.publicdomainrelay.temp.market.bid?action=create",
  "repo:com.publicdomainrelay.temp.market.receipt?action=create",
  "repo:com.publicdomainrelay.temp.market.event?action=create",
  "repo:com.publicdomainrelay.temp.market.accept?action=create",
  "repo:com.publicdomainrelay.temp.badgeBlueKeys?action=create",
  "repo:com.publicdomainrelay.temp.market.bidderAssociation?action=create",
  "repo:com.publicdomainrelay.temp.compute.config.wif.simple?action=create",
  "repo:com.publicdomainrelay.temp.compute.vm?action=create",
  "repo:com.publicdomainrelay.temp.market.rfp?action=create",
  "repo:com.publicdomainrelay.temp.compute.events.vm.delete?action=create",
  "repo:com.publicdomainrelay.temp.compute.events.vm.onNetwork?action=create",
  "repo:com.fedproxy.rbac?action=create",
  "rpc:com.publicdomainrelay.temp.market.submitRfp?aud=*",
  "rpc:com.publicdomainrelay.temp.market.submitAccept?aud=*",
  "rpc:com.publicdomainrelay.temp.market.submitBid?aud=*",
  "rpc:com.publicdomainrelay.temp.market.submitEvent?aud=*",
].join(" ");

// ── Server secrets ─────────────────────────────────────────────────────────

async function loadOrCreateSecret(key: string, generate: () => string): Promise<string> {
  const existing = await db.getServerConfig(key);
  if (existing) return existing;
  const value = generate();
  await db.setServerConfig(key, value);
  return value;
}

const sessionSecret = await loadOrCreateSecret("sessionSecret", generateSessionSecret);

// ── Policy mode ────────────────────────────────────────────────────────────

import { isValidPolicyMode, type PolicyMode, POLICY_MODES } from "@publicdomainrelay/market-policy-abc";

async function getPolicyMode(): Promise<PolicyMode> {
  const stored = await db.getServerConfig("policyMode");
  if (isValidPolicyMode(stored)) return stored;
  const fromOpts = options.policyMode as string | undefined;
  if (isValidPolicyMode(fromOpts)) return fromOpts;
  return "only-me";
}

async function setPolicyMode(mode: PolicyMode): Promise<void> {
  await db.setServerConfig("policyMode", mode);
}

// ── Client attestation key (confidential client) ───────────────────────────

let clientAttestationKey: JoseKey;
const storedJwk = await db.getServerConfig("clientAttestationKey");
if (storedJwk) {
  clientAttestationKey = await JoseKey.fromJWK(JSON.parse(storedJwk));
} else {
  // Generate with temp kid so publicJwk getter works, then compute real kid
  clientAttestationKey = await JoseKey.generate(["ES256"], "temp");
  const realKid = await computeJwkKid(clientAttestationKey.publicJwk);
  // Re-create key with real kid
  clientAttestationKey = await JoseKey.fromJWK({ ...clientAttestationKey.privateJwk, kid: realKid });
  await db.setServerConfig("clientAttestationKey", JSON.stringify(clientAttestationKey.privateJwk));
}

// deno-lint-ignore no-explicit-any
async function computeJwkKid(publicJwk: any): Promise<string> {
  const { kid: _k, kty, crv, x, y, ..._rest } = publicJwk as Record<string, string>;
  const canonical = JSON.stringify({ crv, kty, x, y });
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const kid = clientAttestationKey.kid ?? await computeJwkKid(clientAttestationKey.publicJwk);
const jwksUri = `${publicOrigin}/jwks.json`;

// ── Session store ──────────────────────────────────────────────────────────

const sessionStore: SessionStore = createBidderSessionJwt({ secret: sessionSecret });

// ── NodeOAuthClient ────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
const oauthClientOpts: any = {
  clientMetadata: {
    client_id: clientMetadataUrl,
    application_type: "web",
    dpop_bound_access_tokens: true,
    redirect_uris: [oauthRedirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: OAUTH_SCOPE_FULL,
    token_endpoint_auth_method: isLocalhost ? "none" : "none",
  },
};
// Localhost needs allowHttp for non-HTTPS origins
if (isLocalhost) {
  oauthClientOpts.allowHttp = true;
}

const oauthClient = new NodeOAuthClient({
  ...oauthClientOpts,
  // deno-lint-ignore no-explicit-any
  stateStore: {
    async set(key: string, internalState: any) {
      await db.setServerConfig(`oauth_state:${key}`, JSON.stringify(internalState));
    },
    async get(key: string) {
      const raw = await db.getServerConfig(`oauth_state:${key}`);
      return raw ? (JSON.parse(raw) as any) : undefined;
    },
    async del(key: string) {
      await db.execute(`DELETE FROM server_config WHERE key = $1`, [`oauth_state:${key}`]);
    },
  } as any,
  // deno-lint-ignore no-explicit-any
  sessionStore: {
    async set(sub: string, sessionData: any) {
      const existing = await db.getAtprotoSession(sub);
      // Keep existing handle if present, otherwise use DID (will be updated by callback)
      const handle = existing?.handle && existing.handle !== existing.did ? existing.handle : sub;
      const pds = sessionData?.server?.issuer as string ?? existing?.pds ?? "";
      await db.upsertAtprotoSessionNode(sub, handle, pds, sessionData as Record<string, unknown>);
    },
    async get(sub: string) {
      const result = await db.getAtprotoSessionNode(sub);
      return result as any;
    },
    async del(sub: string) {
      await db.deleteAtprotoSession(sub);
    },
  } as any,
  // In-process request lock — sufficient for PGlite (single process).
  // For Postgres multi-process, use pg_advisory_lock (TODO: wire via db.isPostgres flag).
  requestLock: undefined,
  // deno-lint-ignore no-explicit-any
  identityResolver: {
    resolve: async (identifier: string) => {
      const { IdResolver } = await import("@atproto/identity");
      const resolver = new IdResolver({ plcUrl: plcDirectoryUrl });
      const did = identifier.startsWith("did:") ? identifier : (await resolver.handle.resolve(identifier)) ?? identifier;
      // deno-lint-ignore no-explicit-any
      const didDoc = await resolver.did.resolve(did) as Record<string, unknown>;
      const h = ((didDoc?.alsoKnownAs as string[] | undefined)?.[0] ?? "").replace("at://", "");
      return { did, didDoc, handle: h || "handle.invalid" };
    },
  } as never,
});

// ── JWKS endpoint ──────────────────────────────────────────────────────────

bidderServe.app.get("/jwks.json", async (c) => {
  // deno-lint-ignore no-explicit-any
  return c.json({ keys: [clientAttestationKey.publicJwk as any] });
});

// ── OAuth client metadata endpoint ─────────────────────────────────────────

bidderServe.app.get("/oauth-client-metadata.json", (c) => {
  // deno-lint-ignore no-explicit-any
  return c.json(oauthClient.clientMetadata as Record<string, any>);
});

// ── DO OAuth state (per-DID) ───────────────────────────────────────────────

const doOAuthStates = new Map<string, { state: string; did: string }>();

// ── BidderManager ──────────────────────────────────────────────────────────

let bidderManager: BidderManager | null = null;
const ingressProxyHost = (options.ingressProxyHost as string) || "xrpc.fedproxy.com";

async function getOrCreateBidderManager(): Promise<BidderManager> {
  if (bidderManager) return bidderManager;

  bidderManager = createBidderManager({
    db, logger, plcDirectoryUrl,

    async createOAuthAgent(session: AtprotoSessionRow) {
      const oauthSession = await oauthClient.restore(session.did);
      // deno-lint-ignore no-explicit-any
      const agent = createOAuthAgentWrapper(oauthSession) as Record<string, unknown>;
      return { agent, dispose: () => {} };
    },

    async createDOTokenHandle(token: DOTokenRow) {
      const doClientId = (options.doOauthClientId as string) || "";
      const doClientSecret = (options.doOauthClientSecret as string) || "";
      const flow = createDOOAuthFlow({
        clientId: doClientId,
        clientSecret: doClientSecret,
        redirectUri: (options.doOauthRedirectUri as string) || `${serveBaseUrl}/auth/digitalocean/callback`,
      });
      const store = {
        async load(teamUuid: string) {
          const row = await db.getDOToken(teamUuid);
          if (!row) return null;
          return { accessToken: row.access_token, refreshToken: row.refresh_token, teamUuid: row.team_uuid, expiresAt: row.expires_at, scope: row.scope };
        },
        async save(t: DOTokenData) {
          await db.upsertDOToken({ team_uuid: t.teamUuid, access_token: t.accessToken, refresh_token: t.refreshToken, expires_at: t.expiresAt, scope: t.scope, owner_did: token.owner_did });
        },
        async delete() {},
        async listTeams() { return []; },
      };
      return createDOTokenHandle({ flow, store, logger, teamUuid: token.team_uuid });
    },

    async createDOProvider(opts2) {
      // deno-lint-ignore no-explicit-any
      return createDigitalOceanComputeProvider({
        logger,
        atproto: opts2.atproto as never,
        serve: opts2.serve as never,
        getIssuerUrl: () => opts2.ingressUrl,
        digitaloceanBaseUrl: (options.computeProviderDoBaseUrl as string) || "https://api.digitalocean.com",
        doToken: opts2.doToken as never,
      }) as any;
    },

    async createIngress() {
      const relayKp = await Secp256k1Keypair.create({ exportable: true });
      // deno-lint-ignore no-explicit-any
      const signer = {
        did: () => relayKp.did(),
        sign: async (bytes: Uint8Array) => relayKp.sign(bytes),
      };
      return createIngress({ logger, ingressProxyHost, signer, keypair: relayKp });
    },

    async createATProto(opts2) {
      const plcClient = createPlcDirectoryClient({ plcDirectoryUrl });
      const badgeKp = await Secp256k1Keypair.create({ exportable: true });
      const bytes = await badgeKp.export();
      const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
      // deno-lint-ignore no-explicit-any
      return createATProto({
        logger,
        badgeBlueSigner: await loadOrGenerateKeypair(hex),
        plcDirectory: plcClient,
        agent: opts2.agent as any,
      }) as any;
    },

    // deno-lint-ignore no-explicit-any
    createMarketBidder: (opts2) => createMarketBidder({ ...opts2, atproto: opts2.atproto as any, providers: opts2.providers as any, eventStreams: opts2.eventStreams as any, acceptToContract: opts2.acceptToContract as any, onContractChange: opts2.onContractChange as any }) as any,

    // deno-lint-ignore no-explicit-any
    createEventStreams: () => createDefaultATProtoEventStreamsClient({ additionalRelays: (options.relayUrl as string) ? [(options.relayUrl as string)] : [], log: logger }) as any,

    digitaloceanBaseUrl: (options.computeProviderDoBaseUrl as string) || "https://api.digitalocean.com",
    offeringRefreshSec: (options.offeringRefreshSec as number) ?? 300,
    firehoseMode: (options.firehoseMode as string) || "off",
    noIngressProxy: !!(options.noIngressProxy as boolean),
  });

  await bidderManager.start();
  return bidderManager;
}

// ── OAuth agent wrapper ────────────────────────────────────────────────────

function createOAuthAgentWrapper(session: OAuthSession): unknown {
  const issuer = session.server.issuer.replace(/\/+$/, "");
  return {
    did: session.did,
    signer: {
      did: () => session.did,
      sign: async () => { throw new Error("OAuth agent uses getServiceAuth, not local signing"); },
    },
    async getServiceAuth(aud: string, lxm?: string): Promise<string> {
      const res = await session.fetchHandler(
        `${issuer}/xrpc/com.atproto.server.getServiceAuth`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aud, lxm: lxm ?? aud }) },
      );
      if (!res.ok) throw new Error(`getServiceAuth failed: ${res.status}`);
      return ((await res.json()) as { token: string }).token;
    },
    async applyWrites(repo: string, writes: Array<{ action: string; collection: string; rkey: string; record?: unknown }>) {
      const res = await session.fetchHandler(`${issuer}/xrpc/com.atproto.repo.applyWrites`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, writes: writes.map((w) => ({
          action: w.action, collection: w.collection, rkey: w.rkey,
          ...(w.action !== "delete" ? { value: (w as { record: unknown }).record } : {}),
        })) }),
      });
      if (!res.ok) throw new Error(`applyWrites failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { commit?: { rev?: string } };
      return { repo, commit: data.commit?.rev ?? "", rev: data.commit?.rev ?? "", since: null, blocks: new Uint8Array(), ops: [] };
    },
    async getRecord(repo: string, collection: string, rkey: string) {
      const params = new URLSearchParams({ repo, collection, rkey });
      const res = await session.fetchHandler(`${issuer}/xrpc/com.atproto.repo.getRecord?${params}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { uri: string; cid?: string; value: Record<string, unknown> };
      return { uri: data.uri, cid: data.cid ?? "", value: data.value };
    },
    async createRecord(repo: string, collection: string, rkey: string, record: Record<string, unknown>) {
      const res = await session.fetchHandler(`${issuer}/xrpc/com.atproto.repo.createRecord`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, collection, rkey, record }),
      });
      if (!res.ok) throw new Error(`createRecord failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as { uri: string; cid: string };
    },
    async putRecord(repo: string, collection: string, rkey: string, record: Record<string, unknown>) {
      const res = await session.fetchHandler(`${issuer}/xrpc/com.atproto.repo.putRecord`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, collection, rkey, record }),
      });
      if (!res.ok) throw new Error(`putRecord failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as { uri: string; cid: string };
    },
    async listRecords(repo: string, collection: string, opts?: { limit?: number }) {
      const all: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
      let cursor: string | undefined;
      const limit = opts?.limit ?? 100;
      do {
        const params = new URLSearchParams({ repo, collection, limit: String(limit) });
        if (cursor) params.set("cursor", cursor);
        const res = await session.fetchHandler(`${issuer}/xrpc/com.atproto.repo.listRecords?${params}`);
        if (!res.ok) break;
        const data = (await res.json()) as { records: Array<{ uri: string; cid?: string; value: unknown }>; cursor?: string };
        for (const r of data.records) all.push({ uri: r.uri, cid: r.cid ?? "", value: r.value as Record<string, unknown> });
        cursor = data.cursor;
      } while (cursor);
      return { records: all.slice(0, limit) };
    },
  };
}

// ── Cookie helper ──────────────────────────────────────────────────────────

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    result[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return result;
}

async function cookieSetCookie(did: string, handle: string): Promise<string> {
  const jwt = await sessionStore.createSession(did, handle);
  return `${BIDDER_SESSION_COOKIE}=${jwt}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
}

// ── Auth middleware ─────────────────────────────────────────────────────────

async function getSessionPayload(c: { req: { header(name: string): string | undefined } }): Promise<{ did: string; handle: string } | null> {
  const cookieHeader = c.req.header("cookie") || c.req.header("Cookie") || "";
  const cookies = parseCookies(cookieHeader);
  const token = cookies[BIDDER_SESSION_COOKIE];
  if (!token) return null;
  const payload = await sessionStore.verifySession(token);
  if (!payload) return null;
  return { did: payload.did, handle: payload.handle };
}

async function getSessionDid(c: { req: { header(name: string): string | undefined } }): Promise<string | null> {
  const session = await getSessionPayload(c);
  return session?.did ?? null;
}

function unauth(c: { json(obj: unknown, status?: number): Response }): Response {
  return c.json({ error: "Unauthorized" }, 401);
}

async function tryAutoStartBidder(ownerDid: string) {
  if (!bidderManager) {
    bidderManager = await getOrCreateBidderManager();
  }
  const existing = bidderManager.getBidders().filter((b) => b.instance.atprotoDid === ownerDid);
  if (existing.length) return;

  const atprotoSession = await db.getAtprotoSession(ownerDid);
  if (!atprotoSession) return;

  const doToken = await db.getDOTokenByOwner(ownerDid);
  if (!doToken) return;

  try {
    const instance = await bidderManager.addAccountPair({
      atprotoSession,
      doToken,
      ownerDid,
    });
    logger.info("bidder_auto_started", { did: ownerDid, bidderKeyId: instance.id });
  } catch (err) {
    logger.error("bidder_auto_start_failed", { did: ownerDid, error: String(err) });
  }
}

// ── API routes (authenticated) ─────────────────────────────────────────────

bidderServe.app.get("/api/status", async (c) => {
  const session = await getSessionPayload(c);
  if (!session) return unauth(c);

  const allBidders = bidderManager?.getBidders() ?? [];
  const bidders = allBidders.filter((b) => b.instance.atprotoDid === session.did);
  const activeContracts = bidderManager ? await bidderManager.getActiveContracts() : [];

  // DO status: check bidders first, fall back to DB by owner DID
  let doReady = bidders.length > 0;
  let doTeamUuid: string | undefined = bidders[0]?.instance.doTeamUuid;
  if (!doReady) {
    const doToken = await db.getDOTokenByOwner(session.did);
    if (doToken) {
      doReady = true;
      doTeamUuid = doToken.team_uuid;
    }
  }

  return c.json({
    atpReady: true,
    atpHandle: bidders[0]?.instance.atprotoHandle ?? session.handle,
    atpDid: session.did,
    doReady,
    doTeamUuid,
    doConfigured: !!(options.doOauthClientId && options.doOauthClientSecret),
    bidders: bidders.map((b) => ({
      id: b.instance.id,
      atprotoDid: b.instance.atprotoDid,
      atprotoHandle: b.instance.atprotoHandle,
      doTeamUuid: b.instance.doTeamUuid,
      status: b.instance.status,
      contracts: b.instance.contracts,
      activeVms: b.instance.activeVms,
      errorMessage: b.instance.errorMessage,
    })),
    activeVms: activeContracts
      .filter((c) => bidders.some((b) => b.instance.id === c.bidder_key_id))
      .map((c) => ({ vmId: c.vm_id, requesterDid: c.requester_did, requesterHandle: c.requester_handle, status: c.status, createdAt: c.created_at })),
    serveBaseUrl,
    publicOrigin,
    policyMode: await getPolicyMode(),
  });
});

bidderServe.app.post("/api/policy", async (c) => {
  const sessionDid = await getSessionDid(c);
  if (!sessionDid) return unauth(c);
  let body: Record<string, unknown> = {};
  try { body = await c.req.json() as Record<string, unknown>; } catch { /* ignore */ }
  const mode = body.policyMode as string;
  if (!isValidPolicyMode(mode)) {
    return c.json({ error: `Invalid policy mode. Must be one of: ${POLICY_MODES.join(", ")}` }, 400);
  }
  await setPolicyMode(mode as PolicyMode);
  logger.info("policy_mode_changed", { did: sessionDid, policyMode: mode });
  return c.json({ ok: true, policyMode: mode });
});

bidderServe.app.post("/api/bidder/:id/retry", async (c) => {
  const sessionDid = await getSessionDid(c);
  if (!sessionDid) return unauth(c);
  if (!bidderManager) return c.json({ error: "Bidder manager not ready" }, 503);
  const id = parseInt(c.req.param("id"));
  const bidders = bidderManager.getBidders().filter((b) => b.instance.id === id && b.instance.atprotoDid === sessionDid);
  if (!bidders.length) return c.json({ error: "Bidder not found" }, 404);
  await bidderManager.retryBidder(id);
  return c.json({ ok: true });
});

bidderServe.app.post("/api/bidder/:id/remove", async (c) => {
  const sessionDid = await getSessionDid(c);
  if (!sessionDid) return unauth(c);
  if (!bidderManager) return c.json({ error: "Bidder manager not ready" }, 503);
  const id = parseInt(c.req.param("id"));
  const bidders = bidderManager.getBidders().filter((b) => b.instance.id === id && b.instance.atprotoDid === sessionDid);
  if (!bidders.length) return c.json({ error: "Bidder not found" }, 404);
  await bidderManager.removeBidder(id);
  return c.json({ ok: true });
});

bidderServe.app.post("/api/bidder/start", async (c) => {
  const sessionDid = await getSessionDid(c);
  if (!sessionDid) return unauth(c);

  const mgr = bidderManager ?? await getOrCreateBidderManager();

  // Check if already running for this DID
  const existing = mgr.getBidders().filter((b) => b.instance.atprotoDid === sessionDid);
  if (existing.length) {
    return c.json({ ok: true, bidderKeyId: existing[0].instance.id, alreadyRunning: true });
  }

  // Get sessions from DB
  const atprotoSession = await db.getAtprotoSession(sessionDid);
  if (!atprotoSession) return c.json({ error: "ATProto session not found. Login with Bluesky first." }, 400);

  // Find DO token for this owner
  const doToken = await db.getDOTokenByOwner(sessionDid);
  if (!doToken) return c.json({ error: "DO token not found. Login with DigitalOcean first." }, 400);

  // Persist and start
  const instance = await mgr.addAccountPair({
    atprotoSession,
    doToken,
    ownerDid: sessionDid,
  });

  logger.info("bidder_started_manual", { did: sessionDid, bidderKeyId: instance.id });
  return c.json({ ok: true, bidderKeyId: instance.id });
});

// ── XRPC: subscribeVms (WebSocket, authenticated) ──────────────────────────

bidderServe.app.get("/xrpc/com.publicdomainrelay.temp.bidder.subscribeVms", async (c) => {
  const sessionDid = await getSessionDid(c);
  if (!sessionDid) return unauth(c);

  if ((c.req.header("upgrade") ?? "").toLowerCase() !== "websocket") {
    return c.json({ error: "WebSocket upgrade required" }, 426);
  }
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  let closed = false;
  socket.onopen = async () => {
    if (bidderManager) {
      const allContracts = await bidderManager.getActiveContracts();
      const bidders = bidderManager.getBidders().filter((b) => b.instance.atprotoDid === sessionDid);
      const bidderIds = new Set(bidders.map((b) => b.instance.id));
      const myContracts = allContracts.filter((c) => bidderIds.has(c.bidder_key_id));
      socket.send(JSON.stringify({ type: "snapshot", vms: myContracts.map((c) => ({ vmId: c.vm_id, requesterDid: c.requester_did, requesterHandle: c.requester_handle, status: c.status, provisionedAt: c.provisioned_at })) }));
    }
    if (bidderManager) {
      // deno-lint-ignore no-explicit-any
      const unsub = (bidderManager as any).vmEvents?.subscribe?.((event: BidderManagerVMEvent) => {
        if (closed) return;
        const bidders = bidderManager?.getBidders().filter((b) => b.instance.atprotoDid === sessionDid) ?? [];
        const bidderIds = new Set(bidders.map((b) => b.instance.id));
        if (!bidderIds.has(event.bidderKeyId)) return;
        socket.send(JSON.stringify({ type: "update", vm: { vmId: event.vmId, requesterDid: event.requesterDid, requesterHandle: event.requesterHandle, eventType: event.type, at: event.at } }));
      });
      socket.onclose = () => { closed = true; unsub?.(); };
    }
  };
  return response;
});

// ── XRPC: getContracts (paginated, authenticated) ──────────────────────────

bidderServe.app.get("/xrpc/com.publicdomainrelay.temp.bidder.getContracts", async (c) => {
  const sessionDid = await getSessionDid(c);
  if (!sessionDid) return unauth(c);
  if (!bidderManager) return c.json({ error: "Bidder manager not ready" }, 503);
  const bidderKeyId = parseInt(c.req.query("bidderKeyId") ?? "0");
  const limit = parseInt(c.req.query("limit") ?? "50");
  const cursor = c.req.query("cursor");

  // Verify this bidder belongs to session
  const bidders = bidderManager.getBidders().filter((b) => b.instance.id === bidderKeyId && b.instance.atprotoDid === sessionDid);
  if (!bidders.length && bidderKeyId !== 0) return c.json({ error: "Bidder not found" }, 404);

  const result = await bidderManager.getContracts(bidderKeyId || 0, { limit, cursor: cursor ? parseInt(cursor) : undefined });
  return c.json({
    contracts: result.contracts.map((ct) => ({ id: ct.id, uri: ct.contract_uri, requesterDid: ct.requester_did, requesterHandle: ct.requester_handle, rfpUri: ct.rfp_uri, vmId: ct.vm_id, status: ct.status, provisionedAt: ct.provisioned_at, completedAt: ct.completed_at, createdAt: ct.created_at })),
    cursor: result.cursor?.toString() ?? null,
  });
});

// ── ATProto OAuth ──────────────────────────────────────────────────────────

bidderServe.app.get("/auth/atproto/login", async (c) => {
  const handle = c.req.query("handle");
  if (handle) {
    try {
      logger.info("atproto_oauth_start", { handle, source: "query" });
      const authUrl = await oauthClient.authorize(handle, { scope: OAUTH_SCOPE_FULL, state: handle });
      logger.info("atproto_oauth_redirect", { handle, authUrl: String(authUrl).slice(0, 120) });
      return c.redirect(String(authUrl));
    } catch (err) {
      logger.error("atproto_oauth_start_failed", { handle, error: String(err) });
      return c.html(`<h2>ATProto OAuth start failed</h2><p>${esc(String(err))}</p>`, 500);
    }
  }
  return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ATProto Login</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;}
.card{background:#1e293b;padding:32px;border-radius:12px;max-width:400px;width:100%;}
h1{font-size:20px;margin-bottom:8px}input{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:14px;margin:12px 0}
button{width:100%;padding:10px;border-radius:8px;border:none;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#2563eb}</style></head><body>
<div class="card"><h1>AT Protocol Login</h1>
<p style="color:#94a3b8;font-size:14px;margin-bottom:12px;">Enter your handle to continue</p>
<form method="POST" action="/auth/atproto/login">
<input type="text" name="handle" placeholder="alice.bsky.social" required autofocus>
<button type="submit">Login with Bluesky</button>
</form></div></body></html>`);
});

bidderServe.app.post("/auth/atproto/login", async (c) => {
  const body = await c.req.parseBody();
  const handle = (body.handle as string)?.trim();
  if (!handle) return c.html("<h2>Handle required</h2>", 400);
  try {
    logger.info("atproto_oauth_start", { handle, source: "form" });
    const authUrl = await oauthClient.authorize(handle, { scope: OAUTH_SCOPE_FULL, state: handle });
    logger.info("atproto_oauth_redirect", { handle, authUrl: String(authUrl).slice(0, 120) });
    return c.redirect(String(authUrl));
  } catch (err) {
    logger.error("atproto_oauth_start_failed", { handle, error: String(err) });
    return c.html(`<h2>ATProto OAuth start failed</h2><p>${esc(String(err))}</p>`, 500);
  }
});

bidderServe.app.get("/auth/atproto/callback", async (c) => {
  const url = new URL(c.req.url);
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) params.append(k, v);
  logger.info("atproto_oauth_callback_received", { hasCode: params.has("code"), hasState: params.has("state"), hasIss: params.has("iss") });

  try {
    const { session, state } = await oauthClient.callback(params);
    const did: string = session.did;
    // Handle from state (passed through authorize), or resolve from DID
    let handle: string = state ?? "";
    if (!handle || handle === did) {
      // Resolve handle from DID via PDS
      try {
        const { IdResolver } = await import("@atproto/identity");
        const resolver = new IdResolver({ plcUrl: plcDirectoryUrl });
        const didDoc = await resolver.did.resolve(did) as Record<string, unknown>;
        handle = ((didDoc?.alsoKnownAs as string[] | undefined)?.[0] ?? "").replace("at://", "");
        logger.info("atproto_oauth_handle_resolved", { did, handle, from: "didDoc" });
      } catch {
        handle = did;
        logger.warn("atproto_oauth_handle_resolve_failed", { did });
      }
    }

    logger.info("atproto_oauth_complete", { did, handle, pds: session.server?.issuer });

    // Store handle in session row (sessionStore.set only had DID at creation time)
    try {
      await db.execute(
        `UPDATE atproto_sessions SET handle = $1 WHERE did = $2`,
        [handle, did],
      );
    } catch { /* best-effort */ }

    const cookie = await cookieSetCookie(did, handle);
    // Auto-start bidder if DO token also present
    tryAutoStartBidder(did);
    return new Response(null, {
      status: 302,
      headers: {
        "Location": "/",
        "Set-Cookie": cookie,
      },
    });
  } catch (err) {
    logger.error("atproto_oauth_callback_failed", { error: String(err), stack: (err as Error).stack?.slice(0, 200) });
    return c.html(`<h2>ATProto OAuth callback failed</h2><p>${esc(String(err))}</p>`, 500);
  }
});

// ── DigitalOcean OAuth ─────────────────────────────────────────────────────

bidderServe.app.get("/auth/digitalocean/login", async (c) => {
  const sessionDid = await getSessionDid(c);
  if (!sessionDid) return c.html("<h2>Not authenticated. Login with Bluesky first.</h2>", 401);

  const doClientId = (options.doOauthClientId as string) || "";
  const doClientSecret = (options.doOauthClientSecret as string) || "";
  if (!doClientId || !doClientSecret) return c.html("<h2>DigitalOcean OAuth not configured.</h2>", 400);

  const flow = createDOOAuthFlow({
    clientId: doClientId,
    clientSecret: doClientSecret,
    redirectUri: (options.doOauthRedirectUri as string) || `${serveBaseUrl}/auth/digitalocean/callback`,
  });
  const doState = createDOState();
  doOAuthStates.set(doState.state, { state: doState.state, did: sessionDid });

  return c.redirect(flow.authorizeUrl(doState));
});

bidderServe.app.get("/auth/digitalocean/callback", async (c) => {
  const sessionDid = await getSessionDid(c);
  if (!sessionDid) return c.html("<h2>Not authenticated. Login with Bluesky first.</h2>", 401);

  const doClientId = (options.doOauthClientId as string) || "";
  const doClientSecret = (options.doOauthClientSecret as string) || "";
  if (!doClientId || !doClientSecret) return c.html("<h2>DigitalOcean OAuth not configured.</h2>", 400);

  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  if (!code) return c.html("<h2>Missing authorization code</h2>", 400);

  const saved = stateParam ? doOAuthStates.get(stateParam) : undefined;
  if (!saved || saved.did !== sessionDid) {
    return c.html("<h2>State mismatch — CSRF check failed</h2>", 403);
  }
  doOAuthStates.delete(stateParam!);

  const flow = createDOOAuthFlow({
    clientId: doClientId,
    clientSecret: doClientSecret,
    redirectUri: (options.doOauthRedirectUri as string) || `${serveBaseUrl}/auth/digitalocean/callback`,
  });

  try {
    const token = await flow.exchangeCode(code, saved);
    // Persist to DB with owner association
    await db.upsertDOToken({ team_uuid: token.teamUuid, access_token: token.accessToken, refresh_token: token.refreshToken, expires_at: token.expiresAt, scope: token.scope, owner_did: sessionDid });
    logger.info("do_oauth_complete", { teamUuid: token.teamUuid, did: sessionDid });

    // Auto-start bidder if ATProto session also ready
    tryAutoStartBidder(sessionDid);

    return c.html(loginCompleteHtml("DigitalOcean Login Complete", `Team: <strong>${esc(token.teamUuid)}</strong>`));
  } catch (err) {
    logger.error("do_oauth_callback_failed", { error: String(err) });
    return c.html(`<h2>DigitalOcean OAuth failed</h2><p>${esc(String(err))}</p>`, 500);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function loginCompleteHtml(title: string, detail: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;text-align:center;}
.card{background:#1e293b;padding:40px;border-radius:12px;max-width:420px;}
h1{color:#22c55e;margin-bottom:8px}p{color:#94a3b8;font-size:14px}a{color:#60a5fa}</style></head><body>
<div class="card"><h1>&#10003; ${esc(title)}</h1><p>${detail}</p><p><a href="/">Return to dashboard</a></p></div>
<script>setTimeout(()=>{window.opener?.location?.reload();},500);</script></body></html>`;
}

// ── Startup ────────────────────────────────────────────────────────────────

try { await getOrCreateBidderManager(); } catch (err) { logger.warn("bidder_manager_startup_error", { error: String(err) }); }

// Auto-start bidders for all sessions that have both ATProto and DO tokens.
// Also fix up handles that were stored as DIDs (from early sessionStore.set calls).
try {
  const sessions = await db.listAtprotoSessions();
  for (const s of sessions) {
    if (!s.handle || s.handle === s.did) {
      try {
        const { IdResolver } = await import("@atproto/identity");
        const resolver = new IdResolver({ plcUrl: plcDirectoryUrl });
        const didDoc = await resolver.did.resolve(s.did) as Record<string, unknown>;
        const resolvedHandle = ((didDoc?.alsoKnownAs as string[] | undefined)?.[0] ?? "").replace("at://", "");
        if (resolvedHandle && resolvedHandle !== s.did) {
          await db.execute(`UPDATE atproto_sessions SET handle = $1 WHERE did = $2`, [resolvedHandle, s.did]);
          logger.info("handle_fixed_at_startup", { did: s.did, handle: resolvedHandle });
        }
      } catch { /* best-effort */ }
    }
    await tryAutoStartBidder(s.did);
  }
} catch (err) { logger.warn("bidder_startup_auto_start_error", { error: String(err) }); }

function shutdown() { logger.info("shutting_down"); bidderManager?.shutdown(); Deno.exit(); }
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

console.log(JSON.stringify({ event: "bidder_ready", servePort: bidderServe.tcpPort, serveBaseUrl }));
console.log(`\n  Dashboard: ${serveBaseUrl}\n`);

await new Promise(() => {});
