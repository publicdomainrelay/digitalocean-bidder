// Layer 2 — BidderManager implementation. Orchestrates multiple MarketBidder
// instances, one per (atproto, do) account pair. Handles lifecycle, health
// monitoring, restart with backoff, contract tracking, and token refresh.

import type { BidderDb } from "@publicdomainrelay/bidder-db-abc";
import type {
  BidderManager,
  BidderManagerOptions,
  BidderInstance,
  BidderRef,
  BidderStatus,
  AtprotoSessionRow,
  DOTokenRow,
  ContractRow,
} from "@publicdomainrelay/bidder-manager-abc";
import type { StructuredLoggerInterface } from "@publicdomainrelay/logger";
import type { ServeHandle } from "@publicdomainrelay/serve";
import type { IngressRef } from "@publicdomainrelay/serve";
import type { MarketBidderProviderRef } from "@publicdomainrelay/market-bidder-abc";
import type { ComputeAtproto } from "@publicdomainrelay/compute-provider-abc";
import { EventBus } from "@publicdomainrelay/event-bus";

export type {
  BidderManager,
  BidderManagerOptions,
  BidderInstance,
  BidderRef,
  BidderStatus,
};

export interface BidderManagerDeps {
  db: BidderDb;
  logger: StructuredLoggerInterface;
  /** Factory: given a session, create an OAuth agent. */
  createOAuthAgent: (session: AtprotoSessionRow) => Promise<{
    agent: Record<string, unknown>;
    dispose?: () => void;
  }>;
  /** Factory: given a DO token, create a DO token handle. */
  createDOTokenHandle: (token: DOTokenRow) => Promise<{
    resolve: () => Promise<string>;
    proactiveRefresh: () => Promise<void>;
    current: () => { accessToken: string } | null;
    dispose?: () => void;
  }>;
  /** Factory: create a DigitalOcean compute provider for a bidder. */
  createDOProvider: (opts: {
    doToken: string;
    atproto: ComputeAtproto;
    serve: ServeHandle;
    /** Live getter — relay ingressUrl populated after beginServe/relay-connect. */
    getIngressUrl: () => string;
    acceptToContract: Map<string, unknown>;
    createSignedRepoRecord: (collection: string, record: Record<string, unknown>) => Promise<{ $type: string; uri: string; cid: string }>;
    callService: (url: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
  }) => Promise<Record<string, unknown>>;
  /** Factory: create an ingress relay for a bidder. */
  createIngress: () => Promise<IngressRef>;
  /** Factory: create ATProto wrapper. */
  createATProto: (opts: {
    agent: Record<string, unknown>;
    logger: StructuredLoggerInterface;
    plcDirectoryUrl: string;
  }) => Promise<Record<string, unknown>>;
  /** Factory: create a MarketBidder instance. */
  createMarketBidder: (opts: {
    logger: StructuredLoggerInterface;
    atproto: Record<string, unknown>;
    providers: MarketBidderProviderRef[];
    relay?: IngressRef;
    serve: ServeHandle;
    eventStreams: Record<string, unknown>;
    offeringRefreshMs?: number;
    acceptToContract: Map<string, unknown>;
    // deno-lint-ignore no-explicit-any
    onContractChange?: (event: Record<string, any>) => void;
  }) => Promise<{
    beginServe: () => Promise<void>;
    shutdown: () => void;
    refreshOffering: () => Promise<void>;
  }>;
  /** Factory: create event streams client. */
  createEventStreams: () => { relays: Array<{ url: string }> };
  /** PLC directory URL. */
  plcDirectoryUrl: string;
  /** Base URL for DigitalOcean API. */
  digitaloceanBaseUrl?: string;
  /** Offering refresh interval in seconds. */
  offeringRefreshSec?: number;
  /** Firehose mode. */
  firehoseMode?: string;
  /** Whether to skip ingress proxy. */
  noIngressProxy?: boolean;
}

export interface BidderManagerVMEvent {
  type: "provisioned" | "deleted" | "completed";
  bidderKeyId: number;
  vmId: string;
  requesterDid: string;
  requesterHandle?: string;
  contractUri: string;
  at: number;
}

class BidderManagerImpl implements BidderManager {
  readonly #db: BidderDb;
  readonly #logger: StructuredLoggerInterface;
  readonly #deps: BidderManagerDeps;
  readonly #bidders = new Map<number, BidderRefImpl>();
  readonly #opts: Required<BidderManagerOptions>;
  #refreshTimer: ReturnType<typeof setInterval> | undefined;
  #started = false;

