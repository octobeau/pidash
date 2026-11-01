// ── State ─────────────────────────────────────────────────────────────────
const state = {
  servers: [],
  snapshot: null,
  autoRefresh: true,
  refreshSeconds: 30,
  countdown: 30,
  timer: null,
  countdownTimer: null,
  encryptionConfigured: false,
  deletedServerIds: [],
  csrfToken: null,
  historyRange: "24h",
  historyData: null,
  queryServerId: null,
  queryFilter: "",
  queryData: null,
  alerts: [],
  alertsOpen: false,
  theme: localStorage.getItem("theme") || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
};

// ── DOM references ────────────────────────────────────────────────────────
const els = {
  subtitle:           document.querySelector("#subtitle"),
  summaryGrid:        document.querySelector("#summaryGrid"),
  overview:           document.querySelector("#overview"),
  lists:              document.querySelector("#lists"),
  history:            document.querySelector("#history"),
  historyContent:     document.querySelector("#historyContent"),
  queries:            document.querySelector("#queries"),
  queriesContent:     document.querySelector("#queriesContent"),
  queryFilter:        document.querySelector("#queryFilter"),
  queryToolbar:       document.querySelector("#queryToolbar"),
  queryServerTabs:    document.querySelector("#queryServerTabs"),
  compare:            document.querySelector("#compare"),
  refreshLabel:       document.querySelector("#refreshLabel"),
  liveDot:            document.querySelector("#liveDot"),
  autoButton:         document.querySelector("#autoButton"),
  refreshButton:      document.querySelector("#refreshButton"),
  settingsButton:     document.querySelector("#settingsButton"),
  settingsDialog:     document.querySelector("#settingsDialog"),
  settingsServers:    document.querySelector("#settingsServers"),
  settingsError:      document.querySelector("#settingsError"),
  refreshSeconds:     document.querySelector("#refreshSeconds"),
  addServerButton:    document.querySelector("#addServerButton"),
  reloadServersButton:document.querySelector("#reloadServersButton"),
  saveSettingsButton: document.querySelector("#saveSettingsButton"),
  alertsButton:       document.querySelector("#alertsButton"),
  alertsPanel:        document.querySelector("#alertsPanel"),
  alertsList:         document.querySelector("#alertsList"),
  alertBadge:         document.querySelector("#alertBadge"),
  dismissAlertsButton:document.querySelector("#dismissAlertsButton"),
  themeButton:        document.querySelector("#themeButton"),
  themeLabel:         document.querySelector("#themeLabel"),
  toast:              document.querySelector("#toast"),
  rangePills:         document.querySelector("#rangePills")
};

// ── Init ──────────────────────────────────────────────────────────────────
init();

async function init() {
  applyTheme(state.theme);
  await fetchCsrfToken();
  bindEvents();
  await loadConfig();
  await refresh();
  startTimers();
  loadAlerts();
}

// ── Theme ─────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  els.themeLabel.textContent = theme === "dark" ? "☀" : "☾";
  els.themeButton.dataset.icon = theme === "dark" ? "☀" : "☾";
  localStorage.setItem("theme", theme);
}

// ── CSRF ──────────────────────────────────────────────────────────────────
async function fetchCsrfToken() {
  try {
    const data = await (await fetch("/api/csrf-token")).json();
    state.csrfToken = data.token || null;
  } catch {
    // Non-fatal; origin-check fallback will still work
  }
}

// ── Events ────────────────────────────────────────────────────────────────
function bindEvents() {
  els.refreshButton.addEventListener("click", () => refresh(true));
  els.autoButton.addEventListener("click", () => {
    state.autoRefresh = !state.autoRefresh;
    els.autoButton.classList.toggle("active", state.autoRefresh);
    els.autoButton.setAttribute("aria-pressed", state.autoRefresh);
    startTimers();
  });
  els.settingsButton.addEventListener("click", openSettings);
  els.addServerButton.addEventListener("click", () => {
    state.servers = readSettingsServers({ includeEmpty: true });
    state.servers.push(newServer());
    renderSettings();
  });
  els.reloadServersButton.addEventListener("click", () => loadConfig().then(renderSettings));
  els.saveSettingsButton.addEventListener("click", saveSettings);

  els.alertsButton.addEventListener("click", toggleAlerts);
  els.dismissAlertsButton.addEventListener("click", dismissAlerts);

  els.themeButton.addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  els.rangePills.querySelectorAll(".range-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      state.historyRange = pill.dataset.range;
      els.rangePills.querySelectorAll(".range-pill").forEach((p) => p.classList.toggle("active", p === pill));
      loadHistory();
    });
  });

  els.queryFilter.addEventListener("input", () => {
    state.queryFilter = els.queryFilter.value.toLowerCase();
    renderQueryTable();
  });

  // Close alerts panel on outside click
  document.addEventListener("click", (e) => {
    if (state.alertsOpen && !els.alertsPanel.contains(e.target) && !els.alertsButton.contains(e.target)) {
      closeAlerts();
    }
  });
}

