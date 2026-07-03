/**
 * Overview page logic — fetches /api/overview, renders tables, stats,
 * and uPlot charts. Manual refresh only (overview page).
 *
 * Charts: cost-by-day (line, last 30d), cost-by-model (bar, all-time).
 * Themed via CSS variables defined in style.css; uPlot reads them at
 * render time.
 */

const $ = (sel) => document.querySelector(sel);
const fmt = (n, digits = 4) => `$${Number(n).toFixed(digits)}`;
const fmtInt = (n) => Number(n).toLocaleString();

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---- uPlot helpers ----

function readTheme() {
  return {
    fg: cssVar("--text") || "#e6e8eb",
    grid: cssVar("--border") || "#2c313b",
    axis: cssVar("--text-dim") || "#9aa0a8",
    line: cssVar("--accent") || "#5dd39e",
    bar: cssVar("--accent") || "#5dd39e",
  };
}

function daySeconds(iso) {
  // YYYY-MM-DD -> epoch seconds (LOCAL midnight).
  // We deliberately omit the `Z` so Date.parse interprets the string as
  // local time, not UTC. Otherwise the cursor would show "2:00am" in
  // CEST for what is meant to be the start of the day.
  return Math.floor(new Date(iso + "T00:00:00").getTime() / 1000);
}

function renderDayChart(el, byDay) {
  el.innerHTML = "";
  if (!byDay || byDay.length === 0) {
    el.innerHTML = `<p class="muted">No data</p>`;
    return;
  }
  const xs = byDay.map((d) => daySeconds(d.date));
  const ys = byDay.map((d) => d.cost);
  const t = readTheme();
  const data = [xs, ys];
  const opts = {
    width: el.clientWidth || 600,
    height: 220,
    padding: [10, 10, 10, 10],
    cursor: { drag: { x: true, y: false } },
    scales: {
      x: { time: true },
      y: { auto: true },
    },
    axes: [
      {
        stroke: t.axis,
        grid: { stroke: t.grid, width: 0.5 },
        ticks: { stroke: t.grid, width: 0.5 },
        font: "12px -apple-system, system-ui, sans-serif",
      },
      {
        stroke: t.axis,
        grid: { stroke: t.grid, width: 0.5 },
        ticks: { stroke: t.grid, width: 0.5 },
        font: "12px -apple-system, system-ui, sans-serif",
        size: 60,
        values: (_self, vals) => vals.map((v) => "$" + v.toFixed(v < 0.1 ? 4 : 2)),
      },
    ],
    series: [
      {},
      {
        stroke: t.line,
        width: 2,
        fill: t.line + "22",
        points: { show: true, size: 4, stroke: t.line, fill: t.line },
        value: (_u, v) => (v == null ? "—" : "$" + v.toFixed(4)),
      },
    ],
  };
  // eslint-disable-next-line no-undef
  new uPlot(opts, data, el);
}

function renderModelChart(el, byModel) {
  el.innerHTML = "";
  if (!byModel || byModel.length === 0) {
    el.innerHTML = `<p class="muted">No data</p>`;
    return;
  }
  const labels = byModel.map((m) => m.model);
  // X is the categorical index, Y is the cost (so the bars are vertical).
  const xs = byModel.map((_, i) => i);
  const ys = byModel.map((m) => m.cost);
  const t = readTheme();
  const data = [xs, ys];
  const opts = {
    width: el.clientWidth || 600,
    height: 220,
    padding: [10, 10, 10, 10],
    cursor: { show: false },
    scales: {
      x: { time: false },
      y: { auto: true, range: (_u, min, max) => [0, max * 1.1 || 1] },
    },
    axes: [
      {
        stroke: t.axis,
        values: (_u, vals) => vals.map((v) => labels[v] ?? ""),
        font: "11px -apple-system, system-ui, sans-serif",
        size: 80,
        gap: 4,
      },
      {
        stroke: t.axis,
        grid: { stroke: t.grid, width: 0.5 },
        ticks: { stroke: t.grid, width: 0.5 },
        font: "12px -apple-system, system-ui, sans-serif",
        size: 60,
        values: (_self, vals) => vals.map((v) => "$" + v.toFixed(v < 0.1 ? 4 : 2)),
      },
    ],
    series: [
      {},
      {
        label: "cost",
        stroke: t.bar,
        fill: t.bar + "cc",
        paths: uPlot.paths.bars({ size: [0.6, 1, 1] }),
        value: (_u, v) => (v == null ? "—" : "$" + v.toFixed(4)),
      },
    ],
  };
  // eslint-disable-next-line no-undef
  new uPlot(opts, data, el);
}

