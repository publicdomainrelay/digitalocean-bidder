// Main app logic — login/dashboard screens, status polling, VM stream.

import { fetchStatus, startBidder, retryBidder, removeBidder, fetchContracts, connectVmStream } from "./api.js";

// ── State ──────────────────────────────────────────────────────────────

let state = {
  atpReady: false,
  atpHandle: null,
  atpDid: null,
  doReady: false,
  doTeamUuid: null,
  doConfigured: false,
  bidders: [],
  serveBaseUrl: "",
  activeVms: [],
};

let selectedBidderId = null;

// ── DOM refs ───────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const loginScreen = $("#login-screen");
const dashboardScreen = $("#dashboard-screen");

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Status polling ────────────────────────────────────────────────────

let pollTimer = null;

async function poll() {
  try {
    const s = await fetchStatus();
    const prev = state;
    state = s;

    // Update serve URL
    if (s.serveBaseUrl) {
      const el = $("#serve-url");
      if (el) el.textContent = s.serveBaseUrl;
      const el2 = $("#serve-url-dash");
      if (el2) el2.textContent = s.serveBaseUrl;
    }

    // ATProto status
    if (s.atpReady && !prev.atpReady) showAtpReady(s.atpHandle, s.atpDid);
    if (!s.atpReady && prev.atpReady) showAtpPending();

    // DO status
    if (s.doReady && !prev.doReady) showDoReady(s.doTeamUuid);
    if (!s.doReady && prev.doReady) showDoPending();

    if (!s.doConfigured) {
      $("#do-actions").classList.add("hidden");
      $("#do-status").innerHTML = '<span class="badge badge-pending">Not configured</span>';
    }

    // Start bidder button
    const btn = $("#start-bidder-btn");
    if (s.atpReady && s.doReady && s.bidders.length === 0) {
      btn.classList.remove("hidden");
      btn.disabled = false;
      btn.textContent = "Start Bidder";
    } else if (s.bidders.length > 0) {
      btn.classList.add("hidden");
    }

    // Switch to dashboard if bidders running
    if (s.bidders.length > 0 && loginScreen && !loginScreen.classList.contains("hidden")) {
      loginScreen.classList.add("hidden");
      if (dashboardScreen) dashboardScreen.classList.remove("hidden");
    }

    // Render dashboard
    if (s.bidders.length > 0) {
      renderBidders(s.bidders);
      renderVms(s.activeVms);
      if (!selectedBidderId && s.bidders.length > 0) {
        selectedBidderId = s.bidders[0].id;
      }
    }
  } catch (err) {
    if (err.message === "UNAUTHORIZED") {
      // Session expired — show login screen
      if (dashboardScreen && !dashboardScreen.classList.contains("hidden")) {
        dashboardScreen.classList.add("hidden");
      }
      if (loginScreen) loginScreen.classList.remove("hidden");
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    console.warn("poll error:", err.message);
  }
}

// ── ATProto status ─────────────────────────────────────────────────────

function showAtpReady(handle, did) {
  const el = $("#atp-status");
  if (el) el.innerHTML = `<span class="badge badge-active">Authenticated as <strong>@${esc(handle)}</strong></span>`;
  const actions = $("#atp-actions");
  if (actions) actions.classList.add("hidden");
}

function showAtpPending() {
  const el = $("#atp-status");
  if (el) el.innerHTML = '<span class="badge badge-pending">Pending</span>';
  const actions = $("#atp-actions");
  if (actions) actions.classList.remove("hidden");
}

function showDoReady(teamUuid) {
  const el = $("#do-status");
  if (el) el.innerHTML = `<span class="badge badge-active">Team: <strong>${esc(teamUuid)}</strong></span>`;
  const actions = $("#do-actions");
  if (actions) actions.classList.add("hidden");
}

function showDoPending() {
  const el = $("#do-status");
  if (el) el.innerHTML = '<span class="badge badge-pending">Pending</span>';
  const actions = $("#do-actions");
  if (actions) actions.classList.remove("hidden");
}

// ── Dashboard rendering ───────────────────────────────────────────────

function renderBidders(bidders) {
  const el = $("#bidders-list");
  if (!el) return;

  const badges = {
    running: '<span class="badge badge-running">Running</span>',
    failed: '<span class="badge badge-failed">Failed</span>',
    stopped: '<span class="badge badge-stopped">Stopped</span>',
    starting: '<span class="badge badge-starting">Starting</span>',
  };

  el.innerHTML = bidders.map((b) => `
    <div class="bidder-row${selectedBidderId === b.id ? ' selected' : ''}" data-id="${b.id}">
      <div class="bidder-info">
        <strong>@${esc(b.atprotoHandle)}</strong>
        <span class="text-muted">DO: ${esc(b.doTeamUuid)}</span>
        <span class="text-muted">${b.contracts} contracts · ${b.activeVms} active VMs</span>
        ${b.errorMessage ? `<span class="error">${esc(b.errorMessage)}</span>` : ""}
      </div>
      <div class="bidder-actions">
        ${badges[b.status] || badges.stopped}
        ${b.status === "failed"
          ? `<button class="btn btn-sm btn-outline retry-btn" data-id="${b.id}">Retry</button>`
          : ""}
        <button class="btn btn-sm btn-danger remove-btn" data-id="${b.id}">Remove</button>
      </div>
    </div>
  `).join("");

  // Click to select
  el.querySelectorAll(".bidder-row").forEach((row) => {
    row.addEventListener("click", () => {
      selectedBidderId = parseInt(row.dataset.id);
      renderBidders(bidders);
      loadContracts(selectedBidderId);
    });
  });

  // Retry button
  el.querySelectorAll(".retry-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "Retrying…";
      try {
        await retryBidder(parseInt(btn.dataset.id));
      } catch (err) {
        alert(`Retry failed: ${err.message}`);
      }
      setTimeout(poll, 1000);
    });
  });

  // Remove button
  el.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Remove this bidder? Contracts stay in DB.")) return;
      try {
        await removeBidder(parseInt(btn.dataset.id));
        selectedBidderId = null;
        await poll();
      } catch (err) {
        alert(`Remove failed: ${err.message}`);
      }
    });
  });
}

