// API helpers — fetch and WebSocket for the dashboard.

const BASE = "";

export async function fetchStatus() {
  const r = await fetch(`${BASE}/api/status`, { credentials: "same-origin" });
  if (!r.ok) {
    if (r.status === 401) throw new Error("UNAUTHORIZED");
    throw new Error(`status ${r.status}`);
  }
  return r.json();
}

export async function startBidder() {
  const r = await fetch(`${BASE}/api/bidder/start`, { method: "POST", credentials: "same-origin" });
  if (!r.ok) {
    if (r.status === 401) throw new Error("UNAUTHORIZED");
    const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new Error(err.error || `HTTP ${r.status}`);
  }
  return r.json();
}

export async function retryBidder(id) {
  const r = await fetch(`${BASE}/api/bidder/${id}/retry`, { method: "POST", credentials: "same-origin" });
  if (!r.ok) {
    if (r.status === 401) throw new Error("UNAUTHORIZED");
    throw new Error(`HTTP ${r.status}`);
  }
  return r.json();
}

export async function removeBidder(id) {
  const r = await fetch(`${BASE}/api/bidder/${id}/remove`, { method: "POST", credentials: "same-origin" });
  if (!r.ok) {
    if (r.status === 401) throw new Error("UNAUTHORIZED");
    throw new Error(`HTTP ${r.status}`);
  }
  return r.json();
}

export async function fetchContracts(bidderKeyId, cursor) {
  const params = new URLSearchParams();
  if (bidderKeyId) params.set("bidderKeyId", String(bidderKeyId));
  if (cursor) params.set("cursor", String(cursor));
  params.set("limit", "50");
  const r = await fetch(`${BASE}/xrpc/com.publicdomainrelay.temp.bidder.getContracts?${params}`, { credentials: "same-origin" });
  if (!r.ok) {
    if (r.status === 401) throw new Error("UNAUTHORIZED");
    throw new Error(`HTTP ${r.status}`);
  }
  return r.json();
}

export async function patchPolicyMode(mode) {
  const r = await fetch(`${BASE}/api/policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ policyMode: mode }),
    credentials: "same-origin",
  });
  if (!r.ok) {
    if (r.status === 401) throw new Error("UNAUTHORIZED");
    const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new Error(err.error || `HTTP ${r.status}`);
  }
  return r.json();
}

// ── WebSocket for live VM updates ──────────────────────────────────────

export function connectVmStream(onSnapshot, onUpdate, onStatusChange) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/xrpc/com.publicdomainrelay.temp.bidder.subscribeVms`;
  let ws = null;
  let closed = false;
  let reconnectTimer = null;

  function connect() {
    if (closed) return;
    onStatusChange?.("connecting");
    ws = new WebSocket(wsUrl);

    ws.onopen = () => onStatusChange?.("connected");

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "snapshot") {
          onSnapshot(msg.vms || []);
        } else if (msg.type === "update") {
          onUpdate(msg.vm);
        }
      } catch { /* ignore malformed */ }
    };

    ws.onclose = () => {
      onStatusChange?.("disconnected");
      if (!closed) {
        reconnectTimer = setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}
