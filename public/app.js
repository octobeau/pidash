const state = {
  dockerServers: [],
  servers: [],
  useDockerConfig: true,
  encryptionConfigured: false,
  deletedServerIds: [],
  snapshot: null,
  autoRefresh: true,
  refreshSeconds: 30,
  countdown: 30,
  timer: null,
  countdownTimer: null
};

const els = {
  subtitle: document.querySelector("#subtitle"),
  summaryGrid: document.querySelector("#summaryGrid"),
  overview: document.querySelector("#overview"),
  lists: document.querySelector("#lists"),
  compare: document.querySelector("#compare"),
  refreshLabel: document.querySelector("#refreshLabel"),
  liveDot: document.querySelector("#liveDot"),
  autoButton: document.querySelector("#autoButton"),
  refreshButton: document.querySelector("#refreshButton"),
  settingsButton: document.querySelector("#settingsButton"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsServers: document.querySelector("#settingsServers"),
  refreshSeconds: document.querySelector("#refreshSeconds"),
  addServerButton: document.querySelector("#addServerButton"),
  useDockerConfigButton: document.querySelector("#useDockerConfigButton"),
  saveSettingsButton: document.querySelector("#saveSettingsButton")
};

init();

async function init() {
  bindEvents();
  await loadConfig();
  await refresh();
  startTimers();
}

function bindEvents() {
  els.refreshButton.addEventListener("click", refresh);
  els.autoButton.addEventListener("click", () => {
    state.autoRefresh = !state.autoRefresh;
    els.autoButton.classList.toggle("active", state.autoRefresh);
    startTimers();
  });
  els.settingsButton.addEventListener("click", openSettings);
  els.addServerButton.addEventListener("click", () => {
    state.servers = readSettingsServers({ includeEmpty: true });
    state.servers.push(newServer());
    renderSettings();
  });
  els.useDockerConfigButton.addEventListener("click", () => {
    loadConfig().then(renderSettings);
  });
  els.saveSettingsButton.addEventListener("click", saveSettings);
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const data = await response.json();
  state.dockerServers = data.servers || [];
  state.encryptionConfigured = data.encryptionConfigured === true;
  state.servers = structuredClone(state.dockerServers);
  state.deletedServerIds = [];

  if (!state.servers.length) {
    state.servers = [newServer()];
  }
}

async function refresh() {
  els.refreshLabel.textContent = "Refreshing";
  try {
    const response = await fetch("/api/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    state.snapshot = await response.json();
    state.countdown = state.refreshSeconds;
    render();
  } catch (error) {
    els.refreshLabel.textContent = "Refresh failed";
    els.liveDot.classList.remove("online");
    console.error(error);
  }
}

function render() {
  const snapshot = state.snapshot;
  const online = snapshot?.totals?.online || 0;
  const total = snapshot?.totals?.total || state.servers.length;
  els.subtitle.textContent = `${online} of ${total} servers online`;
  els.liveDot.classList.toggle("online", online > 0);
  els.refreshLabel.textContent = `Updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`;
  renderSummary();
  renderOverview();
  renderLists();
  renderCompare();
}

function renderSummary() {
  const totals = state.snapshot?.totals || {};
  const metrics = [
    ["Total Queries", fmt(totals.queries), "tone-green"],
    ["Blocked", fmt(totals.blocked), "tone-red"],
    ["Block Rate", pct(totals.blockRate), "tone-blue"],
    ["Domains", fmt(totals.domains), "tone-violet"],
    ["Forwarded", fmt(totals.forwarded), "tone-amber"],
    ["Clients", fmt(totals.clients), "tone-soft"]
  ];
  els.summaryGrid.innerHTML = metrics.map(([label, value, tone]) => `
    <article class="metric">
      <span>${escapeHtml(label)}</span>
      <strong class="${tone}">${escapeHtml(value)}</strong>
    </article>
  `).join("");
}

function renderOverview() {
  const servers = state.snapshot?.servers || [];
  if (!servers.length) {
    els.overview.innerHTML = `<div class="notice">Add at least one Pi-hole server in Settings.</div>`;
    return;
  }

  els.overview.innerHTML = `<div class="server-grid">${servers.map((server, index) => serverCard(server, index)).join("")}</div>`;
  servers.forEach((server, index) => drawLineChart(`history-${index}`, server.history, server.color));
}

function serverCard(server, index) {
  const s = server.summary;
  const rate = Number(s.blockRate || 0);
  return `
    <article class="server-card">
      <div class="card-head">
        <div class="server-title">
          <h3>${escapeHtml(server.name)}</h3>
          <p>${escapeHtml(server.url)} · ${escapeHtml(formatVersion(server.version))}</p>
        </div>
        <span class="pill ${server.online ? "online" : ""}">${server.online ? "Online" : "Offline"}</span>
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
        <canvas class="chart" id="history-${index}" width="600" height="210"></canvas>
        ${server.error ? `<p class="error-text">${escapeHtml(server.error)}</p>` : ""}
      </div>
    </article>
  `;
}

function renderLists() {
  const servers = state.snapshot?.servers || [];
  els.lists.innerHTML = `<div class="list-layout">${servers.map((server) => `
    <article class="server-card">
      <div class="card-head">
        <div class="server-title">
          <h3>${escapeHtml(server.name)}</h3>
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
    ["Queries", "queries", fmt],
    ["Blocked", "blocked", fmt],
    ["Block Rate", "blockRate", pct],
    ["Domains", "domains", fmt],
    ["Forwarded", "forwarded", fmt],
    ["Cached", "cached", fmt],
    ["Clients", "clients", fmt]
  ];
  els.compare.innerHTML = `
    <section class="wide-panel">
      <canvas class="chart" id="compareChart" width="1200" height="260"></canvas>
      <div class="compare-grid">
        <div class="compare-row"><strong>Metric</strong>${servers.map((server) => `<strong>${escapeHtml(server.name)}</strong>`).join("")}</div>
        ${rows.map(([label, key, formatter]) => `
          <div class="compare-row">
            <strong>${label}</strong>
            ${servers.map((server) => `<span>${escapeHtml(formatter(server.summary[key]))}</span>`).join("")}
          </div>
        `).join("")}
      </div>
    </section>
  `;
  drawBarChart("compareChart", servers);
}

function rankSection(title, rows = []) {
  const content = rows.length
    ? rows.slice(0, 5).map((row, index) => `
      <div class="rank-row">
        <b>${index + 1}</b>
        <span>${escapeHtml(row.label)}</span>
        <strong>${fmt(row.count)}</strong>
      </div>
    `).join("")
    : `<div class="rank-row"><b>-</b><span>No data</span><strong>0</strong></div>`;
  return `<div class="list-section"><span class="label">${escapeHtml(title)}</span>${content}</div>`;
}

function mini(label, value, tone) {
  return `<div class="mini"><span class="label">${escapeHtml(label)}</span><strong class="${tone}">${escapeHtml(value)}</strong></div>`;
}

function openSettings() {
  els.useDockerConfigButton.textContent = "Reload Servers";
  renderSettings();
  els.settingsDialog.showModal();
}

function renderSettings() {
  els.refreshSeconds.value = state.refreshSeconds;
  els.addServerButton.disabled = false;
  const encryptionNotice = state.encryptionConfigured
    ? ""
    : `<div class="notice">Set CONFIG_ENCRYPTION_KEY before saving Pi-hole passwords.</div>`;
  els.settingsServers.innerHTML = `${encryptionNotice}${state.servers.map((server, index) => `
    <div class="settings-card" data-index="${index}" data-id="${escapeAttr(server.id || "")}">
      <div class="form-grid">
        <label class="field"><span>Name</span><input data-field="name" value="${escapeAttr(server.name || "")}"></label>
        <label class="field"><span>URL</span><input data-field="url" value="${escapeAttr(server.url || "")}" placeholder="http://192.168.1.2"></label>
        <label class="field"><span>Password or Token</span><input data-field="password" type="password" value="" placeholder="${server.hasPassword ? "Stored encrypted" : "Optional"}"></label>
        <label class="field"><span>API Version</span>
          <select data-field="version">
            <option value="auto" ${server.version === "auto" ? "selected" : ""}>Auto</option>
            <option value="6" ${server.version === "6" ? "selected" : ""}>v6</option>
            <option value="5" ${server.version === "5" ? "selected" : ""}>v5</option>
          </select>
        </label>
        <label class="field"><span>Color</span><input data-field="color" type="color" value="${escapeAttr(server.color || "#39d98a")}"></label>
        <label class="field"><span>Enabled</span>
          <select data-field="enabled">
            <option value="true" ${server.enabled !== false ? "selected" : ""}>Yes</option>
            <option value="false" ${server.enabled === false ? "selected" : ""}>No</option>
          </select>
        </label>
      </div>
      <div class="settings-toolbar settings-toolbar-end">
        <button class="plain-button" type="button" data-remove="${index}">Remove</button>
      </div>
    </div>
  `).join("")}`;

  els.settingsServers.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      state.servers = readSettingsServers({ includeEmpty: true });
      const [removed] = state.servers.splice(Number(button.dataset.remove), 1);
      if (removed?.id) state.deletedServerIds.push(removed.id);
      renderSettings();
    });
  });
}