  /** Event bus — subscribe for VM lifecycle events (drives WebSocket push). */
  readonly vmEvents = new EventBus<BidderManagerVMEvent>();

  constructor(deps: BidderManagerDeps, opts?: BidderManagerOptions) {
    this.#db = deps.db;
    this.#logger = deps.logger;
    this.#deps = deps;
    this.#opts = {
      maxRetries: opts?.maxRetries ?? 3,
      retryBackoffBaseMs: opts?.retryBackoffBaseMs ?? 1000,
      refreshIntervalMs: opts?.refreshIntervalMs ?? 5 * 60 * 1000,
      refreshThresholdMs: opts?.refreshThresholdMs ?? 5 * 60 * 1000,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    await this.#db.migrate();

    const pairs = await this.#db.listActiveAccountPairs();
    this.#logger.info("bidder_manager_starting", {
      accountPairs: pairs.length,
    });

    for (const pair of pairs) {
      try {
        await this.#startBidder(pair.bidderKeyId, pair.atprotoSession, pair.doToken);
      } catch (err) {
        this.#logger.error("bidder_manager_start_failed", {
          bidderKeyId: pair.bidderKeyId,
          error: String(err),
        });
      }
    }

    this.#startRefreshTimer();
    this.#logger.info("bidder_manager_started", {
      running: this.#bidders.size,
      total: pairs.length,
    });
  }

  async addAccountPair(opts: {
    atprotoSession: AtprotoSessionRow;
    doToken: DOTokenRow;
    ownerDid: string;
  }): Promise<BidderInstance> {
    // Persist sessions + token
    await this.#db.upsertAtprotoSession({
      did: opts.atprotoSession.did,
      handle: opts.atprotoSession.handle,
      access_jwt: opts.atprotoSession.access_jwt,
      refresh_jwt: opts.atprotoSession.refresh_jwt,
      dpop_public_jwk: opts.atprotoSession.dpop_public_jwk,
      dpop_private_jwk: opts.atprotoSession.dpop_private_jwk,
      pds: opts.atprotoSession.pds,
    });
    await this.#db.upsertDOToken({
      team_uuid: opts.doToken.team_uuid,
      access_token: opts.doToken.access_token,
      refresh_token: opts.doToken.refresh_token,
      expires_at: opts.doToken.expires_at,
      scope: opts.doToken.scope,
      owner_did: opts.ownerDid,
    });

    // Check if already exists
    const existing = await this.#db.getBidderKeyByPair(
      opts.atprotoSession.did,
      opts.doToken.team_uuid,
    );
    if (existing) {
      // Already have this pair — restart if stopped
      const ref = this.#bidders.get(existing.id);
      if (ref && ref.instance.status === "failed") {
        await this.retryBidder(existing.id);
      }
      const ref2 = this.#bidders.get(existing.id);
      return ref2?.instance ?? {
        id: existing.id,
        atprotoDid: existing.atproto_did,
        atprotoHandle: opts.atprotoSession.handle,
        doTeamUuid: existing.do_team_uuid,
        status: "running" as BidderStatus,
        contracts: 0,
        activeVms: 0,
        startedAt: existing.created_at,
        retryCount: 0,
      };
    }

    // Generate keypair
    const { Secp256k1Keypair } = await import("@atproto/crypto");
    const keypair = await Secp256k1Keypair.create({ exportable: true });
    const privateKeyHex = Array.from(await keypair.export())
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const row = await this.#db.insertBidderKey({
      atproto_did: opts.atprotoSession.did,
      do_team_uuid: opts.doToken.team_uuid,
      owner_did: opts.ownerDid,
      private_key_hex: privateKeyHex,
    });

    await this.#startBidder(row.id, opts.atprotoSession, opts.doToken);

    return {
      id: row.id,
      atprotoDid: row.atproto_did,
      atprotoHandle: opts.atprotoSession.handle,
      doTeamUuid: row.do_team_uuid,
      status: "running",
      contracts: 0,
      activeVms: 0,
      startedAt: row.created_at,
      retryCount: 0,
    };
  }

  getBidders(): BidderRef[] {
    return [...this.#bidders.values()].map((r) => ({
      instance: r.instance,
      shutdown: () => r.shutdown(),
      restart: () => r.restart(),
    }));
  }

  async getActiveContracts(): Promise<ContractRow[]> {
    return this.#db.listActiveContracts();
  }

  async getContracts(
    bidderKeyId: number,
    opts?: { cursor?: number; limit?: number },
  ): Promise<{ contracts: ContractRow[]; cursor: number | null }> {
    return this.#db.listContractsByBidderKey(bidderKeyId, opts);
  }

  async retryBidder(bidderKeyId: number): Promise<void> {
    const ref = this.#bidders.get(bidderKeyId);
    if (!ref) {
      this.#logger.warn("bidder_manager_retry_not_found", { bidderKeyId });
      return;
    }
    this.#logger.info("bidder_manager_retry", { bidderKeyId });
    await ref.restart();
  }

  async removeBidder(bidderKeyId: number): Promise<void> {
    const ref = this.#bidders.get(bidderKeyId);
    if (ref) {
      await ref.shutdown();
      this.#bidders.delete(bidderKeyId);
    }
    await this.#db.deleteBidderKey(bidderKeyId);
    this.#logger.info("bidder_manager_removed", { bidderKeyId });
  }

  shutdown(): void {
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    for (const [id, ref] of this.#bidders) {
      try {
        ref.shutdown();
      } catch (err) {
        this.#logger.warn("bidder_shutdown_error", { bidderKeyId: id, error: String(err) });
      }
    }
    this.#bidders.clear();
    this.#db.close().catch((err) =>
      this.#logger.warn("db_close_error", { error: String(err) })
    );
  }

  // ── Internal ───────────────────────────────────────────────────────────

  async #startBidder(
    bidderKeyId: number,
    atprotoSession: AtprotoSessionRow,
    doToken: DOTokenRow,
  ): Promise<void> {
    const instance: BidderInstance = {
      id: bidderKeyId,
      atprotoDid: atprotoSession.did,
      atprotoHandle: atprotoSession.handle,
      doTeamUuid: doToken.team_uuid,
      status: "starting",
      contracts: 0,
      activeVms: 0,
      startedAt: Date.now(),
      retryCount: 0,
    };

    const ref = new BidderRefImpl(
      instance,
      atprotoSession,
      doToken,
      this.#db,
      this.#logger,
      this.#deps,
      this.#opts,
      this.vmEvents,
    );

    this.#bidders.set(bidderKeyId, ref);

    try {
      await ref.boot();
    } catch (err) {
      instance.status = "failed";
      instance.errorMessage = String(err);
      this.#logger.error("bidder_boot_failed", {
        bidderKeyId,
        error: String(err),
      });

      // Attempt restart
      if (instance.retryCount < this.#opts.maxRetries) {
        this.#scheduleRetry(bidderKeyId);
      }
    }
  }

  #scheduleRetry(bidderKeyId: number): void {
    const ref = this.#bidders.get(bidderKeyId);
    if (!ref) return;

    ref.instance.retryCount++;
    const delay = this.#opts.retryBackoffBaseMs *
      Math.pow(2, ref.instance.retryCount - 1);

    this.#logger.info("bidder_retry_scheduled", {
      bidderKeyId,
      attempt: ref.instance.retryCount,
      delayMs: delay,
    });

    setTimeout(async () => {
      this.#logger.info("bidder_retry_attempt", {
        bidderKeyId,
        attempt: ref.instance.retryCount,
      });
      try {
        ref!.instance.status = "starting";
        await ref!.boot();
      } catch (err) {
        ref!.instance.status = "failed";
        ref!.instance.errorMessage = String(err);
        this.#logger.error("bidder_retry_failed", {
          bidderKeyId,
          attempt: ref.instance.retryCount,
          error: String(err),
        });
        if (ref!.instance.retryCount < this.#opts.maxRetries) {
          this.#scheduleRetry(bidderKeyId);
        } else {
          this.#logger.error("bidder_max_retries_exceeded", {
            bidderKeyId,
            error: "Max retries exceeded — manual intervention required",
          });
        }
      }
    }, delay);
  }

  #startRefreshTimer(): void {
    this.#refreshTimer = setInterval(async () => {
      try {
        // Refresh stale ATProto sessions
        const sessions = await this.#db.listAtprotoSessionsNeedingRefresh(
          this.#opts.refreshThresholdMs,
        );
        for (const s of sessions) {
          try {
            const agent = await this.#deps.createOAuthAgent(s);
            // Refresh done by agent internally, update DB
            // deno-lint-ignore no-explicit-any
            const sessionData = (agent.agent as any).sessionData;
            if (sessionData) {
              await this.#db.updateAtprotoSessionRefreshed(
                s.did,
                sessionData.accessJwt ?? s.access_jwt,
                sessionData.refreshJwt ?? s.refresh_jwt,
              );
            }
            agent.dispose?.();
          } catch (err) {
            this.#logger.warn("atproto_refresh_failed", {
              did: s.did,
              error: String(err),
            });
          }
        }

        // Refresh stale DO tokens
        const tokens = await this.#db.listDOTokensNeedingRefresh(
          this.#opts.refreshThresholdMs,
        );
        for (const t of tokens) {
          try {
            const handle = await this.#deps.createDOTokenHandle(t);
            await handle.proactiveRefresh();
            handle.dispose?.();
          } catch (err) {
            this.#logger.warn("do_refresh_failed", {
              teamUuid: t.team_uuid,
              error: String(err),
            });
          }
        }
      } catch (err) {
        this.#logger.warn("refresh_timer_error", { error: String(err) });
      }
    }, this.#opts.refreshIntervalMs);
    Deno.unrefTimer?.(this.#refreshTimer);
  }
}

