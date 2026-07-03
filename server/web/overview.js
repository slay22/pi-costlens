/**
 * Overview page logic — fetches /api/overview, renders tables and stats.
 * No charts yet (step 5). Refresh button + automatic refresh on load.
 */

const $ = (sel) => document.querySelector(sel);
const fmt = (n, digits = 4) => `$${Number(n).toFixed(digits)}`;
const fmtInt = (n) => Number(n).toLocaleString();

async function load() {
  const res = await fetch("/api/overview");
  if (!res.ok) {
    document.body.innerHTML = `<pre style="padding:24px;color:#ff6b6b">Failed to load overview: HTTP ${res.status}</pre>`;
    return;
  }
  const data = await res.json();
  render(data);
}

function capClass(cost, cap) {
  if (cap == null || cap <= 0) return "";
  if (cost > cap) return "over-cap";
  if (cost / cap >= 0.8) return "near-cap";
  if (cost / cap >= 0.5) return "warn-cap";
  return "ok";
}

function render(o) {
  // Summary stats
  $("#stat-cost").textContent = fmt(o.totalCost);
  $("#stat-cost").className = `value ${capClass(o.totalCost, o.topFeatures.reduce((s, f) => s + f.cost, 0) || null)}`;
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
  const tfBody = $("#top-features tbody");
  tfBody.innerHTML = o.topFeatures.map(f => `
    <tr>
      <td><a href="/feature/${encodeURIComponent(f.id)}">${escape(f.name)}</a></td>
      <td><span class="badge ${f.status}">${f.status}</span></td>
      <td class="num">${fmtInt(f.turns)}</td>
      <td class="num">${fmt(f.cost)}</td>
    </tr>
  `).join("");

  // byDay table
  const dayBody = $("#by-day tbody");
  dayBody.innerHTML = o.byDay.length === 0
    ? `<tr><td colspan="3" class="muted">No activity in the last 30 days</td></tr>`
    : o.byDay.map(d => `
      <tr>
        <td>${escape(d.date)}</td>
        <td class="num">${fmtInt(d.turns)}</td>
        <td class="num">${fmt(d.cost)}</td>
      </tr>
    `).join("");

  // byModel table
  const modelBody = $("#by-model tbody");
  modelBody.innerHTML = o.byModel.length === 0
    ? `<tr><td colspan="5" class="muted">No messages yet</td></tr>`
    : o.byModel.map(m => `
      <tr>
        <td>${escape(m.model)}</td>
        <td class="num">${fmtInt(m.turns)}</td>
        <td class="num">${fmtInt(m.inputTokens)}</td>
        <td class="num">${fmtInt(m.outputTokens)}</td>
        <td class="num">${fmt(m.cost)}</td>
      </tr>
    `).join("");

  // byStatus list
  const statusEl = $("#by-status");
  statusEl.innerHTML = [
    ["open", o.byStatus.open],
    ["done", o.byStatus.done],
    ["abandoned", o.byStatus.abandoned],
    ["merged", o.byStatus.merged],
    ["unassigned", o.byStatus.unassigned],
  ].map(([k, n]) => `<li><span class="badge ${k}">${k}</span> ${n}</li>`).join("");
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

$("#refresh").addEventListener("click", load);
load();
