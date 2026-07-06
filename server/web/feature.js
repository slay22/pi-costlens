/**
 * Feature detail page logic — fetches /api/features/:id and
 * /api/features/:id/messages, renders the page, draws a uPlot cost
 * timeline, and auto-refreshes every 5 seconds.
 *
 * Cost-over-time chart: cumulative cost across this feature's messages,
 * one point per message. The recent-messages table below shows the
 * same data row-by-row for accessibility.
 */

const $ = (sel) => document.querySelector(sel);
const fmt = (n, digits = 4) => `$${Number(n).toFixed(4)}`;
const fmtInt = (n) => Number(n).toLocaleString();

function getFeatureIdFromUrl() {
  // /feature/<encoded> -> last segment
  const seg = location.pathname.split("/").pop() || "";
  try { return decodeURIComponent(seg); } catch { return seg; }
}

const featureId = getFeatureIdFromUrl();

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function readTheme() {
  return {
    fg: cssVar("--text") || "#e6e8eb",
    grid: cssVar("--border") || "#2c313b",
    axis: cssVar("--text-dim") || "#9aa0a8",
    line: cssVar("--accent") || "#5dd39e",
    over: cssVar("--over") || "#ff6b6b",
    near: cssVar("--high") || "#ffd166",
  };
}

/** Format an epoch-seconds value as "YYYY-MM-DD HH:MM" in 24-hour local time. */
function formatLocalTime(epochSec) {
  const d = new Date(epochSec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderTimelineChart(el, msgs, cap) {
  el.innerHTML = "";
  if (!msgs || msgs.length === 0) {
    el.innerHTML = `<p class="muted">No messages yet</p>`;
    return;
  }
  const xs = msgs.map((m) => Math.floor(Date.parse(m.timestamp) / 1000));
  // Cumulative cost
  let acc = 0;
  const cum = msgs.map((m) => (acc += Number(m.cost_usd) || 0));
  // Per-message cost
  const per = msgs.map((m) => Number(m.cost_usd) || 0);
  const t = readTheme();
  const data = [xs, cum, per];
  const seriesColors = [t.line, t.fg];
  // Determine the cap line as a series, or omit if no cap
  const hasCap = cap != null && cap > 0;
  if (hasCap) {
    data.push(xs.map(() => cap));
    seriesColors.push(t.over);
  }
  const opts = {
    width: el.clientWidth || 600,
    height: 240,
    padding: [10, 10, 10, 10],
    cursor: {
      drag: { x: true, y: false },
      // Override the default 12-hour time format. vals is [x, y]; we
      // format the x (epoch seconds) ourselves in 24-hour local time.
      values: (_self, vals) => vals.map((v, i) => {
        if (v == null) return "—";
        if (i === 0) return formatLocalTime(v);
        return "$" + Number(v).toFixed(Number(v) < 1 ? 4 : 2);
      }),
    },
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
        values: (_self, vals) => vals.map((v) => "$" + v.toFixed(v < 1 ? 4 : 2)),
      },
    ],
    series: [
      {},
      {
        label: "cumulative",
        stroke: t.line,
        width: 2,
        fill: t.line + "22",
        value: (_u, v) => (v == null ? "—" : "$" + v.toFixed(4)),
      },
      {
        label: "per message",
        stroke: t.fg,
        width: 1,
        points: { show: true, size: 3 },
        value: (_u, v) => (v == null ? "—" : "$" + v.toFixed(4)),
      },
      ...(hasCap
        ? [{
            label: "cap",
            stroke: t.over,
            width: 1,
            dash: [4, 4],
            points: { show: false },
            value: () => "",
          }]
        : []),
    ],
  };
  // eslint-disable-next-line no-undef
  new uPlot(opts, data, el);
}

let lastFeature = null;
let lastMessages = null;

async function load() {
  setConn("loading", "…");
  let feature, messages;
  try {
    const [fr, mr] = await Promise.all([
      fetch(`/api/features/${encodeURIComponent(featureId)}`),
      fetch(`/api/features/${encodeURIComponent(featureId)}/messages?limit=500`),
    ]);
    if (fr.status === 404) {
      setConn("error", "404");
      showError(`Feature "${featureId}" not found. <a href="/">Back to overview</a>`);
      return;
    }
    if (!fr.ok) throw new Error(`feature: HTTP ${fr.status}`);
    if (!mr.ok) throw new Error(`messages: HTTP ${mr.status}`);
    feature = await fr.json();
    messages = await mr.json();
  } catch (err) {
    setConn("error", "offline");
    showError(`Failed to load feature: ${escape(err.message)}. ` +
      `Retrying in 5s. <a href="/">Back to overview</a>`);
    return;
  }
  setConn("ok", "ok");
  lastFeature = feature;
  lastMessages = messages;
  render(feature, messages);
}