// ── BidderRefImpl ────────────────────────────────────────────────────────

class BidderRefImpl implements BidderRef {
  instance: BidderInstance;
  #atprotoSession: AtprotoSessionRow;
  #doToken: DOTokenRow;
  #db: BidderDb;
  #logger: StructuredLoggerInterface;
  #deps: BidderManagerDeps;
  #opts: Required<BidderManagerOptions>;
  #vmEvents: EventBus<BidderManagerVMEvent>;
  #bidder: { shutdown(): void; refreshOffering?(): Promise<void> } | null = null;
  #doTokenHandle: Awaited<ReturnType<BidderManagerDeps["createDOTokenHandle"]>> | null = null;
  #serve: ServeHandle | null = null;
  #ingress: IngressRef | null = null;
  #acceptToContract = new Map<string, unknown>();

  constructor(
    instance: BidderInstance,
    atprotoSession: AtprotoSessionRow,
    doToken: DOTokenRow,
    db: BidderDb,
    logger: StructuredLoggerInterface,
    deps: BidderManagerDeps,
    opts: Required<BidderManagerOptions>,
    vmEvents: EventBus<BidderManagerVMEvent>,
  ) {
    this.instance = instance;
    this.#atprotoSession = atprotoSession;
    this.#doToken = doToken;
    this.#db = db;
    this.#logger = logger;
    this.#deps = deps;
    this.#opts = opts;
    this.#vmEvents = vmEvents;
  }

