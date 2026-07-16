// Layer 1 — pure interfaces. Zero I/O. Type-only imports.

import type { AtprotoSessionRow, DOTokenRow, BidderKeyRow, ContractRow } from "@publicdomainrelay/bidder-db-abc";

export type { AtprotoSessionRow, DOTokenRow, BidderKeyRow, ContractRow };

export type BidderStatus = "running" | "failed" | "stopped" | "starting";

export interface BidderInstance {
  id: number;
  atprotoDid: string;
  atprotoHandle: string;
  doTeamUuid: string;
  status: BidderStatus;
  contracts: number;
  activeVms: number;
  startedAt: number;
  errorMessage?: string;
  retryCount: number;
}

export interface BidderRef {
  instance: BidderInstance;
  shutdown(): Promise<void>;
  restart(): Promise<void>;
}

export interface BidderManagerOptions {
  /** Maximum retries before marking as failed (default 3). */
  maxRetries?: number;
  /** Backoff base in ms (default 1000). */
  retryBackoffBaseMs?: number;
  /** Token refresh interval in ms (default 5 min). */
  refreshIntervalMs?: number;
  /** How far before expiry to refresh (default 5 min). */
  refreshThresholdMs?: number;
}

export interface BidderManager {
  /** Start all bidders from DB, begin background refresh timer. */
  start(): Promise<void>;

  /** Add a new account pair and start its bidder. */
  addAccountPair(opts: {
    atprotoSession: AtprotoSessionRow;
    doToken: DOTokenRow;
    ownerDid: string;
  }): Promise<BidderInstance>;

  /** Get all bidder instances (running + failed). */
  getBidders(): BidderRef[];

  /** Get active contracts across all bidders. */
  getActiveContracts(): Promise<ContractRow[]>;

  /** Get paginated contracts for a specific bidder. */
  getContracts(bidderKeyId: number, opts?: {
    cursor?: number;
    limit?: number;
  }): Promise<{ contracts: ContractRow[]; cursor: number | null }>;

  /** Manually retry a failed bidder. */
  retryBidder(bidderKeyId: number): Promise<void>;

  /** Remove a bidder and its DB records. */
  removeBidder(bidderKeyId: number): Promise<void>;

  /** Graceful shutdown — stop all bidders, close DB. */
  shutdown(): void;
}