// ── Config ────────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const data = await apiFetch("/api/config");
    state.servers = data.servers || [];
    state.encryptionConfigured = data.encryptionConfigured === true;
    state.deletedServerIds = [];
    if (!state.servers.length) state.servers = [newServer()];
  } catch {
    // Non-fatal — keep existing state
  }
}

// ── Refresh ───────────────────────────────────────────────────────────────
async function refresh(force = false) {
  els.refreshLabel.textContent = "Refreshing…";
  try {
    const body = force ? { force: true } : {};
    const snapshot = await apiFetch("/api/snapshot", { method: "POST", body: JSON.stringify(body) });
    state.snapshot = snapshot;
    state.countdown = state.refreshSeconds;
    document.title = `${snapshot.totals.online}/${snapshot.totals.total} online · PiDash`;
    render();
  } catch (error) {
    els.refreshLabel.textContent = "Refresh failed";
    els.liveDot.classList.remove("online");
  }
}

// ── Render ────────────────────────────────────────────────────────────────
function render() {
  const snap = state.snapshot;
  const online = snap?.totals?.online ?? 0;
  const total = snap?.totals?.total ?? state.servers.length;
  els.subtitle.textContent = `${online} of ${total} servers online`;
  els.liveDot.classList.toggle("online", online > 0);
  els.refreshLabel.textContent = `Updated ${new Date(snap.generatedAt).toLocaleTimeString()}`;
  renderSummary();
  renderOverview();
  renderLists();
  const activeTab = document.querySelector(".tab.active")?.dataset.tab;
  if (activeTab === "compare") renderCompare();
  if (activeTab === "history" && state.historyData) renderHistory();
  if (activeTab === "queries" && state.queryServerId !== null) renderQueryTable();
}

function renderSummary() {
  const t = state.snapshot?.totals || {};
  const metrics = [
    ["Total Queries", fmt(t.queries), "tone-green"],
    ["Blocked",       fmt(t.blocked), "tone-red"],
    ["Block Rate",    pct(t.blockRate), "tone-blue"],
    ["Domains",       fmt(t.domains), "tone-violet"],
    ["Forwarded",     fmt(t.forwarded), "tone-amber"],
    ["Clients",       fmt(t.clients), "tone-soft"]
  ];
  els.summaryGrid.innerHTML = metrics.map(([label, value, tone]) => `
    <article class="metric">
      <span>${escHtml(label)}</span>
      <strong class="${tone}">${escHtml(value)}</strong>
    </article>
  `).join("");
}

function renderOverview() {
  const servers = state.snapshot?.servers || [];
  if (!servers.length) {
    els.overview.innerHTML = `<div class="notice">Add at least one Pi-hole server in Settings.</div>`;
    return;
  }
  els.overview.innerHTML = `<div class="server-grid">${servers.map((s, i) => serverCard(s, i)).join("")}</div>`;
  servers.forEach((s, i) => {
    drawLineChart(`history-${i}`, s.history, s.color);
    bindBlockToggle(s.id, s.summary?.status, i);
  });
}