  async boot(): Promise<void> {
    // 0. Read per-bidder policy + args from DB
    const keyRow = await this.#db.getBidderKey(this.instance.id);
    const policy = keyRow?.policy ?? "only-me";
    const { parsePolicyArgs } = await import("@publicdomainrelay/policy-engine-cli-options");
    let policyArgs: Record<string, unknown> = {};
    try {
      policyArgs = parsePolicyArgs(keyRow?.policy_args);
    } catch {
      policyArgs = {};
    }

    // 1. Restore OAuth agent
    const { agent } = await this.#deps.createOAuthAgent(this.#atprotoSession);

    // 2. Create ATProto wrapper
    const atproto = await this.#deps.createATProto({
      agent,
      logger: this.#logger,
      plcDirectoryUrl: this.#deps.plcDirectoryUrl,
    }) as unknown as ComputeAtproto;

    // 3. Create ingress relay
    if (!this.#deps.noIngressProxy) {
      this.#ingress = await this.#deps.createIngress();
    }

    // 4. Resolve DO token
    this.#doTokenHandle = await this.#deps.createDOTokenHandle(this.#doToken);
    const accessToken = await this.#doTokenHandle.resolve();

    // 5. Create serve (don't beginServe — MarketBidder.beginServe() handles it).
    //    DO provider registers onConnected before relay connects, so OIDC issuer
    //    + JSR registry + /v1/on-network mount when MarketBidder.beginServe() fires.
    const { createServe } = await import("@publicdomainrelay/serve");
    this.#serve = createServe({
      logger: this.#logger,
      relays: this.#ingress ? [this.#ingress] : [],
    });

    // 6. Create DO compute provider (registers onConnected callback before relay connects).
    //    Use live getters — ingressUrl is only populated after beginServe/relay-connect.
    // deno-lint-ignore no-explicit-any
    const atprotoAny = atproto as any;
    const ingressRef = this.#ingress;
    const doProvider = await this.#deps.createDOProvider({
      doToken: accessToken,
      atproto,
      serve: this.#serve,
      getIngressUrl: () => this.#ingress?.ingressUrl ?? "",
      acceptToContract: this.#acceptToContract,
      createSignedRepoRecord: async (collection, record) => {
        const result = await atprotoAny.createSignedRepoRecord(collection, record);
        return { $type: "com.atproto.repo.strongRef", uri: result.uri, cid: result.cid };
      },
      callService: async (url, body) => {
        const result = await atprotoAny.callService(url, "", "", body);
        return result as { status: number; body: unknown };
      },
    }) as Record<string, unknown>;

    // 7. Wrap provision/destroy with token refresh
    // deno-lint-ignore no-explicit-any
    const providerAny = doProvider as any;
    const doTokenRef = this.#doTokenHandle;
    const wrappedProvider = {
      ...doProvider,
      async provision(vm: unknown, requesterDid: string, spec?: unknown) {
        try { await doTokenRef!.resolve(); } catch { /* stale */ }
        return providerAny.provision(vm, requesterDid, spec);
      },
    };

    // 8. Create provider hooks
    const { createComputeProviderHooks } = await import(
      "@publicdomainrelay/market-bidder-compute"
    );
    const providers: MarketBidderProviderRef[] = [
      createComputeProviderHooks({
        provider: wrappedProvider as unknown as Parameters<
          typeof createComputeProviderHooks
        >[0]["provider"],
      }),
    ];

    // 9. Create event streams
    const eventStreams = this.#deps.createEventStreams();

    // 10. Create MarketBidder
    // deno-lint-ignore no-explicit-any
    const onContractChange = (event: Record<string, any>) => {
      this.#onContractChange(event);
    };

    const { createMarketBidder } = await import("@publicdomainrelay/market-bidder");
    const bidder = await createMarketBidder({
      logger: this.#logger,
      atproto: atproto as unknown as Parameters<typeof createMarketBidder>[0]["atproto"],
      providers,
      // deno-lint-ignore no-explicit-any
      relay: this.#ingress as any,
      serve: this.#serve,
      eventStreams: eventStreams as unknown as Parameters<
        typeof createMarketBidder
      >[0]["eventStreams"],
      offeringRefreshMs: this.#deps.offeringRefreshSec
        ? this.#deps.offeringRefreshSec * 1000
        : undefined,
      // deno-lint-ignore no-explicit-any
      acceptToContract: this.#acceptToContract as any,
      // deno-lint-ignore no-explicit-any
      onContractChange: onContractChange as any,
      policy,
      policyArgs,
    });

    await bidder.beginServe();
    this.#bidder = bidder;

    this.instance.status = "running";
    this.instance.startedAt = Date.now();
    this.instance.errorMessage = undefined;
    this.#logger.info("bidder_booted", {
      bidderKeyId: this.instance.id,
      atprotoDid: this.instance.atprotoDid,
      doTeamUuid: this.instance.doTeamUuid,
    });
  }

  async shutdown(): Promise<void> {
    if (this.#bidder) {
      try { this.#bidder.shutdown?.(); } catch { /* ignore */ }
      this.#bidder = null;
    }
    if (this.#serve) {
      try { this.#serve.shutdown?.(); } catch { /* ignore */ }
      this.#serve = null;
    }
    if (this.#ingress) {
      try { this.#ingress.close(); } catch { /* ignore */ }
      this.#ingress = null;
    }
    if (this.#doTokenHandle) {
      try { this.#doTokenHandle.dispose?.(); } catch { /* ignore */ }
      this.#doTokenHandle = null;
    }
    this.instance.status = "stopped";
  }

  async restart(): Promise<void> {
    await this.shutdown();
    this.instance.status = "starting";
    this.instance.retryCount = 0;
    try {
      await this.boot();
    } catch (err) {
      this.instance.status = "failed";
      this.instance.errorMessage = String(err);
      throw err;
    }
  }

  // deno-lint-ignore no-explicit-any
  async #onContractChange(event: Record<string, any>): Promise<void> {
    try {
      const requesterDid = (event.requesterDid || event.acceptAuthor || "") as string;
      if (event.type === "provisioned") {
        await this.#db.insertContract({
          bidder_key_id: this.instance.id,
          requester_did: requesterDid,
          requester_handle: event.requesterHandle as string | undefined,
          contract_uri: (event.contractUri || event.receiptUri || "") as string,
          rfp_uri: (event.rfpUri || "") as string,
          vm_id: event.vmId as string | undefined,
          status: "active",
          provisioned_at: Date.now(),
        });
        this.instance.activeVms++;
        this.instance.contracts++;

        this.#vmEvents.publish({
          type: "provisioned",
          bidderKeyId: this.instance.id,
          vmId: (event.vmId || event.providerId || "") as string,
          requesterDid,
          requesterHandle: event.requesterHandle as string | undefined,
          contractUri: (event.contractUri || event.receiptUri || "") as string,
          at: Date.now(),
        });
      } else if (event.type === "completed" || event.type === "cancelled") {
        // Find contract by URI and update
        const contracts = await this.#db.listContractsByBidderKey(
          this.instance.id,
          { limit: 100 },
        );
        const match = contracts.contracts.find(
          (c) => c.contract_uri === event.contractUri,
        );
        if (match) {
          await this.#db.updateContractStatus(match.id, event.type);
          if (this.instance.activeVms > 0) this.instance.activeVms--;

          this.#vmEvents.publish({
            type: event.type === "completed" ? "completed" : "deleted",
            bidderKeyId: this.instance.id,
            vmId: match.vm_id ?? "",
            requesterDid: match.requester_did,
            requesterHandle: match.requester_handle ?? undefined,
            contractUri: match.contract_uri,
            at: Date.now(),
          });
        }
      }

      this.#logger.info("contract_event", {
        bidderKeyId: this.instance.id,
        type: event.type,
        requesterDid: event.requesterDid,
      });
    } catch (err) {
      this.#logger.warn("contract_tracking_error", { error: String(err) });
    }
  }
}

export function createBidderManager(
  deps: BidderManagerDeps,
  opts?: BidderManagerOptions,
): BidderManager {
  return new BidderManagerImpl(deps, opts);
}
