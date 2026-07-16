# digitalocean-bidder

Multi-account DigitalOcean compute provider bidder with AT Protocol + DigitalOcean OAuth. Database-backed persistence (PGlite or PostgreSQL), XRPC subscriptions for live VM status, paginated contract history, and restart resilience.

## Quick start

```bash
source ~/.digitalocean_source && deno run -A mod.ts
```

`~/.digitalocean_source` must export:

```bash
export DO_OAUTH_CLIENT_ID="..."
export DO_OAUTH_CLIENT_SECRET="..."
export DO_OAUTH_REDIRECT_URI="https://digitalocean.socialweb.computer/auth/digitalocean/callback"
```

## Options

All options configurable via CLI flags, env vars, `config.json`, or `cli-args-env.json` defaults (first match wins).

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--serve-port` | `SERVE_PORT` | `0` (random) | TCP listen port |
| `--serve-addr` | `SERVE_ADDR` | `0.0.0.0` | TCP listen address |
| `--db-path` | `DB_PATH` | `./data/pgdata` | PGlite data directory |
| `--db-uri` | `DATABASE_URI` | — | PostgreSQL connection string (uses real PG instead of PGlite) |
| `--public-origin` | `PUBLIC_ORIGIN` | derived from DO redirect URI | Public FQDN for OAuth metadata |
| `--ingress-proxy-host` | `INGRESS_PROXY_HOST` | `xrpc.fedproxy.com` | XRPC relay dispatcher |
| `--no-ingress-proxy` | — | — | Disable XRPC relay |
| `--firehose-mode` | `FIREHOSE_MODE` | `off` | Firehose mode: `off`, `subscriberepos`, `jetstream` |
| `--refresh-interval-sec` | `REFRESH_INTERVAL_SEC` | `300` | Token refresh interval |
| `--offering-refresh-sec` | `OFFERING_REFRESH_SEC` | `300` | Offering re-commit interval |

### Production (port 40000, PostgreSQL)

```bash
source ~/.digitalocean_source && \
  DATABASE_URI="postgres://..." \
  deno run -A mod.ts --serve-port 40000
```

## Architecture

```
mod.ts                          Thin CLI: resolve opts, create DB, start serve + BidderManager
lib/common/bidder-db-common/    DB types, SQL DDL, constants
lib/abc/bidder-db/              BidderDb interface
lib/bidder-db-pglite/           PGlite impl (embedded Postgres via WASM)
lib/bidder-db-postgres/         PostgreSQL impl
lib/abc/bidder-manager/         BidderManager interface
lib/bidder-manager/             Multi-bidder lifecycle orchestration
lib/common/digitalocean-oauth-common/  DO OAuth types
lib/abc/digitalocean-oauth/     DO OAuth interfaces
lib/digitalocean-oauth/         DO OAuth2 flow impl
lib/common/bidder-session-common/  Session cookie types
lib/abc/bidder-session/         Session store interface
lib/bidder-session-jwt/         JWT session store impl
static/                         Web UI (HTML/CSS/JS SPA)
```

## Database

Default: **PGlite** (embedded PostgreSQL via WASM). Data persists to `./data/pgdata/`.

Set `DATABASE_URI` for real PostgreSQL. Same SQL schema for both backends.

### Tables

- `atproto_sessions` — AT Protocol OAuth sessions (keyed by DID)
- `do_tokens` — DigitalOcean OAuth tokens (keyed by team UUID)
- `bidder_keys` — Links atproto + DO accounts (one bidder per pair)
- `contracts` — Past + active compute contracts
- `server_config` — Key-value config (secrets, OAuth state, etc.)

## XRPC endpoints

- `GET /xrpc/com.publicdomainrelay.temp.bidder.getContracts?bidderKeyId=&limit=&cursor=` — Paginated contracts
- `GET /xrpc/com.publicdomainrelay.temp.bidder.subscribeVms` — WebSocket upgrade, live VM status

## API endpoints

- `GET /api/status` — Session + bidder status (requires session cookie)
- `POST /api/bidder/start` — Start bidder for authenticated account pair
- `POST /api/bidder/:id/retry` — Retry failed bidder
- `POST /api/bidder/:id/remove` — Remove bidder

## OAuth

1. **AT Protocol**: Login with Bluesky handle → OAuth authorize → callback stores session
2. **DigitalOcean**: Login after ATProto → OAuth2 authorization code → callback stores token
3. **Auto-boot**: When both sessions exist, bidder starts automatically

## License

Unlicense (public domain). See `LICENSE`.
