/**
 * Feature detail page logic — fetches /api/features/:id and
 * /api/features/:id/messages, renders the page, draws a uPlot cost
 * timeline, and auto-refreshes every 5 seconds.
 *
 * Phase 7.5: the page is no longer read-only. The Actions card lets
 * the user close / cancel / merge / reopen the feature, set or clear
 * the cap, add or remove tags, and attach notes — all without
 * leaving the dashboard. See PHASE7.5.md for the design.
 *
 *   - Status transitions: confirmation modal (close/cancel/merge),
 *     single button (reopen). Re-fetch the feature on success.
 *   - Cap: input + Set / Clear buttons. Inline validation.
 *   - Tags: optimistic add/remove with rollback on error.
 *   - Notes: form at the bottom of the Actions card; appends to the
 *     list and shows a success toast.
 *
 * The 5-second polling continues in the background; on a successful
 * write we trigger an immediate re-fetch so the rest of the page
 * reflects the new state without waiting up to 5s.
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

/**
 * Reload the feature from the server. The page's 5s polling
 * (`setInterval(load, 5000)`) calls this too, but write handlers
 * also call it after a successful mutation so the rest of the page
 * reflects the new state without waiting.
 */
async function load() {
  setConn("loading", "…");
  let feature, messages, subagents, subagentRuns, tools;
  try {
    const [fr, mr, sa, srn, tl] = await Promise.all([
      fetch(`/api/features/${encodeURIComponent(featureId)}`),
      fetch(`/api/features/${encodeURIComponent(featureId)}/messages?limit=500`),
      fetch(`/api/features/${encodeURIComponent(featureId)}/subagents`),
      fetch(`/api/features/${encodeURIComponent(featureId)}/subagent-runs`),
      fetch(`/api/features/${encodeURIComponent(featureId)}/tools`),
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
    // Sub-agent / tool endpoints: tolerate 404 (older servers may
    // not have them). Treat any failure as "empty".
    subagents = sa.ok ? await sa.json() : [];
    subagentRuns = srn.ok ? await srn.json() : [];
    tools = tl.ok ? await tl.json() : [];
  } catch (err) {
    setConn("error", "offline");
    showError(`Failed to load feature: ${escape(err.message)}. ` +
      `Retrying in 5s. <a href="/">Back to overview</a>`);
    return;
  }
  setConn("ok", "ok");
  lastFeature = feature;
  lastMessages = messages;
  render(feature, messages, subagents, subagentRuns, tools);
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

function render(f, msgs, subagents, subagentRuns, tools) {
  clearError();
  document.title = `Costlens · ${f.name}`;
  $("#feature-name").textContent = f.name;
  const badge = $("#feature-status");
  badge.textContent = f.status;
  badge.className = `badge ${f.status}`;

  // Phase 7: total = parent + sub-agent cost. The cap is against the
  // combined total (matches the "actual spend" intuition).
  const subCost = Number(f.subagent_cost_usd ?? 0);
  const totalCost = Number(f.total_cost_usd) + subCost;
  $("#stat-cost").textContent = fmt(totalCost);
  $("#stat-cost").className = `value ${capClass(totalCost, f.cap_usd)}`;
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

  // Sub-agents card (Phase 7)
  renderSubagents(subagents || [], subagentRuns || []);

  // Tool usage card (Phase 7)
  renderTools(tools || []);

  // Actions card (Phase 7.5)
  renderActions(f);

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

<<<<<<< HEAD
function renderSubagents(summary, runs) {
  const card = $("#subagents-card");
  if (!summary || summary.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const totalRuns = summary.reduce((s, a) => s + Number(a.runs || 0), 0);
  const totalCost = summary.reduce((s, a) => s + Number(a.cost || 0), 0);
  const totalTurns = summary.reduce((s, a) => s + Number(a.turns || 0), 0);
  const totalIn = summary.reduce((s, a) => s + Number(a.input_tokens || 0), 0);
  const totalOut = summary.reduce((s, a) => s + Number(a.output_tokens || 0), 0);

  const tbody = $("#subagents-table tbody");
  const tfoot = $("#subagents-table tfoot");
  tbody.innerHTML = summary.map(a => {
    const avg = a.runs > 0 ? a.cost / a.runs : 0;
    return `<tr>
      <td><span class="agent-chip">${escape(a.agent)}</span></td>
      <td class="num">${fmtInt(a.runs)}</td>
      <td class="num">${fmt(a.cost)}</td>
      <td class="num">${fmt(avg)}</td>
      <td class="num">${fmtInt(a.input_tokens)}</td>
      <td class="num">${fmtInt(a.output_tokens)}</td>
      <td class="num">${fmtInt(a.turns)}</td>
    </tr>`;
  }).join("");
  tfoot.innerHTML = `<tr>
    <th>total</th>
    <th class="num">${fmtInt(totalRuns)}</th>
    <th class="num">${fmt(totalCost)}</th>
    <th class="num">—</th>
    <th class="num">${fmtInt(totalIn)}</th>
    <th class="num">${fmtInt(totalOut)}</th>
    <th class="num">${fmtInt(totalTurns)}</th>
  </tr>`;

  // Per-run table: oldest first (chronological).
  const rtbody = $("#subagent-runs tbody");
  rtbody.innerHTML = (runs || []).length === 0
    ? `<tr><td colspan="8" class="muted">No runs</td></tr>`
    : (runs || []).map(r => `<tr>
      <td>${escape(r.timestamp?.replace("T", " ").slice(0, 19) ?? "")}</td>
      <td><span class="agent-chip">${escape(r.agent)}</span></td>
      <td>${escape(r.model ?? "—")}</td>
      <td class="num">${r.step ?? "—"}</td>
      <td class="num">${fmtInt(r.input_tokens)}</td>
      <td class="num">${fmtInt(r.output_tokens)}</td>
      <td class="num">${fmt(r.cost_usd)}</td>
      <td class="task-cell">${escape((r.task || "").slice(0, 80))}</td>
    </tr>`).join("");
}

function renderTools(counts) {
  const card = $("#tools-card");
  if (!counts || counts.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("#tools-table tbody").innerHTML = counts.map(c => `<tr>
    <td>${escape(c.tool_name)}</td>
    <td class="num">${fmtInt(c.calls)}</td>
  </tr>`).join("");
}

=======
// ---------------------------------------------------------------------------
// Actions card
// ---------------------------------------------------------------------------

function renderActions(f) {
  // Status badge
  const statusEl = $("#actions-status");
  statusEl.textContent = f.status;
  statusEl.className = `badge ${f.status}`;

  // Status transition buttons. Closed features only get Reopen; open
  // features get Close, Cancel, Merge.
  const statusButtons = $("#status-buttons");
  statusButtons.innerHTML = "";
  if (f.id === "unassigned") {
    statusButtons.innerHTML = `<span class="muted">Pool — no actions</span>`;
  } else if (f.status === "open") {
    statusButtons.appendChild(actionButton("Close", "danger", () => confirmStatusTransition("close", f)));
    statusButtons.appendChild(actionButton("Cancel", "ghost", () => confirmStatusTransition("cancel", f)));
    statusButtons.appendChild(actionButton("Merge", "ghost", () => confirmStatusTransition("merge", f)));
  } else {
    statusButtons.appendChild(actionButton("Reopen", "primary", () => doReopen(f)));
  }

  // Cap display
  const capDisplay = $("#actions-cap-display");
  capDisplay.textContent = f.cap_usd ? `$${f.cap_usd.toFixed(2)}` : "no cap";
  capDisplay.className = f.cap_usd ? "" : "muted";
  // Cap input: don't pre-fill — the user types a new value.
  const capInput = $("#cap-input");
  if (capInput && capInput !== document.activeElement) {
    capInput.value = "";
    capInput.placeholder = f.cap_usd ? `current $${f.cap_usd.toFixed(2)}` : "USD";
  }
  const capClear = $("#cap-clear");
  capClear.disabled = !f.cap_usd;

  // Tags
  renderActionTags(f.tags || []);

  // Notes
  renderActionNotes(f.notes || []);
}

function actionButton(label, variant, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (variant) b.className = variant;
  b.addEventListener("click", onClick);
  return b;
}

function renderActionTags(tags) {
  const list = $("#actions-tags");
  list.innerHTML = "";
  if (tags.length === 0) {
    list.innerHTML = `<span class="muted">no tags</span>`;
    return;
  }
  for (const t of tags) {
    const chip = document.createElement("span");
    chip.className = `tag ${tagClass(t)}`;
    chip.dataset.tag = t;
    chip.innerHTML = `${escape(t)}<button class="tag-remove" type="button" aria-label="Remove tag ${escape(t)}">×</button>`;
    chip.querySelector(".tag-remove").addEventListener("click", () => doRemoveTag(t, chip));
    list.appendChild(chip);
  }
}

function renderActionNotes(notes) {
  const list = $("#actions-notes");
  list.innerHTML = "";
  if (notes.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "no notes yet";
    list.appendChild(li);
    return;
  }
  // Most recent first.
  for (const n of notes.slice().reverse()) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="note-body">${escape(n.body)}</span>
      <time>${escape((n.created_at ?? "").replace("T", " ").slice(0, 19))}</time>
    `;
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

const ACTIONS_API = (id) => `/api/features/${encodeURIComponent(id)}`;

async function doWrite(method, path, body) {
  const init = {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const res = await fetch(path, init);
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = payload?.message ?? `HTTP ${res.status}`;
    const code = payload?.code ?? res.status;
    throw new LifecycleApiError(code, msg, res.status);
  }
  return payload;
}

class LifecycleApiError extends Error {
  constructor(public code, message, public status) {
    super(message);
    this.name = "LifecycleApiError";
  }
}

// ---- status transitions ----

function confirmStatusTransition(action, f) {
  const verb = action[0].toUpperCase() + action.slice(1);
  const costAt = f.total_cost_usd;
  const costStr = `$${costAt.toFixed(4)}`;
  const titles = {
    close: `Close "${f.name}"?`,
    cancel: `Cancel "${f.name}"?`,
    merge: `Merge "${f.name}"?`,
  };
  const bodies = {
    close: `Cost will freeze at ${costStr}. Use /feature reopen (or the Reopen button) to undo.`,
    cancel: `Cost will freeze at ${costStr}. This marks the feature as abandoned.`,
    merge: `Cost will freeze at ${costStr}. The branch is merged but the feature stays in the ledger.`,
  };
  const modal = showModal({
    title: titles[action],
    body: bodies[action],
    confirmLabel: verb,
    confirmVariant: action === "close" ? "danger" : "primary",
  });
  modal.then((ok) => {
    if (!ok) return;
    doStatusTransition(action, f);
  });
}

async function doStatusTransition(action, f) {
  const path = `${ACTIONS_API(f.id)}/${action}`;
  const note = await promptTransitionNote(action, f);
  if (note === null) return; // user cancelled the note prompt
  try {
    await doWrite("POST", path, note ? { note } : {});
    toast(`Feature ${action}${note ? " (note saved)" : ""}.`, "success");
    await load();
  } catch (err) {
    toast(`${action} failed: ${escape(err.message)}`, "error");
  }
}

/**
 * Lightweight prompt for an optional close/cancel/merge note. Returns
 * the trimmed string, an empty string for "no note", or null if the
 * user cancelled. A 240-char textarea is plenty for a status note.
 */
function promptTransitionNote(action, f) {
  return new Promise((resolve) => {
    const trimmed = f.name.length;
    const initial = `${action[0].toUpperCase() + action.slice(1)} "${f.name}"?`;
    const modal = showModal({
      title: initial,
      body: `<label class="muted" for="modal-note-input" style="display:block;margin-bottom:6px;">Add a note (optional)</label>` +
        `<textarea id="modal-note-input" rows="3" placeholder="e.g. shipped to prod" style="width:100%;box-sizing:border-box;padding:8px;border-radius:6px;background:var(--surface-2);color:var(--text);border:1px solid var(--border);font:inherit;font-family:inherit;resize:vertical;"></textarea>`,
      confirmLabel: `${action[0].toUpperCase() + action.slice(1)}`,
      confirmVariant: action === "close" ? "danger" : "primary",
    });
    // Auto-focus the textarea once it's in the DOM.
    setTimeout(() => {
      const ta = document.getElementById("modal-note-input");
      if (ta) ta.focus();
    }, 0);
    modal.then((ok) => {
      if (!ok) return resolve(null);
      const ta = document.getElementById("modal-note-input");
      resolve(ta ? ta.value.trim() : "");
    });
  });
}

async function doReopen(f) {
  try {
    await doWrite("POST", `${ACTIONS_API(f.id)}/reopen`);
    toast(`Reopened "${f.name}".`, "success");
    await load();
  } catch (err) {
    toast(`reopen failed: ${escape(err.message)}`, "error");
  }
}

// ---- cap ----

async function doSetCap() {
  const input = $("#cap-input");
  const raw = input.value.trim();
  if (raw === "") {
    toast("Enter a cap amount first.", "error");
    input.focus();
    return;
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    toast("Cap must be a non-negative number.", "error");
    input.focus();
    return;
  }
  try {
    await doWrite("PATCH", `${ACTIONS_API(featureId)}/cap`, { capUsd: num });
    toast(num === 0 ? "Cap cleared." : `Cap set to $${num.toFixed(2)}.`, "success");
    input.value = "";
    await load();
  } catch (err) {
    toast(`cap failed: ${escape(err.message)}`, "error");
  }
}

async function doClearCap() {
  try {
    await doWrite("PATCH", `${ACTIONS_API(featureId)}/cap`, { capUsd: null });
    toast("Cap cleared.", "success");
    await load();
  } catch (err) {
    toast(`cap clear failed: ${escape(err.message)}`, "error");
  }
}

// ---- tags ----

async function doAddTag() {
  const input = $("#tag-input");
  const raw = input.value.trim();
  if (!raw) {
    toast("Enter a tag first.", "error");
    input.focus();
    return;
  }
  // Optimistic: don't render yet, the server will normalise the tag
  // (lowercase, trim). Wait for the response, then re-render.
  try {
    await doWrite("POST", `${ACTIONS_API(featureId)}/tags`, { tag: raw });
    input.value = "";
    toast(`Tag added.`, "success");
    await load();
  } catch (err) {
    toast(`tag add failed: ${escape(err.message)}`, "error");
  }
}

async function doRemoveTag(tag, chipEl) {
  // Optimistic: remove the chip immediately, re-insert on error.
  if (chipEl) chipEl.classList.add("tag-removing");
  const snapshot = chipEl ? chipEl.outerHTML : null;
  if (chipEl) chipEl.remove();
  try {
    await doWrite("DELETE", `${ACTIONS_API(featureId)}/tags/${encodeURIComponent(tag)}`);
    toast(`Tag removed.`, "success");
    await load();
  } catch (err) {
    // Roll back the optimistic removal.
    if (chipEl && snapshot) {
      const list = $("#actions-tags");
      // Strip the empty-state placeholder if it sneaked in.
      const placeholder = list.querySelector(".muted");
      if (placeholder) placeholder.remove();
      const div = document.createElement("div");
      div.innerHTML = snapshot;
      const restored = div.firstElementChild;
      if (restored) {
        restored.classList.remove("tag-removing");
        restored.querySelector(".tag-remove").addEventListener("click", () => doRemoveTag(tag, restored));
        list.appendChild(restored);
      }
    }
    toast(`tag remove failed: ${escape(err.message)}`, "error");
  }
}

// ---- notes ----

async function doAddNote() {
  const input = $("#note-input");
  const raw = input.value.trim();
  if (!raw) {
    toast("Note cannot be empty.", "error");
    input.focus();
    return;
  }
  try {
    await doWrite("POST", `${ACTIONS_API(featureId)}/notes`, { body: raw });
    input.value = "";
    toast(`Note saved.`, "success");
    await load();
  } catch (err) {
    toast(`note save failed: ${escape(err.message)}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/**
 * Show a confirmation modal. Returns a Promise<boolean> that resolves
 * to true on confirm, false on cancel. The modal is appended to
 * #modal; existing modal bodies are replaced.
 */
function showModal({ title, body, confirmLabel = "Confirm", confirmVariant = "primary" }) {
  const backdrop = $("#modal");
  const titleEl = $("#modal-title");
  const bodyEl = $("#modal-body");
  const cancelBtn = $("#modal-cancel");
  const confirmBtn = $("#modal-confirm");

  titleEl.textContent = title;
  bodyEl.innerHTML = body;
  confirmBtn.textContent = confirmLabel;
  confirmBtn.className = confirmVariant || "primary";
  backdrop.hidden = false;

  return new Promise((resolve) => {
    const cleanup = (result) => {
      backdrop.hidden = true;
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      backdrop.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onCancel = () => cleanup(false);
    const onConfirm = () => cleanup(true);
    const onBackdrop = (e) => { if (e.target === backdrop) cleanup(false); };
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(false);
      if (e.key === "Enter" && document.activeElement?.id !== "modal-note-input") {
        // Don't submit on Enter inside the textarea — let it insert a newline.
        if (document.activeElement?.tagName !== "TEXTAREA") cleanup(true);
      }
    };
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    setTimeout(() => confirmBtn.focus(), 0);
  });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, kind = "info", durationMs = 3000) {
  const container = $("#toasts");
  if (!container) return;
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = message;
  container.appendChild(t);
  setTimeout(() => {
    t.classList.add("fading");
    setTimeout(() => t.remove(), 250);
  }, durationMs);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

>>>>>>> feat/phase-7.5-dashboard-actions
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

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

$("#refresh").addEventListener("click", load);
$("#cap-save").addEventListener("click", doSetCap);
$("#cap-clear").addEventListener("click", doClearCap);
$("#cap-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSetCap();
});
$("#tag-add").addEventListener("click", doAddTag);
$("#tag-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doAddTag();
});
$("#note-add").addEventListener("click", doAddNote);
$("#note-input").addEventListener("keydown", (e) => {
  // Cmd/Ctrl+Enter saves; regular Enter inserts a newline.
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doAddNote();
});

load();
setInterval(load, 5000);
