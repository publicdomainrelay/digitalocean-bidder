// DigitalOcean OAuth ABC — pure interfaces, zero I/O.
// Depends on lib/common only (type imports).

import type { DOAuthState, DOTokenData } from "@publicdomainrelay/digitalocean-oauth-common";

/** Configuration for creating a DO OAuth flow. */
export interface DOOAuthFlowOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope?: string;
  authBaseUrl?: string;
  apiBaseUrl?: string;
}

/** DigitalOcean OAuth2 Authorization Code Grant flow. */
export interface DOOAuthFlow {
  /** Build the authorize URL to open in the system browser. */
  authorizeUrl(state: DOAuthState): string;
  /** Exchange authorization code for tokens. Resolves team UUID from /v2/account. */
  exchangeCode(code: string, state: DOAuthState): Promise<DOTokenData>;
  /** Refresh an expiring or expired token. */
  refreshToken(token: DOTokenData): Promise<DOTokenData>;
  /** Call DO /v2/account to resolve the team UUID for an access token. */
  getTeamUuid(accessToken: string): Promise<string>;
}

/** Persistence for DO OAuth tokens, keyed by team UUID. */
export interface DOTokenStore {
  /** Load a stored token by team UUID, or null if not found. */
  load(teamUuid: string): Promise<DOTokenData | null>;
  /** Save (create or update) a token keyed by its team UUID. */
  save(token: DOTokenData): Promise<void>;
  /** Delete a stored token. */
  delete(teamUuid: string): Promise<void>;
  /** List all team UUIDs with stored tokens. */
  listTeams(): Promise<string[]>;
}