function serverCard(server, index) {
  const s = server.summary;
  const rate = Number(s.blockRate || 0);
  const blockingEnabled = s.status !== "disabled";
  return `
    <article class="server-card">
      <div class="card-head">
        <div class="server-title">
          <h3 title="${escAttr(server.name)}">${escHtml(server.name)}</h3>
          <p title="${escAttr(server.url)}">${escHtml(server.url)} · ${escHtml(formatVersion(server.version))}</p>
        </div>
        <div class="card-head-right">
          <span class="pill ${blockingEnabled ? "blocking-on" : "blocking-off"}">${blockingEnabled ? "Filtering" : "Paused"}</span>
          <button class="block-toggle" id="toggle-${index}" data-id="${escAttr(server.id)}" data-enabled="${blockingEnabled}" title="${blockingEnabled ? "Pause blocking" : "Resume blocking"}">
            ${blockingEnabled ? "Pause" : "Resume"}
          </button>
          <span class="pill ${server.online ? "online" : ""}">${server.online ? "Online" : "Offline"}</span>
        </div>
      </div>
      <div class="card-body">
        <div class="mini-grid">
          ${mini("Queries", fmt(s.queries), "tone-green")}
          ${mini("Blocked", fmt(s.blocked), "tone-red")}
          ${mini("Rate", pct(rate), "tone-blue")}
          ${mini("Cache", fmt(s.cached), "tone-amber")}
        </div>
        <div class="bar-block">
          <div class="bar-row"><span>Blocked Traffic</span><strong>${pct(rate)}</strong></div>
          <progress class="bar-progress" value="${Math.min(rate, 100)}" max="100"></progress>
        </div>
        <div class="chart-wrap">
          <canvas class="chart" id="history-${index}"></canvas>
          <div class="chart-legend">
            <span class="chart-legend-item"><span class="chart-legend-dot" style="background:${escAttr(server.color)}"></span>Queries</span>
            <span class="chart-legend-item"><span class="chart-legend-dot" style="background:#f97373"></span>Blocked</span>
          </div>
        </div>
        ${server.error ? `<p class="error-text">${escHtml(server.error)}</p>` : ""}
      </div>
    </article>
  `;
}

function bindBlockToggle(serverId, status, index) {
  const btn = document.getElementById(`toggle-${index}`);
  if (!btn) return;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const enabled = btn.dataset.enabled !== "true";
    btn.disabled = true;
    btn.textContent = "…";
    try {
      await apiFetch(`/api/servers/${serverId}/blocking`, {
        method: "POST",
        body: JSON.stringify({ enabled })
      });
      showToast(`Blocking ${enabled ? "resumed" : "paused"} on ${state.snapshot?.servers?.find((s) => String(s.id) === String(serverId))?.name || "server"}`);
      await refresh(true);
    } catch (err) {
      showToast(`Failed: ${err.message}`, true);
      btn.disabled = false;
      btn.textContent = enabled ? "Resume" : "Pause";
    }
  });
}

function renderLists() {
  const servers = state.snapshot?.servers || [];
  els.lists.innerHTML = `<div class="list-layout">${servers.map((server) => `
    <article class="server-card">
      <div class="card-head">
        <div class="server-title">
          <h3 title="${escAttr(server.name)}">${escHtml(server.name)}</h3>
          <p>Top activity</p>
        </div>
      </div>
      <div class="card-body">
        ${rankSection("Permitted Domains", server.topDomains)}
        ${rankSection("Blocked Domains", server.topBlocked)}
        ${rankSection("Clients", server.topClients)}
        ${rankSection("Upstreams", server.upstreams)}
      </div>
    </article>
  `).join("")}</div>`;
}

function renderCompare() {
  const servers = state.snapshot?.servers || [];
  if (!servers.length) {
    els.compare.innerHTML = `<div class="notice">No servers to compare.</div>`;
    return;
  }
  const rows = [
    ["Queries",    "queries",   fmt],
    ["Blocked",    "blocked",   fmt],
    ["Block Rate", "blockRate", pct],
    ["Domains",    "domains",   fmt],
    ["Forwarded",  "forwarded", fmt],
    ["Cached",     "cached",    fmt],
    ["Clients",    "clients",   fmt]
  ];
  els.compare.innerHTML = `
    <section class="wide-panel">
      <div class="chart-wrap">
        <canvas class="chart" id="compareChart" style="height:220px"></canvas>
      </div>
      <div class="compare-grid">
        <div class="compare-row">
          <strong>Metric</strong>
          ${servers.map((s) => `<strong title="${escAttr(s.name)}">${escHtml(s.name)}</strong>`).join("")}
        </div>
        ${rows.map(([label, key, formatter]) => `
          <div class="compare-row">
            <strong>${label}</strong>
            ${servers.map((s) => `<span>${escHtml(formatter(s.summary[key]))}</span>`).join("")}
          </div>
        `).join("")}
      </div>
    </section>
  `;
  drawBarChart("compareChart", servers);
}