function setConn(level, text) {
  const el = $("#conn-status");
  if (!el) return;
  el.className = `status ${level}`;
  el.textContent = text;
}

function showError(msg) {
  let banner = document.getElementById("error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "error-banner";
    banner.className = "banner error";
    document.querySelector("main").prepend(banner);
  }
  banner.innerHTML = msg;
}

function clearError() {
  const b = document.getElementById("error-banner");
  if (b) b.remove();
}

function capClass(cost, cap) {
  if (cap == null || cap <= 0) return "";
  if (cost > cap) return "over-cap";
  if (cost / cap >= 0.8) return "near-cap";
  if (cost / cap >= 0.5) return "warn-cap";
  return "ok";
}

function render(f, msgs) {
  clearError();
  document.title = `Costlens · ${f.name}`;
  $("#feature-name").textContent = f.name;
  const badge = $("#feature-status");
  badge.textContent = f.status;
  badge.className = `badge ${f.status}`;

  $("#stat-cost").textContent = fmt(f.total_cost_usd);
  $("#stat-cost").className = `value ${capClass(f.total_cost_usd, f.cap_usd)}`;
  $("#stat-cap").textContent = f.cap_usd ? `$${f.cap_usd.toFixed(2)}` : "—";
  $("#stat-turns").textContent = fmtInt(f.turn_count);
  $("#stat-pricing").textContent = f.pricing_conf;
  $("#stat-pricing").className = `value small badge ${f.pricing_conf}`;

  $("#detail-branch").textContent = f.branch ?? "—";
  $("#detail-started").textContent = f.started_at?.replace("T", " ").slice(0, 19) ?? "—";
  $("#detail-last").textContent = f.last_activity_at?.replace("T", " ").slice(0, 19) ?? "—";
  $("#detail-in").textContent = fmtInt(f.total_input);
  $("#detail-out").textContent = fmtInt(f.total_output);
  $("#detail-cache-r").textContent = fmtInt(f.total_cache_read);
  $("#detail-cache-w").textContent = fmtInt(f.total_cache_write);
  $("#detail-models").textContent = f.recentModels?.join(", ") || "—";

  // Tags
  const tagsCard = $("#tags-card");
  if (f.tags && f.tags.length > 0) {
    tagsCard.hidden = false;
    $("#tags-list").innerHTML = f.tags
      .map((t) => `<span class="tag ${tagClass(t)}">${escape(t)}</span>`)
      .join(" ");
  } else {
    tagsCard.hidden = true;
  }

  // Notes
  const notesCard = $("#notes-card");
  if (f.notes && f.notes.length > 0) {
    notesCard.hidden = false;
    $("#notes-list").innerHTML = f.notes.map(n => `
      <li>
        ${escape(n.body)}
        <time>${escape(n.created_at?.replace("T", " ").slice(0, 19) ?? "")}</time>
      </li>
    `).join("");
  } else {
    notesCard.hidden = true;
  }

  // Recent messages (most recent first)
  const tbody = $("#timeline tbody");
  const reversed = msgs.slice().reverse();
  tbody.innerHTML = reversed.length === 0
    ? `<tr><td colspan="5" class="muted">No messages yet</td></tr>`
    : reversed.map(m => `
      <tr>
        <td>${escape(m.timestamp?.replace("T", " ").slice(0, 19) ?? "")}</td>
        <td>${escape(m.model)}</td>
        <td class="num">${fmtInt(m.input_tokens)}</td>
        <td class="num">${fmtInt(m.output_tokens)}</td>
        <td class="num">${fmt(m.cost_usd)}</td>
      </tr>
    `).join("");

  // Timeline chart
  requestAnimationFrame(() => {
    renderTimelineChart($("#timeline-chart"), msgs, f.cap_usd);
  });
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** Map a tag like "client:acme" to a CSS class for colour hints. */
function tagClass(tag) {
  const prefix = tag.split(/[:.]/)[0].toLowerCase();
  if (["client", "project", "type", "env", "team", "area"].includes(prefix)) {
    return `tag-${prefix}`;
  }
  return "";
}

$("#refresh").addEventListener("click", load);
load();
setInterval(load, 5000);
