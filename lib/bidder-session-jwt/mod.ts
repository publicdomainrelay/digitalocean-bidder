// bidder-session-jwt — HS256 JWT session cookie implementation.
// Layer 2: impl. Uses Web Crypto for signing/verification.

import type { SessionStore } from "@publicdomainrelay/bidder-session-abc";
import {
  signSessionJwt,
  verifySessionJwt,
} from "@publicdomainrelay/bidder-session-common";

export interface BidderSessionJwtOptions {
  /** HS256 secret. Generate with crypto.getRandomValues if not provided. */
  secret?: string;
}

/** Generate a cryptographically random 32-byte hex secret. */
export function generateSessionSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Create a SessionStore backed by HS256 JWT cookies. */
export function createBidderSessionJwt(opts?: BidderSessionJwtOptions): SessionStore {
  const secret = opts?.secret ?? generateSessionSecret();

  return {
    async createSession(did: string, handle: string): Promise<string> {
      return signSessionJwt({ did, handle }, secret);
    },
    async verifySession(token: string) {
      return verifySessionJwt(token, secret);
    },
  };
}