// ---- main render ----

async function load() {
  setConn("loading", "…");
  let res;
  try {
    res = await fetch("/api/overview");
  } catch (err) {
    setConn("error", "offline");
    showError(`Network error: ${err.message}`);
    return;
  }
  if (!res.ok) {
    setConn("error", `HTTP ${res.status}`);
    showError(`Failed to load overview: HTTP ${res.status}`);
    return;
  }
  setConn("ok", "ok");
  const data = await res.json();
  render(data);
}

function setConn(level, text) {
  const el = $("#conn-status");
  el.className = `status ${level}`;
  el.textContent = text;
}

function showError(msg) {
  // Soft error: keep the page, show a banner at the top of <main>.
  let banner = document.getElementById("error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "error-banner";
    banner.className = "banner error";
    document.querySelector("main").prepend(banner);
  }
  banner.textContent = msg;
}

function clearError() {
  const b = document.getElementById("error-banner");
  if (b) b.remove();
}

function render(o) {
  clearError();
  // Summary stats
  $("#stat-cost").textContent = fmt(o.totalCost);
  $("#stat-cost").className = "value";
  $("#stat-turns").textContent = fmtInt(o.totalTurns);
  $("#stat-features").textContent = `${o.totalFeatures} (${o.byStatus.open} open, ${o.byStatus.done} done, ${o.byStatus.abandoned} abandoned)`;
  if (o.currentFeature) {
    const cf = o.currentFeature;
    $("#stat-current").textContent = `${cf.name}  ${fmt(cf.cost)}  ▏${cf.turns} turns`;
    $("#stat-current").classList.add("small");
    $("#current-feature").textContent = cf.id;
  } else {
    $("#stat-current").textContent = "—";
    $("#current-feature").textContent = "(none)";
  }

  // Top features table
  $("#top-features tbody").innerHTML = o.topFeatures.length === 0
    ? `<tr><td colspan="4" class="muted">No features yet</td></tr>`
    : o.topFeatures.map(f => `
      <tr>
        <td><a href="/feature/${encodeURIComponent(f.id)}">${escape(f.name)}</a></td>
        <td><span class="badge ${f.status}">${f.status}</span></td>
        <td class="num">${fmtInt(f.turns)}</td>
        <td class="num">${fmt(f.cost)}</td>
      </tr>
    `).join("");

  // byDay: fill in any missing 0-days (defensive — server does this too)
  const byDay = o.byDay || [];
  $("#by-day tbody").innerHTML = byDay.length === 0
    ? `<tr><td colspan="3" class="muted">No activity in the last 30 days</td></tr>`
    : byDay.map(d => `
      <tr>
        <td>${escape(d.date)}</td>
        <td class="num">${fmtInt(d.turns)}</td>
        <td class="num">${fmt(d.cost)}</td>
      </tr>
    `).join("");

  // byModel
  const byModel = o.byModel || [];
  $("#by-model tbody").innerHTML = byModel.length === 0
    ? `<tr><td colspan="5" class="muted">No messages yet</td></tr>`
    : byModel.map(m => `
      <tr>
        <td>${escape(m.model)}</td>
        <td class="num">${fmtInt(m.turns)}</td>
        <td class="num">${fmtInt(m.inputTokens)}</td>
        <td class="num">${fmtInt(m.outputTokens)}</td>
        <td class="num">${fmt(m.cost)}</td>
      </tr>
    `).join("");

  // byStatus list
  $("#by-status").innerHTML = [
    ["open", o.byStatus.open],
    ["done", o.byStatus.done],
    ["abandoned", o.byStatus.abandoned],
    ["merged", o.byStatus.merged],
    ["unassigned", o.byStatus.unassigned],
  ].map(([k, n]) => `<li><span class="badge ${k}">${k}</span> ${n}</li>`).join("");

  // Charts (after layout, so width is correct)
  requestAnimationFrame(() => {
    renderDayChart($("#by-day-chart"), byDay);
    renderModelChart($("#by-model-chart"), byModel);
  });
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

$("#refresh").addEventListener("click", load);
load();