// ── History tab ───────────────────────────────────────────────────────────
async function loadHistory() {
  els.historyContent.innerHTML = `<div class="notice">Loading…</div>`;
  try {
    const data = await apiFetch(`/api/history?range=${state.historyRange}`);
    state.historyData = data.history || [];
    renderHistory();
  } catch (err) {
    els.historyContent.innerHTML = `<div class="notice error-text">Failed to load history: ${escHtml(err.message)}</div>`;
  }
}

function renderHistory() {
  const servers = state.historyData || [];
  if (!servers.length || servers.every((s) => !s.points.length)) {
    els.historyContent.innerHTML = `<div class="notice">No history data yet. Data is collected on each snapshot refresh.</div>`;
    return;
  }
  els.historyContent.innerHTML = `<div class="history-grid">${servers.filter((s) => s.points.length).map((s, i) => `
    <article class="server-card">
      <div class="card-head">
        <div class="server-title">
          <h3>${escHtml(s.name)}</h3>
        </div>
      </div>
      <div class="card-body">
        <div class="chart-wrap">
          <canvas class="chart" id="hchart-${i}" style="height:200px"></canvas>
          <div class="chart-legend">
            <span class="chart-legend-item"><span class="chart-legend-dot" style="background:${escAttr(s.color)}"></span>Queries</span>
            <span class="chart-legend-item"><span class="chart-legend-dot" style="background:#f97373"></span>Blocked</span>
          </div>
        </div>
      </div>
    </article>
  `).join("")}</div>`;

  servers.filter((s) => s.points.length).forEach((s, i) => {
    drawLineChart(`hchart-${i}`, s.points, s.color);
  });
}

// ── Query Log tab ─────────────────────────────────────────────────────────
function initQueryTab() {
  const servers = state.snapshot?.servers || [];
  if (!servers.length) {
    els.queriesContent.innerHTML = `<div class="notice">No servers available.</div>`;
    return;
  }

  els.queryToolbar.hidden = false;
  els.queryServerTabs.innerHTML = servers.map((s) => `
    <button class="query-server-tab${String(state.queryServerId) === String(s.id) ? " active" : ""}" data-id="${escAttr(s.id)}">${escHtml(s.name)}</button>
  `).join("");

  els.queryServerTabs.querySelectorAll(".query-server-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.queryServerId = tab.dataset.id;
      state.queryData = null;
      els.queryServerTabs.querySelectorAll(".query-server-tab").forEach((t) => t.classList.toggle("active", t === tab));
      loadQueryLog();
    });
  });

  if (state.queryServerId !== null) renderQueryTable();
  else els.queriesContent.innerHTML = `<div class="notice">Select a server above to load its query log.</div>`;
}

async function loadQueryLog() {
  if (!state.queryServerId) return;
  els.queriesContent.innerHTML = `<div class="notice">Loading query log…</div>`;
  try {
    const data = await apiFetch(`/api/servers/${state.queryServerId}/queries?limit=200`);
    state.queryData = data.queries || [];
    renderQueryTable();
  } catch (err) {
    els.queriesContent.innerHTML = `<div class="notice error-text">Failed: ${escHtml(err.message)}</div>`;
  }
}

