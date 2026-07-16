// bidder-session-abc — pure interface for session cookie management.
// Layer 1: interfaces only, zero I/O, depends on common (type imports).

import type { SessionCookiePayload } from "@publicdomainrelay/bidder-session-common";

/** Signs and verifies browser session cookies. */
export interface SessionStore {
  /** Create a signed session JWT for the given DID+handle. Returns cookie value. */
  createSession(did: string, handle: string): Promise<string>;
  /** Verify a session JWT cookie value, returning payload or null. */
  verifySession(token: string): Promise<SessionCookiePayload | null>;
}
