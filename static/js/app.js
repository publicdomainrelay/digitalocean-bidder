// Main app logic — login/dashboard screens, status polling, VM stream, policy mode.

import { fetchStatus, startBidder, retryBidder, removeBidder, fetchContracts, connectVmStream, patchPolicyMode } from "./api.js";

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
  publicOrigin: "",
  activeVms: [],
  policyMode: null,
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

    // Update serve URL in login screen
    const serveEl = $("#serve-url-login");
    if (serveEl) serveEl.textContent = (s.publicOrigin || s.serveBaseUrl) || "";

    // ATProto status
    if (s.atpReady && !prev.atpReady) showAtpReady(s.atpHandle, s.atpDid);
    if (!s.atpReady && prev.atpReady) showAtpPending();

    // DO status
    if (s.doReady && !prev.doReady) showDoReady(s.doTeamUuid);
    if (!s.doReady && prev.doReady) showDoPending();

    if (!s.doConfigured) {
      const doActions = $("#do-actions");
      if (doActions) doActions.classList.add("hidden");
      const doStatus = $("#do-status");
      if (doStatus) doStatus.innerHTML = '<span class="badge badge-pending">Not configured</span>';
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
      renderAccounts(s.bidders);
      renderVms(s.activeVms);
      renderPolicyMode(s.policyMode);
      if (!selectedBidderId && s.bidders.length > 0) {
        selectedBidderId = s.bidders[0].id;
      }
      // Show policy panel when accounts exist
      const policyPanel = $("#policy-panel");
      if (policyPanel) policyPanel.classList.remove("hidden");
    }

    // Public URL in dashboard header
    const publicUrlEl = $("#public-url-dash");
    if (publicUrlEl && s.publicOrigin) {
      publicUrlEl.textContent = s.publicOrigin;
    } else if (publicUrlEl && s.serveBaseUrl) {
      publicUrlEl.textContent = s.serveBaseUrl;
    }

  } catch (err) {
    if (err.message === "UNAUTHORIZED") {
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

function renderAccounts(bidders) {
  const el = $("#accounts-list");
  if (!el) return;

  const badges = {
    running: '<span class="badge badge-running">Running</span>',
    failed: '<span class="badge badge-failed">Failed</span>',
    stopped: '<span class="badge badge-stopped">Stopped</span>',
    starting: '<span class="badge badge-starting">Starting</span>',
  };

  el.innerHTML = bidders.map((b) => `
    <div class="account-row${selectedBidderId === b.id ? ' selected' : ''}" data-id="${b.id}">
      <div class="account-info">
        <strong>@${esc(b.atprotoHandle)}</strong>
        <div class="account-meta">
          <span class="text-muted">DO: ${esc(b.doTeamUuid)}</span>
          <span class="text-muted">${b.contracts} contracts &middot; ${b.activeVms} active VMs</span>
          ${b.errorMessage ? `<span class="error">${esc(b.errorMessage)}</span>` : ""}
        </div>
      </div>
      <div class="account-actions">
        ${badges[b.status] || badges.stopped}
        ${b.status === "failed"
          ? `<button class="btn btn-sm btn-outline retry-btn" data-id="${b.id}">Retry</button>`
          : ""}
        <button class="btn btn-sm btn-danger remove-btn" data-id="${b.id}">Remove</button>
      </div>
    </div>
  `).join("");

  el.querySelectorAll(".account-row").forEach((row) => {
    row.addEventListener("click", () => {
      selectedBidderId = parseInt(row.dataset.id);
      renderAccounts(bidders);
      loadContracts(selectedBidderId);
    });
  });

  el.querySelectorAll(".retry-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "Retrying…";
      try { await retryBidder(parseInt(btn.dataset.id)); } catch (err) { alert(`Retry failed: ${err.message}`); }
      setTimeout(poll, 1000);
    });
  });

  el.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Remove this account? Contracts stay in DB.")) return;
      try { await removeBidder(parseInt(btn.dataset.id)); selectedBidderId = null; await poll(); } catch (err) { alert(`Remove failed: ${err.message}`); }
    });
  });
}

function renderPolicyMode(policyMode) {
  const el = $("#policy-selector");
  if (!el) return;

  const modes = [
    { value: "only_me", label: "Only me", desc: "Only accept RFPs from your own ATProto identity" },
    { value: "direct_network", label: "Direct network", desc: "Accept RFPs from identities in your direct ATProto network" },
    { value: "policy_based", label: "Policy-based", desc: "Accept RFPs based on RBAC allowlist policies" },
  ];

  el.innerHTML = `
    <div class="policy-select">
      <select id="policy-mode-select">
        ${modes.map((m) => `<option value="${m.value}"${policyMode === m.value ? ' selected' : ''}>${m.label}</option>`).join("")}
      </select>
      <span class="text-muted" id="policy-desc">${modes.find((m) => m.value === policyMode)?.desc || modes[0].desc}</span>
    </div>
  `;

  const select = $("#policy-mode-select");
  const desc = $("#policy-desc");
  if (select) {
    select.addEventListener("change", async () => {
      const val = select.value;
      desc.textContent = modes.find((m) => m.value === val)?.desc || "";
      try {
        await patchPolicyMode(val);
        state.policyMode = val;
      } catch (err) {
        alert(`Failed to update policy: ${err.message}`);
        select.value = state.policyMode || "only_me";
      }
    });
  }
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

    if (prevBtn) prevBtn.onclick = () => loadContracts(bidderKeyId, undefined);
    if (nextBtn) nextBtn.onclick = () => loadContracts(bidderKeyId, result.cursor);
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="error">Error: ${esc(err.message)}</td></tr>`;
  }
}

// ── VM WebSocket ───────────────────────────────────────────────────────

let closeVmStream = null;

function startVmStream() {
  if (closeVmStream) closeVmStream();
  closeVmStream = connectVmStream(
    (vms) => { state.activeVms = vms; renderVms(vms); },
    (vm) => {
      const idx = state.activeVms.findIndex((v) => v.vmId === vm.vmId);
      if (idx >= 0) {
        if (vm.eventType === "deleted" || vm.eventType === "completed") {
          state.activeVms.splice(idx, 1);
        } else {
          state.activeVms[idx] = { ...state.activeVms[idx], ...vm };
        }
      } else if (vm.eventType === "provisioned") {
        state.activeVms.push({ vmId: vm.vmId, requesterDid: vm.requesterDid, requesterHandle: vm.requesterHandle, status: "active" });
      }
      renderVms(state.activeVms);
      if (selectedBidderId) loadContracts(selectedBidderId);
    },
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
  const btn = $("#start-bidder-btn");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Starting…";
      const status = $("#start-status");
      if (status) { status.classList.remove("hidden"); status.innerHTML = '<span class="badge badge-starting">Starting bidder…</span>'; }
      try {
        const result = await startBidder();
        if (status) { status.innerHTML = `<span class="badge badge-active">Bidder started! (ID: ${result.bidderKeyId})</span>`; }
        selectedBidderId = result.bidderKeyId;
      } catch (err) {
        if (status) { status.innerHTML = `<span class="error">Failed: ${esc(err.message)}</span>`; }
        btn.disabled = false;
        btn.textContent = "Retry";
      }
    });
  }

  poll();
  pollTimer = setInterval(poll, 3000);
  startVmStream();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
