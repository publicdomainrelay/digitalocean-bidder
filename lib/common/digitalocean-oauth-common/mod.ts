// DigitalOcean OAuth common — types, constants, pure helpers.
// No I/O, no concept logic, no project-local imports.

/** DigitalOcean OAuth2 endpoints. */
export const DO_AUTH_BASE = "https://cloud.digitalocean.com/v1/oauth";
export const DO_API_BASE = "https://api.digitalocean.com";

export const DO_ENDPOINTS = {
  authorize: `${DO_AUTH_BASE}/authorize`,
  token: `${DO_AUTH_BASE}/token`,
  account: `${DO_API_BASE}/v2/account`,
} as const;

/** Granular OAuth scopes matching the DO API operations the bidder performs.
 *  - account:read — /v2/account team UUID lookup
 *  - droplet:read — /v2/droplets list + /v2/droplets/:id IP lookup
 *  - droplet:create — POST /v2/droplets provision VM
 *  - droplet:delete — DELETE /v2/droplets/:id destroy VM
 *  - tag:read, tag:create — droplet tags for OIDC subject binding */
export const DO_SCOPES = "droplet:read droplet:create droplet:delete account:read tag:create tag:read";

/** Max age of a stored token before proactive refresh (2 minutes). */
export const DO_TOKEN_REFRESH_THRESHOLD_MS = 120_000;

/** Serialized DO OAuth token data. */
export interface DOTokenData {
  accessToken: string;
  refreshToken: string;
  teamUuid: string;
  /** Expiry as epoch milliseconds. */
  expiresAt: number;
  scope: string;
}

/** Per-request OAuth state for CSRF protection. */
export interface DOAuthState {
  state: string;
}

/** DO /v2/account response shape (subset). */
export interface DOAccountResponse {
  account: {
    team: { uuid: string };
    uuid: string;
    email: string;
  };
}

/** DO OAuth token response shape (subset). */
export interface DOOAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Generate a random hex state string for CSRF protection. */
export function createDOState(): DOAuthState {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return {
    state: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}