function renderQueryTable() {
  const queries = (state.queryData || []).filter((q) => {
    if (!state.queryFilter) return true;
    return (q.domain || "").toLowerCase().includes(state.queryFilter) ||
           (q.client || "").toLowerCase().includes(state.queryFilter);
  });

  if (!queries.length) {
    els.queriesContent.innerHTML = `<div class="notice">No queries found.</div>`;
    return;
  }

  els.queriesContent.innerHTML = `
    <div class="query-table-wrap">
      <table class="query-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Domain</th>
            <th>Client</th>
            <th>Type</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${queries.slice(0, 200).map((q) => {
            const statusClass = /block/i.test(q.status) ? "qstatus-blocked" : /cache/i.test(q.status) ? "qstatus-cached" : "qstatus-ok";
            const time = q.time ? new Date(q.time).toLocaleTimeString() : "";
            return `<tr>
              <td>${escHtml(time)}</td>
              <td title="${escAttr(q.domain)}">${escHtml(q.domain)}</td>
              <td>${escHtml(q.client)}</td>
              <td>${escHtml(q.type)}</td>
              <td class="${statusClass}">${escHtml(q.status)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ── Alerts ────────────────────────────────────────────────────────────────
async function loadAlerts() {
  try {
    const data = await apiFetch("/api/alerts");
    state.alerts = data.alerts || [];
    const unread = data.unread || 0;
    els.alertBadge.textContent = unread;
    els.alertBadge.hidden = unread === 0;
    if (state.alertsOpen) renderAlertsList();
  } catch {}
}

function toggleAlerts() {
  state.alertsOpen ? closeAlerts() : openAlerts();
}

function openAlerts() {
  state.alertsOpen = true;
  els.alertsPanel.hidden = false;
  els.alertsButton.setAttribute("aria-expanded", "true");
  renderAlertsList();
}

function closeAlerts() {
  state.alertsOpen = false;
  els.alertsPanel.hidden = true;
  els.alertsButton.setAttribute("aria-expanded", "false");
}

function renderAlertsList() {
  if (!state.alerts.length) {
    els.alertsList.innerHTML = `<div class="notice" style="border:0;padding:20px">No alerts</div>`;
    return;
  }
  els.alertsList.innerHTML = state.alerts.map((a) => `
    <div class="alert-item">
      <span class="alert-dot ${a.type}"></span>
      <span class="alert-msg">${escHtml(a.message)}</span>
      <span class="alert-time">${escHtml(relativeTime(a.created_at))}</span>
    </div>
  `).join("");
}

async function dismissAlerts() {
  try {
    await apiFetch("/api/alerts/read", { method: "POST", body: JSON.stringify({}) });
    state.alerts.forEach((a) => { a.read = 1; });
    els.alertBadge.hidden = true;
    renderAlertsList();
  } catch {}
}

// ── Settings ──────────────────────────────────────────────────────────────
function openSettings() {
  els.settingsError.hidden = true;
  renderSettings();
  els.settingsDialog.showModal();
}

function renderSettings() {
  els.refreshSeconds.value = state.refreshSeconds;
  const encNote = state.encryptionConfigured
    ? ""
    : `<div class="notice" style="margin-bottom:12px">Set <code>CONFIG_ENCRYPTION_KEY</code> before saving Pi-hole passwords.</div>`;
  els.settingsServers.innerHTML = `${encNote}${state.servers.map((server, index) => `
    <div class="settings-card" data-index="${index}" data-id="${escAttr(String(server.id || ""))}">
      <div class="form-grid">
        <label class="field"><span>Name</span><input data-field="name" value="${escAttr(server.name || "")}"></label>
        <label class="field"><span>URL</span><input data-field="url" value="${escAttr(server.url || "")}" placeholder="http://192.168.1.2"></label>
        <label class="field"><span>Password or Token</span><input data-field="password" type="password" value="" placeholder="${server.hasPassword ? "Stored encrypted" : "Optional"}"></label>
        ${server.hasPassword ? `<div class="field checkbox-field"><span>Stored Credential</span><label><input data-clear-password type="checkbox"> Clear stored password/token</label></div>` : ""}
        <label class="field"><span>API Version</span>
          <select data-field="version">
            <option value="auto" ${server.version === "auto" ? "selected" : ""}>Auto</option>
            <option value="6" ${server.version === "6" ? "selected" : ""}>v6</option>
            <option value="5" ${server.version === "5" ? "selected" : ""}>v5</option>
          </select>
        </label>
        <label class="field"><span>Color</span><input data-field="color" type="color" value="${escAttr(server.color || "#39d98a")}"></label>
        <label class="field"><span>Enabled</span>
          <select data-field="enabled">
            <option value="true" ${server.enabled !== false ? "selected" : ""}>Yes</option>
            <option value="false" ${server.enabled === false ? "selected" : ""}>No</option>
          </select>
        </label>
      </div>
      <div class="settings-toolbar settings-toolbar-end">
        <div>
          <button class="plain-button test-button" type="button" data-test="${index}">Test Connection</button>
          <div class="test-result" id="test-result-${index}" hidden></div>
        </div>
        <button class="plain-button" type="button" data-remove="${index}">Remove</button>
      </div>
    </div>
  `).join("")}`;

  els.settingsServers.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.servers = readSettingsServers({ includeEmpty: true });
      const [removed] = state.servers.splice(Number(btn.dataset.remove), 1);
      if (removed?.id) state.deletedServerIds.push(removed.id);
      renderSettings();
    });
  });

  els.settingsServers.querySelectorAll(".test-button").forEach((btn) => {
    btn.addEventListener("click", () => testConnection(Number(btn.dataset.test)));
  });
}

