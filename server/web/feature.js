/**
 * Feature detail page logic — fetches /api/features/:id and
 * /api/features/:id/messages, renders the page. Auto-refreshes every
 * 5 seconds. No charts yet (step 5).
 */

const $ = (sel) => document.querySelector(sel);
const fmt = (n, digits = 4) => `$${Number(n).toFixed(digits)}`;
const fmtInt = (n) => Number(n).toLocaleString();

function getFeatureIdFromUrl() {
  // /feature/<encoded> -> last segment
  const seg = location.pathname.split("/").pop() || "";
  try { return decodeURIComponent(seg); } catch { return seg; }
}

const featureId = getFeatureIdFromUrl();

async function load() {
  try {
    const [feature, messages] = await Promise.all([
      fetch(`/api/features/${encodeURIComponent(featureId)}`).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
      fetch(`/api/features/${encodeURIComponent(featureId)}/messages?limit=100`).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
    ]);
    render(feature, messages);
  } catch (err) {
    document.body.innerHTML = `<pre style="padding:24px;color:#ff6b6b">Failed to load feature "${featureId}": ${err.message}</pre>`;
  }
}

function capClass(cost, cap) {
  if (cap == null || cap <= 0) return "";
  if (cost > cap) return "over-cap";
  if (cost / cap >= 0.8) return "near-cap";
  if (cost / cap >= 0.5) return "warn-cap";
  return "ok";
}

function render(f, msgs) {
  document.title = `Costlens · ${f.name}`;
  $("#feature-name").textContent = f.name;
  const badge = $("#feature-status");
  badge.textContent = f.status;
  badge.className = `badge ${f.status}`;

  $("#stat-cost").textContent = fmt(f.total_cost_usd);
  $("#stat-cost").className = `value ${capClass(f.total_cost_usd, f.cap_usd)}`;
  $("#stat-cap").textContent = f.cap_usd ? fmt(f.cap_usd, 2) : "—";
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

  // Messages (timeline placeholder — chart in step 5)
  const tbody = $("#timeline tbody");
  tbody.innerHTML = msgs.length === 0
    ? `<tr><td colspan="5" class="muted">No messages yet</td></tr>`
    : msgs.slice().reverse().map(m => `
      <tr>
        <td>${escape(m.timestamp?.replace("T", " ").slice(0, 19) ?? "")}</td>
        <td>${escape(m.model)}</td>
        <td class="num">${fmtInt(m.input_tokens)}</td>
        <td class="num">${fmtInt(m.output_tokens)}</td>
        <td class="num">${fmt(m.cost_usd)}</td>
      </tr>
    `).join("");
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

$("#refresh").addEventListener("click", load);
load();
setInterval(load, 5000);
