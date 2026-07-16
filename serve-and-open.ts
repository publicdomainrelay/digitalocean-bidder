// Serve digitalocean-bidder and open in Chrome.
// Starts fake PLC + dispatcher + bidder subprocess.
import { Hono } from "@hono/hono";
import { createRelayFactory as createDispatcherFactory } from "@publicdomainrelay/hono-factory-did-key-ingress-proxy-xrpc";

// ── 1. Fake PLC ──────────────────────────────────────────────────────────────
function createFakePlc() {
  const ops = new Map<string, { op: Record<string, unknown>; did: string }>();
  const app = new Hono();

  app.post("/*", async (c) => {
    const did = decodeURIComponent(new URL(c.req.url).pathname.slice(1));
    const op = await c.req.json().catch(() => ({}));
    ops.set(did, { op: op as Record<string, unknown>, did });
    return c.json({ did });
  });

  app.get("/*", (c) => {
    const did = decodeURIComponent(new URL(c.req.url).pathname.slice(1));
    const entry = ops.get(did);
    if (!entry) return c.json({ message: `DID not found: ${did}` }, 404);
    const op = entry.op;
    const vms = (op.verificationMethods ?? {}) as Record<string, string>;
    const svcs = (op.services ?? {}) as Record<string, { type: string; endpoint: string }>;
    return c.json({
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: did,
      alsoKnownAs: (op.alsoKnownAs ?? []) as string[],
      verificationMethod: Object.entries(vms).map(([name, didKey]) => ({
        id: `${did}#${name}`,
        type: "Multikey",
        controller: did,
        publicKeyMultibase: String(didKey).replace(/^did:key:/, ""),
      })),
      service: Object.entries(svcs).map(([name, s]) => ({
        id: `#${name}`,
        type: s.type,
        serviceEndpoint: s.endpoint,
      })),
    });
  });

  return { app };
}

// ── 2. Serve on port 0 helper ─────────────────────────────────────────────────
function serveOnPort0(
  f: (r: Request) => Response | Promise<Response>,
  ac: AbortController,
  hostname = "127.0.0.1",
): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  Deno.serve(
    { port: 0, hostname, signal: ac.signal, onListen: (a) => resolve((a as Deno.NetAddr).port) },
    f,
  );
  return promise;
}

// ── 3. Install fetch interceptor ──────────────────────────────────────────────
function installFetchInterceptor(opts: { plcDirectoryUrl: string; dispPort: number }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = url.match(/^https:\/\/([^/]+)(\/.*)?$/);
    if (m && m[1].endsWith(".localhost")) {
      let host = m[1];
      if (!host.includes(":")) host = `${host}:${opts.dispPort}`;
      url = `http://${host}${m[2] ?? ""}`;
      return realFetch(url, init);
    }
    if (url.startsWith("https://plc.directory/")) {
      url = opts.plcDirectoryUrl + url.slice("https://plc.directory".length);
      return realFetch(url, init);
    }
    return realFetch(input as string | URL | Request, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const cleanups: Array<() => void> = [];

  // Start fake PLC
  const plcAc = new AbortController();
  const plcApp = createFakePlc().app;
  const plcPort = await serveOnPort0(plcApp.fetch, plcAc);
  const plcDirectoryUrl = `http://localhost:${plcPort}`;
  cleanups.push(() => plcAc.abort());
  console.log(`Fake PLC: ${plcDirectoryUrl}`);

  // Start dispatcher
  const dispAc = new AbortController();
  const dispatcherApp = createDispatcherFactory({ hostname: "localhost" }).createApp();
  const dispPort = await serveOnPort0(dispatcherApp.fetch, dispAc, "0.0.0.0");
  const ingressProxyHost = `localhost:${dispPort}`;
  cleanups.push(() => dispAc.abort());
  console.log(`Dispatcher: http://${ingressProxyHost}`);

  // Install fetch interceptor
  installFetchInterceptor({ plcDirectoryUrl, dispPort });

  // Temp data dir for PGlite
  const dataDir = await Deno.makeTempDir({ prefix: "do-bidder-pgdata-" });
  console.log(`PGlite data dir: ${dataDir}`);

  // Spawn bidder subprocess
  const bidderCmd = new Deno.Command("deno", {
    args: [
      "run", "-A", "--unstable-kv",
      new URL("./mod.ts", import.meta.url).pathname,
      "--no-ingress-proxy",
      "--firehose-mode", "off",
      "--plc-directory-url", plcDirectoryUrl,
      "--ingress-proxy-host", ingressProxyHost,
      "--serve-addr", "127.0.0.1",
      "--serve-port", "0",
      "--offering-refresh-sec", "60",
      "--db-path", dataDir,
    ],
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ATPROTO_DID: "" },
  });

  const child = bidderCmd.spawn();

  // Wait for bidder_ready JSON line, extract port
  const decoder = new TextDecoder();
  let bidderPort = 0;
  let bidderUrl = "";

  async function readStream(
    r: ReadableStreamDefaultReader<Uint8Array>,
    label: string,
  ) {
    let buf = "";
    while (true) {
      const { done, value } = await r.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      while (buf.includes("\n")) {
        const nl = buf.indexOf("\n");
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        console.log(`[${label}] ${line}`);
        try {
          const o = JSON.parse(line);
          if (o.event === "bidder_ready") {
            bidderPort = o.servePort as number;
            bidderUrl = (o.serveBaseUrl as string) || `http://127.0.0.1:${bidderPort}`;
          }
        } catch { /* not JSON */ }
      }
    }
  }

  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  const readDone = Promise.all([
    readStream(stdoutReader, "bidder"),
    readStream(stderrReader, "bidder-err"),
  ]);

  // Wait for bidder_ready or timeout
  const deadline = Date.now() + 60_000;
  while (bidderPort === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  if (bidderPort === 0) {
    console.error("Failed to detect bidder port. Check bidder output.");
    Deno.exit(1);
  }

  if (!bidderUrl) bidderUrl = `http://127.0.0.1:${bidderPort}`;

  console.log(`\nBidder dashboard: ${bidderUrl}`);
  console.log(`OAuth metadata: ${bidderUrl}/oauth-client-metadata.json`);
  console.log(`API status: ${bidderUrl}/api/status`);
  console.log(`XRPC getContracts: ${bidderUrl}/xrpc/com.publicdomainrelay.temp.bidder.getContracts`);
  console.log(`XRPC subscribeVms: ws://127.0.0.1:${bidderPort}/xrpc/com.publicdomainrelay.temp.bidder.subscribeVms`);

  // Open Chrome
  const openCmd = Deno.build.os === "darwin" ? "open" : "xdg-open";
  console.log(`\nOpening Chrome: ${bidderUrl}`);
  new Deno.Command(openCmd, {
    args: ["-a", "Google Chrome", bidderUrl, "--args", "--auto-open-devtools-for-tabs"],
  }).spawn();

  console.log("\nPress Ctrl+C to stop.");
  console.log("Endpoints:");
  console.log(`  GET  ${bidderUrl}/ — Dashboard`);
  console.log(`  GET  ${bidderUrl}/api/status — JSON status`);
  console.log(`  GET  ${bidderUrl}/oauth-client-metadata.json`);
  console.log(`  GET  ${bidderUrl}/xrpc/com.publicdomainrelay.temp.bidder.getContracts`);
  console.log(`  WS   ws://127.0.0.1:${bidderPort}/xrpc/com.publicdomainrelay.temp.bidder.subscribeVms`);

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`FATAL: ${err}`);
  Deno.exit(1);
});