async function testConnection(index) {
  const servers = readSettingsServers({ includeEmpty: true });
  const server = servers[index];
  const resultEl = document.getElementById(`test-result-${index}`);
  if (!resultEl || !server?.id) {
    if (resultEl) { resultEl.hidden = false; resultEl.className = "test-result err"; resultEl.textContent = "Save the server first, then test."; }
    return;
  }
  resultEl.hidden = false;
  resultEl.className = "test-result";
  resultEl.textContent = "Testing…";
  try {
    const result = await apiFetch(`/api/servers/${server.id}/test`, { method: "POST", body: JSON.stringify({}) });
    if (result.online) {
      resultEl.className = "test-result ok";
      resultEl.textContent = `✓ Online · API v${result.version} · ${result.latencyMs}ms`;
    } else {
      resultEl.className = "test-result err";
      resultEl.textContent = `✗ Offline: ${result.error || "unknown error"}`;
    }
  } catch (err) {
    resultEl.className = "test-result err";
    resultEl.textContent = `✗ ${err.message}`;
  }
}

async function saveSettings() {
  state.servers = readSettingsServers({ includeEmpty: false });
  state.refreshSeconds = Math.max(10, Number(els.refreshSeconds.value || 30));
  els.saveSettingsButton.disabled = true;
  els.saveSettingsButton.textContent = "Saving…";
  els.settingsError.hidden = true;

  try {
    await Promise.all(state.deletedServerIds.map((id) => apiFetch(`/api/servers/${id}`, { method: "DELETE" })));
    for (const server of state.servers) {
      if (server.id) {
        await apiFetch(`/api/servers/${server.id}`, { method: "PUT", body: JSON.stringify(server) });
      } else {
        await apiFetch("/api/servers", { method: "POST", body: JSON.stringify(server) });
      }
    }
    await loadConfig();
    els.settingsDialog.close();
    showToast("Settings saved");
    await refresh(true);
    startTimers();
  } catch (error) {
    els.settingsError.textContent = error.message || "Failed to save settings.";
    els.settingsError.hidden = false;
  } finally {
    els.saveSettingsButton.disabled = false;
    els.saveSettingsButton.textContent = "Save";
  }
}

function readSettingsServers({ includeEmpty }) {
  return [...els.settingsServers.querySelectorAll(".settings-card")].map((card) => {
    const output = { id: card.dataset.id ? Number(card.dataset.id) : null };
    card.querySelectorAll("[data-field]").forEach((field) => {
      output[field.dataset.field] = field.value.trim();
    });
    output.enabled = output.enabled !== "false";
    if (card.querySelector("[data-clear-password]")?.checked) {
      output.password = "";
      output.clearPassword = true;
    } else if (!output.password) {
      delete output.password;
    }
    return output;
  }).filter((s) => includeEmpty || s.url);
}

function newServer() {
  const n = state.servers.length + 1;
  return { name: `Pi-hole ${n}`, url: "", password: "", version: "auto", color: ["#39d98a", "#4c9ffe", "#a78bfa"][n % 3], enabled: true };
}

// ── Tab switching ─────────────────────────────────────────────────────────
function switchTab(id) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === id));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === id));

  if (id === "compare") renderCompare();
  if (id === "history") { if (!state.historyData) loadHistory(); else renderHistory(); }
  if (id === "queries") initQueryTab();
}