function renderVms(vms) {
  const el = $("#vms-list");
  const count = $("#vm-count");
  if (!el || !count) return;

  count.textContent = vms.length;

  if (!vms.length) {
    el.innerHTML = '<p class="text-muted">No active VMs</p>';
    return;
  }

  el.innerHTML = vms.map((vm) => `
    <div class="vm-row">
      <div>
        <code>${esc(vm.vmId || "—")}</code>
        <span class="badge badge-active">${esc(vm.status)}</span>
      </div>
      <div class="text-muted">
        ${vm.requesterHandle
          ? `<a href="https://bsky.app/profile/${esc(vm.requesterHandle)}" target="_blank">@${esc(vm.requesterHandle)}</a>`
          : esc(vm.requesterDid)}
      </div>
    </div>
  `).join("");
}

async function loadContracts(bidderKeyId, cursor) {
  const tbody = $("#contracts-body");
  const pager = $("#contracts-pager");
  const prevBtn = $("#prev-page");
  const nextBtn = $("#next-page");
  const info = $("#page-info");

  if (!tbody) return;

  try {
    const result = await fetchContracts(bidderKeyId, cursor);

    if (!result.contracts.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted">No contracts yet</td></tr>';
      if (pager) pager.classList.add("hidden");
      return;
    }

    tbody.innerHTML = result.contracts.map((c) => `
      <tr>
        <td><code>${esc(c.vmId || "—")}</code></td>
        <td>
          ${c.requesterHandle
            ? `<a href="https://bsky.app/profile/${esc(c.requesterHandle)}" target="_blank">@${esc(c.requesterHandle)}</a>`
            : esc(c.requesterDid)}
        </td>
        <td><span class="badge ${c.status === 'active' ? 'badge-active' : 'badge-stopped'}">${esc(c.status)}</span></td>
        <td class="text-muted">${c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "—"}</td>
      </tr>
    `).join("");

    if (pager) pager.classList.remove("hidden");
    if (prevBtn) prevBtn.disabled = !cursor;
    if (nextBtn) nextBtn.disabled = !result.cursor;
    if (info) info.textContent = cursor ? "Page" : "Latest";

    // Pagination buttons
    if (prevBtn) {
      prevBtn.onclick = () => loadContracts(bidderKeyId, undefined);
    }
    if (nextBtn) {
      nextBtn.onclick = () => loadContracts(bidderKeyId, result.cursor);
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="error">Error: ${esc(err.message)}</td></tr>`;
  }
}

// ── VM WebSocket ───────────────────────────────────────────────────────

let closeVmStream = null;

function startVmStream() {
  if (closeVmStream) closeVmStream();

  closeVmStream = connectVmStream(
    // onSnapshot
    (vms) => {
      state.activeVms = vms;
      renderVms(vms);
    },
    // onUpdate
    (vm) => {
      // Find and update or add
      const idx = state.activeVms.findIndex((v) => v.vmId === vm.vmId);
      if (idx >= 0) {
        if (vm.eventType === "deleted" || vm.eventType === "completed") {
          state.activeVms.splice(idx, 1);
        } else {
          state.activeVms[idx] = { ...state.activeVms[idx], ...vm };
        }
      } else if (vm.eventType === "provisioned") {
        state.activeVms.push({
          vmId: vm.vmId,
          requesterDid: vm.requesterDid,
          requesterHandle: vm.requesterHandle,
          status: "active",
        });
      }
      renderVms(state.activeVms);
      // Refresh contracts
      if (selectedBidderId) loadContracts(selectedBidderId);
    },
    // onStatusChange
    (status) => {
      const indicator = $("#ws-indicator");
      if (indicator) {
        indicator.className = `ws-indicator ws-${status === "connected" ? "connected" : "disconnected"}`;
        indicator.title = status;
      }
    },
  );
}

// ── Init ───────────────────────────────────────────────────────────────

function init() {
  // Start bidder button
  const btn = $("#start-bidder-btn");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Starting…";
      const status = $("#start-status");
      if (status) {
        status.classList.remove("hidden");
        status.innerHTML = '<span class="badge badge-starting">Starting bidder…</span>';
      }
      try {
        const result = await startBidder();
        if (status) {
          status.innerHTML = `<span class="badge badge-active">Bidder started! (ID: ${result.bidderKeyId})</span>`;
        }
        selectedBidderId = result.bidderKeyId;
        // Poll will switch to dashboard
      } catch (err) {
        if (status) {
          status.innerHTML = `<span class="error">Failed: ${esc(err.message)}</span>`;
        }
        btn.disabled = false;
        btn.textContent = "Retry";
      }
    });
  }

  // Start polling
  poll();
  pollTimer = setInterval(poll, 3000);

  // Start VM WebSocket
  startVmStream();
}

// Run on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