async function saveSettings() {
  state.servers = readSettingsServers({ includeEmpty: false });
  state.refreshSeconds = Number(els.refreshSeconds.value || 30);
  try {
    await Promise.all(state.deletedServerIds.map((id) => apiFetch(`/api/servers/${id}`, { method: "DELETE" })));
    for (const server of state.servers) {
      if (server.id) {
        await apiFetch(`/api/servers/${server.id}`, {
          method: "PUT",
          body: JSON.stringify(server)
        });
      } else {
        await apiFetch("/api/servers", {
          method: "POST",
          body: JSON.stringify(server)
        });
      }
    }
    await loadConfig();
    els.settingsDialog.close();
    await refresh();
    startTimers();
  } catch (error) {
    alert(error.message || "Failed to save settings.");
  }
}

function readSettingsServers({ includeEmpty }) {
  return [...els.settingsServers.querySelectorAll(".settings-card")].map((card) => {
    const output = { id: card.dataset.id ? Number(card.dataset.id) : null };
    card.querySelectorAll("[data-field]").forEach((field) => {
      output[field.dataset.field] = field.value.trim();
    });
    output.enabled = output.enabled !== "false";
    if (!output.password) delete output.password;
    return output;
  }).filter((server) => includeEmpty || server.url);
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed with ${response.status}`);
  return data;
}

function newServer() {
  const number = state.servers.length + 1;
  return { name: `Pi-hole ${number}`, url: "", password: "", version: "auto", color: ["#39d98a", "#4c9ffe", "#a78bfa"][number % 3], enabled: true };
}

function startTimers() {
  clearInterval(state.timer);
  clearInterval(state.countdownTimer);
  state.countdown = state.refreshSeconds;
  if (!state.autoRefresh) {
    els.refreshLabel.textContent = "Auto refresh paused";
    return;
  }
  state.timer = setInterval(refresh, state.refreshSeconds * 1000);
  state.countdownTimer = setInterval(() => {
    state.countdown = Math.max(0, state.countdown - 1);
    if (state.countdown > 0) els.refreshLabel.textContent = `Next refresh in ${state.countdown}s`;
  }, 1000);
}

function switchTab(id) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === id));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === id));
  if (id === "compare") renderCompare();
}

function drawLineChart(id, points, color) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  clearCanvas(ctx, canvas);
  if (!points?.length) return drawEmpty(ctx, canvas);

  const values = points.map((point) => point.queries);
  const blocked = points.map((point) => point.blocked);
  drawSeries(ctx, canvas, values, color);
  drawSeries(ctx, canvas, blocked, "#f97373");
}

function drawSeries(ctx, canvas, values, color) {
  const pad = 18;
  const max = Math.max(1, ...values);
  const width = canvas.width - pad * 2;
  const height = canvas.height - pad * 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = pad + (values.length === 1 ? width : (index / (values.length - 1)) * width);
    const y = pad + height - (value / max) * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawBarChart(id, servers) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  clearCanvas(ctx, canvas);
  const max = Math.max(1, ...servers.map((server) => server.summary.queries));
  const pad = 28;
  const gap = 18;
  const barWidth = Math.max(28, (canvas.width - pad * 2 - gap * (servers.length - 1)) / servers.length);
  servers.forEach((server, index) => {
    const height = (server.summary.queries / max) * (canvas.height - pad * 2);
    const x = pad + index * (barWidth + gap);
    const y = canvas.height - pad - height;
    ctx.fillStyle = server.color;
    ctx.fillRect(x, y, barWidth, height);
    ctx.fillStyle = "#9aaba7";
    ctx.font = "24px system-ui";
    ctx.fillText(fmt(server.summary.queries), x, canvas.height - 4);
  });
}

function clearCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const y = (canvas.height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
}

function drawEmpty(ctx, canvas) {
  ctx.fillStyle = "#9aaba7";
  ctx.font = "24px system-ui";
  ctx.fillText("No history data", 24, canvas.height / 2);
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