// ── Timers ────────────────────────────────────────────────────────────────
function startTimers() {
  clearInterval(state.timer);
  clearInterval(state.countdownTimer);
  state.countdown = state.refreshSeconds;
  if (!state.autoRefresh) {
    els.refreshLabel.textContent = "Auto refresh paused";
    return;
  }
  state.timer = setInterval(() => { refresh(); loadAlerts(); }, state.refreshSeconds * 1000);
  state.countdownTimer = setInterval(() => {
    state.countdown = Math.max(0, state.countdown - 1);
    if (state.countdown > 0) els.refreshLabel.textContent = `Next refresh in ${state.countdown}s`;
  }, 1000);
}

// ── API fetch wrapper ─────────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.csrfToken && options.method && options.method !== "GET") {
    headers["X-CSRF-Token"] = state.csrfToken;
  }
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed with ${response.status}`);
  return data;
}

// ── Charts (HiDPI-aware) ──────────────────────────────────────────────────
function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = rect.width || canvas.offsetWidth || 600;
  const h = rect.height || canvas.offsetHeight || 170;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

function drawLineChart(id, points, color) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const { ctx, w, h } = setupCanvas(canvas);
  clearCanvas(ctx, w, h);
  if (!points?.length) return drawEmpty(ctx, h);
  drawSeries(ctx, points.map((p) => p.queries), w, h, color);
  drawSeries(ctx, points.map((p) => p.blocked), w, h, "#f97373");
}

function drawSeries(ctx, values, w, h, color) {
  const pad = 18;
  const max = Math.max(1, ...values);
  const aw = w - pad * 2;
  const ah = h - pad * 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad + (values.length === 1 ? aw / 2 : (i / (values.length - 1)) * aw);
    const y = pad + ah - (v / max) * ah;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawBarChart(id, servers) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const { ctx, w, h } = setupCanvas(canvas);
  clearCanvas(ctx, w, h);
  const max = Math.max(1, ...servers.map((s) => s.summary.queries));
  const pad = 28;
  const gap = 14;
  const barW = Math.max(24, (w - pad * 2 - gap * (servers.length - 1)) / servers.length);
  servers.forEach((s, i) => {
    const barH = (s.summary.queries / max) * (h - pad * 2);
    const x = pad + i * (barW + gap);
    const y = h - pad - barH;
    ctx.fillStyle = s.color;
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#9aaba7";
    ctx.font = `${Math.max(11, Math.min(14, barW / 3))}px system-ui`;
    ctx.textAlign = "center";
    ctx.fillText(fmt(s.summary.queries), x + barW / 2, h - 6);
  });
  ctx.textAlign = "start";
}

function clearCanvas(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(128,128,128,0.12)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

function drawEmpty(ctx, h) {
  ctx.fillStyle = "rgba(128,128,128,0.5)";
  ctx.font = "13px system-ui";
  ctx.fillText("No history data", 24, h / 2);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function rankSection(title, rows = []) {
  const content = rows.length
    ? rows.slice(0, 5).map((row, i) => `
      <div class="rank-row">
        <b>${i + 1}</b>
        <span title="${escAttr(row.label)}">${escHtml(row.label)}</span>
        <strong>${fmt(row.count)}</strong>
      </div>
    `).join("")
    : `<div class="rank-row"><b>-</b><span>No data</span><strong>0</strong></div>`;
  return `<div class="list-section"><span class="label">${escHtml(title)}</span>${content}</div>`;
}

function mini(label, value, tone) {
  return `<div class="mini"><span class="label">${escHtml(label)}</span><strong class="${tone}">${escHtml(value)}</strong></div>`;
}

function fmt(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatVersion(version) {
  return version && version !== "unknown" ? `API v${version}` : "API unknown";
}

function relativeTime(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function showToast(message, isError = false) {
  const t = els.toast;
  t.textContent = message;
  t.style.background = isError ? "var(--red)" : "var(--text)";
  t.style.color = isError ? "#fff" : "var(--bg)";
  t.classList.remove("hide");
  t.classList.add("show");
  setTimeout(() => {
    t.classList.remove("show");
    t.classList.add("hide");
  }, 3000);
}

function escHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function escAttr(value) {
  return escHtml(value).replace(/`/g, "&#96;");
}
