const appState = {
  data: {
    queries: [],
    leads: [],
    activities: [],
    notifications: {
      slack: { enabled: false, url: "" },
      discord: { enabled: false, url: "" },
      notifyOn: { newLeads: true, runCompleted: false, runFailed: false }
    },
    auth: { connected: false },
    runtime: { queueBusy: false, queuedCount: 0 },
    stats: {}
  },
  activeView: "overview",
  overviewIntentFilter: "buyer",
  settingsHydrated: false,
  loading: false
};

const pageMeta = {
  overview: ["Live workspace", "Lead radar"],
  searches: ["Listening queue", "Scheduled searches"],
  leads: ["People with intent", "Lead inbox"],
  deliveries: ["Outbound signal", "Deliveries"]
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeUrl(value = "") {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "#";
  } catch {
    return "#";
  }
}

function relativeTime(value) {
  if (!value) return "Never";
  const delta = Date.now() - Date.parse(value);
  const future = delta < 0;
  const seconds = Math.round(Math.abs(delta) / 1000);
  if (seconds < 45) return future ? "in a moment" : "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

function formatCountdown(value) {
  if (!value) return "No search yet";
  const milliseconds = Math.max(0, Date.parse(value) - Date.now());
  if (milliseconds === 0) return "Due now";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function initials(username = "") {
  return username.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "TL";
}

function avatarColor(username = "") {
  const colors = ["#dbe6f4", "#e5def4", "#f4e0dc", "#d7ece6", "#f2e7c9", "#d8e7ee"];
  const sum = [...username].reduce((total, character) => total + character.charCodeAt(0), 0);
  return colors[sum % colors.length];
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function toast(title, detail = "", type = "success") {
  const region = $("#toast-region");
  const element = document.createElement("div");
  element.className = `toast ${type === "error" ? "is-error" : ""}`;
  element.innerHTML = `
    <i></i>
    <div><strong>${escapeHtml(title)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ""}</div>
    <button aria-label="Dismiss notification">×</button>
  `;
  element.querySelector("button").addEventListener("click", () => element.remove());
  region.append(element);
  setTimeout(() => element.remove(), 5200);
}

function emptyState(title, copy) {
  return `
    <div class="empty-state">
      <span class="empty-symbol" aria-hidden="true"></span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(copy)}</p>
    </div>
  `;
}

function leadMarkup(lead) {
  const threadUrl = safeUrl(lead.threadUrl || lead.profileUrl);
  const profileUrl = safeUrl(lead.profileUrl);
  const statusLabel = lead.status === "saved" ? "Saved" : lead.status === "dismissed" ? "Passed" : "New";
  const intent = lead.intent || "general";
  const intentLabel = intent === "buyer"
    ? lead.intentSource === "manual"
      ? "Buyer intent · Manual"
      : `Buyer intent · ${lead.intentScore || 0}`
    : "General";
  const leadTime = lead.timeText || relativeTime(lead.postedAt || lead.discoveredAt);
  return `
    <article class="lead-row" data-lead-id="${escapeHtml(lead.id)}">
      <span class="avatar" style="--avatar-bg:${avatarColor(lead.username)}">${escapeHtml(initials(lead.username))}</span>
      <div class="lead-main">
        <div class="lead-person">
          <a href="${profileUrl}" target="_blank" rel="noreferrer">@${escapeHtml(lead.username)}</a>
          <span class="intent-state ${escapeHtml(intent)}" title="${escapeHtml(lead.intentReason || "No direct buyer language")}">${escapeHtml(intentLabel)}</span>
          ${intent !== "buyer" ? `
            <button class="manual-qualify" type="button" data-lead-qualify title="Mark as buyer and send a notification">
              <svg aria-hidden="true"><use href="#icon-check"></use></svg>
              <span>Mark buyer + notify</span>
            </button>
          ` : ""}
          <span class="lead-state ${escapeHtml(lead.status)}">${statusLabel}</span>
          <time class="lead-time" datetime="${escapeHtml(lead.postedAt || lead.discoveredAt || "")}" title="${escapeHtml(lead.timeLabel || leadTime)}">${escapeHtml(leadTime)}</time>
        </div>
        <p class="lead-text">${escapeHtml(lead.text)}</p>
      </div>
      <span class="query-chip" title="${escapeHtml(lead.query)}">${escapeHtml(lead.query)}</span>
      <div class="lead-actions">
        <a class="mini-action" href="${threadUrl}" target="_blank" rel="noreferrer" title="Open original thread" aria-label="Open original thread">
          <svg aria-hidden="true"><use href="#icon-external"></use></svg>
        </a>
        <button class="mini-action ${lead.status === "saved" ? "is-active" : ""}" data-lead-action="saved" title="Save lead" aria-label="Save lead">
          <svg aria-hidden="true"><use href="#icon-bookmark"></use></svg>
        </button>
        <button class="mini-action" data-lead-action="dismissed" title="Dismiss lead" aria-label="Dismiss lead">
          <svg aria-hidden="true"><use href="#icon-x"></use></svg>
        </button>
      </div>
    </article>
  `;
}

function renderLeads() {
  let overviewLeads = appState.data.leads;
  if (appState.overviewIntentFilter !== "all") {
    overviewLeads = overviewLeads.filter((lead) => (lead.intent || "general") === appState.overviewIntentFilter);
  }
  const visibleOverview = overviewLeads.filter((lead) => lead.status !== "dismissed").slice(0, 4);
  $("#overview-lead-list").innerHTML = visibleOverview.length
    ? visibleOverview.map(leadMarkup).join("")
    : emptyState(
        appState.data.queries.length ? "Listening for a match" : "Your first signal starts here",
        appState.data.queries.length
          ? appState.overviewIntentFilter === "buyer"
            ? "No direct buyer request is in this sweep. Check General to review broader matches."
            : "New posts will appear here after the next Threads sweep."
          : "Connect Threads and add a phrase such as “looking for a web developer”."
      );

  const text = $("#lead-search-input").value.trim().toLowerCase();
  const queryId = $("#lead-query-filter").value;
  const intent = $("#lead-intent-filter").value;
  const status = $("#lead-status-filter").value;
  const filtered = appState.data.leads.filter((lead) => {
    const matchesText = !text || `${lead.username} ${lead.text} ${lead.query}`.toLowerCase().includes(text);
    const matchesQuery = queryId === "all" || lead.queryId === queryId;
    const matchesIntent = intent === "all" || (lead.intent || "general") === intent;
    const matchesStatus = status === "all" || lead.status === status;
    return matchesText && matchesQuery && matchesIntent && matchesStatus;
  });
  $("#lead-toolbar-count").textContent = `${filtered.length} lead${filtered.length === 1 ? "" : "s"}`;
  $("#delete-all-leads").disabled = appState.data.leads.length === 0;
  $("#all-leads-list").innerHTML = filtered.length
    ? filtered.map(leadMarkup).join("")
    : emptyState(
        appState.data.leads.length ? "No leads match these filters" : "No leads collected yet",
        appState.data.leads.length
          ? "Change a filter or clear your lead search."
          : "Run a Threads search and matching posts will collect here."
      );
}

function statusCopy(status) {
  return {
    queued: "Queued",
    running: "Scanning",
    watching: "Listening",
    paused: "Paused",
    error: "Needs attention",
    needs_login: "Login needed"
  }[status] || status;
}

function intervalOptions(selected) {
  const values = [
    [5, "5 min"],
    [10, "10 min"],
    [15, "15 min"],
    [30, "30 min"],
    [60, "1 hour"],
    [180, "3 hours"],
    [360, "6 hours"],
    [1440, "Daily"]
  ];
  if (!values.some(([value]) => value === Number(selected))) {
    values.push([Number(selected), `${selected} min`]);
    values.sort((a, b) => a[0] - b[0]);
  }
  return values.map(([value, label]) =>
    `<option value="${value}" ${Number(selected) === value ? "selected" : ""}>${label}</option>`
  ).join("");
}

function ageOptions(selected) {
  const values = [
    [24, "24 hours"],
    [72, "3 days"],
    [168, "7 days"],
    [336, "14 days"],
    [720, "30 days"]
  ];
  return values.map(([value, label]) =>
    `<option value="${value}" ${Number(selected || 24) === value ? "selected" : ""}>${label}</option>`
  ).join("");
}

function queryMarkup(query) {
  const isPaused = query.status === "paused";
  const isRunning = query.status === "running";
  return `
    <article class="search-card" data-query-id="${escapeHtml(query.id)}" data-status="${escapeHtml(query.status)}">
      <div class="search-card-head">
        <div>
          <p class="eyebrow">Search phrase</p>
          <h3>“${escapeHtml(query.phrase)}”</h3>
          <div class="search-filter-row">
            <label class="search-filter search-age ${Number(query.maxAgeHours || 24) > 24 ? "is-extended" : ""}">
              <select data-query-age aria-label="Change maximum post age">
                ${ageOptions(query.maxAgeHours)}
              </select>
            </label>
            <label class="search-filter search-location ${query.locationFilter === "united_states" ? "is-filtered" : ""}">
              <select data-query-location aria-label="Change search location">
                <option value="any" ${query.locationFilter !== "united_states" ? "selected" : ""}>Any location</option>
                <option value="united_states" ${query.locationFilter === "united_states" ? "selected" : ""}>United States only</option>
              </select>
            </label>
          </div>
        </div>
        <span class="search-status ${escapeHtml(query.status)}">${escapeHtml(statusCopy(query.status))}</span>
      </div>
      <div class="search-stats">
        <div class="search-stat"><span>Cadence</span><select class="interval-select" data-query-interval aria-label="Change cadence">${intervalOptions(query.intervalMinutes)}</select></div>
        <div class="search-stat"><span>Last run</span><strong>${relativeTime(query.lastRunAt)}</strong></div>
        <div class="search-stat"><span>Collected</span><strong>${query.lastScrapedCount || 0}/${query.maxResults}</strong></div>
        <div class="search-stat"><span>Buyer leads</span><strong>${query.lastQualifiedCount || 0}</strong></div>
      </div>
      ${query.lastError ? `<p class="search-error">${escapeHtml(query.lastError)}</p>` : ""}
      <div class="search-card-actions">
        <button class="button button-ghost" data-query-action="run" ${isRunning ? "disabled" : ""}>
          <svg aria-hidden="true"><use href="#icon-play"></use></svg>${isRunning ? "Running…" : "Run now"}
        </button>
        <button class="mini-action" data-query-action="${isPaused ? "resume" : "pause"}" title="${isPaused ? "Resume search" : "Pause search"}" aria-label="${isPaused ? "Resume search" : "Pause search"}">
          <svg aria-hidden="true"><use href="#icon-${isPaused ? "play" : "pause"}"></use></svg>
        </button>
        <button class="mini-action" data-query-action="delete" title="Remove search" aria-label="Remove search">
          <svg aria-hidden="true"><use href="#icon-trash"></use></svg>
        </button>
      </div>
    </article>
  `;
}

function renderQueries() {
  const grid = $("#search-grid");
  grid.innerHTML = appState.data.queries.length
    ? appState.data.queries.map(queryMarkup).join("")
    : emptyState("No searches on the radar", "Add a phrase and choose how often Threadline should scan recent posts.");

  const currentValue = $("#lead-query-filter").value;
  $("#lead-query-filter").innerHTML = `
    <option value="all">All searches</option>
    ${appState.data.queries.map((query) => `<option value="${escapeHtml(query.id)}">${escapeHtml(query.phrase)}</option>`).join("")}
  `;
  if (appState.data.queries.some((query) => query.id === currentValue)) {
    $("#lead-query-filter").value = currentValue;
  }
}

function renderActivity() {
  $("#activity-list").innerHTML = appState.data.activities.length
    ? appState.data.activities.slice(0, 5).map((activity) => `
        <article class="activity-item">
          <span class="activity-dot ${escapeHtml(activity.tone)}"></span>
          <div class="activity-copy">
            <strong>${escapeHtml(activity.title)}</strong>
            <p>${escapeHtml(activity.detail)}</p>
            <time datetime="${escapeHtml(activity.at)}">${relativeTime(activity.at)}</time>
          </div>
        </article>
      `).join("")
    : emptyState("The run log is quiet", "Connection, search, and delivery updates will appear here.");
}

function renderSession() {
  const connected = Boolean(appState.data.auth.connected);
  $("#session-card").classList.toggle("is-connected", connected);
  $("#session-lamp").classList.toggle("is-live", connected);
  $("#session-label").textContent = connected ? "Threads connected" : "Threads not connected";
  $("#session-copy").textContent = connected
    ? "Session ready. Scheduled searches can run in the background."
    : "Sign in once. Your browser session stays on this device.";
  $("#sidebar-login-button span").textContent = connected ? "Check connection" : "Connect Threads";
}

function renderSummary() {
  const leadCount = appState.data.leads.filter((lead) => lead.status !== "dismissed" && lead.intent === "buyer").length;
  $("#nav-query-count").textContent = appState.data.queries.length;
  $("#nav-lead-count").textContent = leadCount;
  const running = appState.data.runtime.queueBusy || appState.data.queries.some((query) => query.status === "running");
  $("#run-indicator").classList.toggle("is-running", running);
  $("#run-indicator-copy").textContent = running
    ? `Scanning${appState.data.runtime.queuedCount ? ` · ${appState.data.runtime.queuedCount} queued` : ""}`
    : appState.data.runtime.queuedCount ? `${appState.data.runtime.queuedCount} queued` : "Queue clear";
}

function renderNotifications() {
  if (appState.settingsHydrated) return;
  const settings = appState.data.notifications;
  $("#slack-enabled").checked = settings.slack.enabled;
  $("#discord-enabled").checked = settings.discord.enabled;
  $("#slack-url").placeholder = settings.slack.url || "https://hooks.slack.com/services/…";
  $("#discord-url").placeholder = settings.discord.url || "https://discord.com/api/webhooks/…";
  appState.settingsHydrated = true;
}

function render() {
  renderSummary();
  renderSession();
  renderQueries();
  renderLeads();
  renderActivity();
  renderNotifications();
  updateCountdown();
}

async function loadState({ quiet = false } = {}) {
  if (appState.loading) return;
  appState.loading = true;
  try {
    appState.data = await api("/api/state");
    render();
    if (!quiet) toast("Workspace refreshed", "Latest queue and lead state loaded.");
  } catch (error) {
    if (!quiet) toast("Could not refresh", error.message, "error");
  } finally {
    appState.loading = false;
  }
}

function setView(view) {
  if (!pageMeta[view]) return;
  appState.activeView = view;
  $$(".nav-item").forEach((item) => item.classList.toggle("is-active", item.dataset.view === view));
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-visible", panel.dataset.viewPanel === view));
  $("#page-eyebrow").textContent = pageMeta[view][0];
  $("#page-title").textContent = pageMeta[view][1];
  history.replaceState(null, "", `#${view}`);
  document.body.classList.remove("menu-open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openModal(id) {
  const modal = $(`#${id}`);
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => $(".modal-close", modal)?.focus(), 0);
}

function closeModal(modal) {
  modal.hidden = true;
  document.body.style.overflow = "";
}

function updateCountdown() {
  const active = appState.data.queries
    .filter((query) => query.status !== "paused" && query.nextRunAt)
    .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0];
  $("#next-run-countdown").textContent = active
    ? active.status === "running" ? "Scanning now" : formatCountdown(active.nextRunAt)
    : "No search yet";
}

async function handleSearchSubmit(event) {
  event.preventDefault();
  if (!appState.data.auth.connected) {
    openModal("auth-modal");
    toast("Connect Threads first", "Your phrase is ready; sign in to start its first sweep.", "error");
    return;
  }

  const submitButton = $("button[type='submit']", event.currentTarget);
  submitButton.disabled = true;
  try {
    const phrase = $("#query-input").value.trim();
    const intervalMinutes = Number($("#interval-input").value);
    const maxResults = Number($("#max-results-input").value);
    const locationFilter = $("#location-input").value;
    const maxAgeHours = Number($("#age-input").value);
    await api("/api/queries", {
      method: "POST",
      body: JSON.stringify({ phrase, intervalMinutes, maxResults, locationFilter, maxAgeHours })
    });
    $("#query-input").value = "";
    toast("Search is listening", `“${phrase}” was added to the queue.`);
    await loadState({ quiet: true });
  } catch (error) {
    toast("Could not add search", error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
}

async function openThreadsLogin() {
  const button = $("#open-login-window");
  button.disabled = true;
  button.querySelector("span");
  try {
    const result = await api("/api/auth/login", { method: "POST", body: "{}" });
    toast("Threads login opened", result.message);
  } catch (error) {
    toast("Could not open login", error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function checkThreadsLogin() {
  const button = $("#check-login-button");
  button.disabled = true;
  button.textContent = "Checking session…";
  try {
    const result = await api("/api/auth/check", { method: "POST", body: "{}" });
    appState.data.auth = result.auth;
    if (result.auth.connected) {
      toast("Threads connected", "Scheduled searches are ready to run.");
      closeModal($("#auth-modal"));
      await loadState({ quiet: true });
      $("#query-input").focus();
    } else {
      toast("Login not finished", "Complete sign-in in the browser window, then check again.", "error");
    }
  } catch (error) {
    toast("Could not check login", error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "I’m signed in — check connection";
  }
}

async function updateLead(leadId, status) {
  const lead = appState.data.leads.find((item) => item.id === leadId);
  if (!lead) return;
  const nextStatus = lead.status === status && status === "saved" ? "new" : status;
  try {
    await api(`/api/leads/${encodeURIComponent(leadId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus })
    });
    lead.status = nextStatus;
    renderLeads();
    toast(nextStatus === "saved" ? "Lead saved" : nextStatus === "dismissed" ? "Lead dismissed" : "Lead returned to inbox");
  } catch (error) {
    toast("Could not update lead", error.message, "error");
  }
}

async function qualifyLead(leadId, button) {
  const lead = appState.data.leads.find((item) => item.id === leadId);
  if (!lead || lead.intent === "buyer") return;
  button.disabled = true;
  button.querySelector("span").textContent = "Qualifying…";
  try {
    const result = await api(`/api/leads/${encodeURIComponent(leadId)}/qualify`, {
      method: "POST",
      body: "{}"
    });
    const deliveryCopy = result.notified.length
      ? `Notification sent to ${result.notified.join(" and ")}.`
      : result.failed.length
        ? "Buyer status saved, but notification delivery failed."
        : "Buyer status saved. Enable Slack or Discord to send notifications.";
    toast("Marked as buyer", deliveryCopy, result.failed.length ? "error" : "success");
    await loadState({ quiet: true });
  } catch (error) {
    button.disabled = false;
    button.querySelector("span").textContent = "Mark buyer + notify";
    toast("Could not mark as buyer", error.message, "error");
  }
}

async function deleteAllLeads() {
  const visibleCount = appState.data.leads.length;
  if (!visibleCount) {
    toast("There are no leads to delete");
    return;
  }
  const confirmed = window.confirm(
    `Permanently delete all collected leads?\n\nThis cannot be undone. Your searches, schedules, Threads login, and delivery settings will remain active.`
  );
  if (!confirmed) return;

  const button = $("#delete-all-leads");
  button.disabled = true;
  try {
    const result = await api("/api/leads", { method: "DELETE" });
    toast(
      "All leads deleted",
      `${result.deletedCount} lead${result.deletedCount === 1 ? "" : "s"} permanently removed.`
    );
    await loadState({ quiet: true });
  } catch (error) {
    toast("Could not delete leads", error.message, "error");
    button.disabled = false;
  }
}

async function handleQueryAction(queryId, action) {
  const query = appState.data.queries.find((item) => item.id === queryId);
  if (!query) return;
  try {
    if (action === "run") {
      await api(`/api/queries/${encodeURIComponent(queryId)}/run`, { method: "POST", body: "{}" });
      toast("Search queued", `“${query.phrase}” will run next.`);
    } else if (action === "pause" || action === "resume") {
      const status = action === "pause" ? "paused" : "watching";
      await api(`/api/queries/${encodeURIComponent(queryId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      toast(status === "paused" ? "Search paused" : "Search resumed", `“${query.phrase}” ${status === "paused" ? "will stop running." : "is back on the queue."}`);
    } else if (action === "delete") {
      const confirmed = window.confirm(`Remove the search “${query.phrase}”? Collected leads will stay in your inbox.`);
      if (!confirmed) return;
      await api(`/api/queries/${encodeURIComponent(queryId)}`, { method: "DELETE" });
      toast("Search removed", "Existing leads are still available.");
    }
    await loadState({ quiet: true });
  } catch (error) {
    toast("Search action failed", error.message, "error");
  }
}

async function updateQueryInterval(queryId, intervalMinutes) {
  const query = appState.data.queries.find((item) => item.id === queryId);
  if (!query) return;
  try {
    await api(`/api/queries/${encodeURIComponent(queryId)}`, {
      method: "PATCH",
      body: JSON.stringify({ intervalMinutes })
    });
    query.intervalMinutes = intervalMinutes;
    toast("Cadence updated", `“${query.phrase}” will run every ${intervalMinutes} minutes.`);
    await loadState({ quiet: true });
  } catch (error) {
    toast("Could not change cadence", error.message, "error");
    renderQueries();
  }
}

async function updateQueryLocation(queryId, locationFilter) {
  const query = appState.data.queries.find((item) => item.id === queryId);
  if (!query) return;
  try {
    await api(`/api/queries/${encodeURIComponent(queryId)}`, {
      method: "PATCH",
      body: JSON.stringify({ locationFilter })
    });
    query.locationFilter = locationFilter;
    toast(
      "Location filter updated",
      locationFilter === "united_states"
        ? `“${query.phrase}” now requires United States signals.`
        : `“${query.phrase}” now accepts any location.`
    );
    await loadState({ quiet: true });
  } catch (error) {
    toast("Could not change location", error.message, "error");
    renderQueries();
  }
}

async function updateQueryAge(queryId, maxAgeHours) {
  const query = appState.data.queries.find((item) => item.id === queryId);
  if (!query) return;
  try {
    await api(`/api/queries/${encodeURIComponent(queryId)}`, {
      method: "PATCH",
      body: JSON.stringify({ maxAgeHours })
    });
    query.maxAgeHours = maxAgeHours;
    const ageLabel = maxAgeHours === 24 ? "24 hours" : `${maxAgeHours / 24} days`;
    toast("Post age updated", `“${query.phrase}” now checks the last ${ageLabel}.`);
    await loadState({ quiet: true });
  } catch (error) {
    toast("Could not change post age", error.message, "error");
    renderQueries();
  }
}

function notificationPayload() {
  return {
    slack: { enabled: $("#slack-enabled").checked, url: $("#slack-url").value.trim() },
    discord: { enabled: $("#discord-enabled").checked, url: $("#discord-url").value.trim() },
    notifyOn: {
      newLeads: true,
      runCompleted: false,
      runFailed: false
    }
  };
}

async function saveNotifications({ quiet = false } = {}) {
  const result = await api("/api/notifications", {
    method: "POST",
    body: JSON.stringify(notificationPayload())
  });
  appState.data.notifications = result.notifications;
  $("#slack-url").value = "";
  $("#discord-url").value = "";
  $("#slack-url").placeholder = result.notifications.slack.url || "https://hooks.slack.com/services/…";
  $("#discord-url").placeholder = result.notifications.discord.url || "https://discord.com/api/webhooks/…";
  if (!quiet) toast("Delivery settings saved", "The next sweep will use these rules.");
}

function bindEvents() {
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
  $$("[data-view-link]").forEach((item) => item.addEventListener("click", () => setView(item.dataset.viewLink)));
  $$("[data-focus-search]").forEach((button) => button.addEventListener("click", () => {
    setView("overview");
    setTimeout(() => $("#query-input").focus(), 120);
  }));

  $("#search-form").addEventListener("submit", handleSearchSubmit);
  $("#refresh-button").addEventListener("click", () => loadState());
  $("#mobile-menu-button").addEventListener("click", () => document.body.classList.toggle("menu-open"));
  $("#open-help").addEventListener("click", () => openModal("help-modal"));
  $("#sidebar-login-button").addEventListener("click", () => {
    if (appState.data.auth.connected) {
      checkThreadsLogin();
    } else {
      openModal("auth-modal");
    }
  });

  $$("[data-close-modal]").forEach((button) => button.addEventListener("click", () => closeModal(button.closest(".modal-backdrop"))));
  $$(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeModal(backdrop);
  }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const open = $$(".modal-backdrop").find((modal) => !modal.hidden);
      if (open) closeModal(open);
      document.body.classList.remove("menu-open");
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      setView("overview");
      $("#query-input").focus();
    }
  });

  $("#open-login-window").addEventListener("click", openThreadsLogin);
  $("#check-login-button").addEventListener("click", checkThreadsLogin);

  $$(".segmented button").forEach((button) => button.addEventListener("click", () => {
    appState.overviewIntentFilter = button.dataset.intentFilter;
    $$(".segmented button").forEach((item) => item.classList.toggle("is-active", item === button));
    renderLeads();
  }));

  $("#lead-search-input").addEventListener("input", renderLeads);
  $("#lead-query-filter").addEventListener("change", renderLeads);
  $("#lead-intent-filter").addEventListener("change", renderLeads);
  $("#lead-status-filter").addEventListener("change", renderLeads);
  $("#delete-all-leads").addEventListener("click", deleteAllLeads);

  document.addEventListener("click", (event) => {
    const qualifyButton = event.target.closest("[data-lead-qualify]");
    if (qualifyButton) {
      const row = qualifyButton.closest("[data-lead-id]");
      qualifyLead(row.dataset.leadId, qualifyButton);
      return;
    }
    const leadButton = event.target.closest("[data-lead-action]");
    if (leadButton) {
      const row = leadButton.closest("[data-lead-id]");
      updateLead(row.dataset.leadId, leadButton.dataset.leadAction);
      return;
    }
    const queryButton = event.target.closest("[data-query-action]");
    if (queryButton) {
      const card = queryButton.closest("[data-query-id]");
      handleQueryAction(card.dataset.queryId, queryButton.dataset.queryAction);
    }
  });
  document.addEventListener("change", (event) => {
    const ageSelect = event.target.closest("[data-query-age]");
    if (ageSelect) {
      const card = ageSelect.closest("[data-query-id]");
      updateQueryAge(card.dataset.queryId, Number(ageSelect.value));
      return;
    }
    const locationSelect = event.target.closest("[data-query-location]");
    if (locationSelect) {
      const card = locationSelect.closest("[data-query-id]");
      updateQueryLocation(card.dataset.queryId, locationSelect.value);
      return;
    }
    const intervalSelect = event.target.closest("[data-query-interval]");
    if (!intervalSelect) return;
    const card = intervalSelect.closest("[data-query-id]");
    updateQueryInterval(card.dataset.queryId, Number(intervalSelect.value));
  });

  $("#run-next-button").addEventListener("click", async () => {
    const query = appState.data.queries.find((item) => !["paused", "running"].includes(item.status));
    if (!query) {
      toast("Nothing to run", "Add or resume a search first.", "error");
      return;
    }
    await handleQueryAction(query.id, "run");
  });

  $("#notification-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("button[type='submit']", event.currentTarget);
    button.disabled = true;
    try {
      await saveNotifications();
    } catch (error) {
      toast("Could not save settings", error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  $$("[data-test-channel]").forEach((button) => button.addEventListener("click", async () => {
    const channel = button.dataset.testChannel;
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      await saveNotifications({ quiet: true });
      await api(`/api/notifications/test/${channel}`, { method: "POST", body: "{}" });
      toast(`${channel === "slack" ? "Slack" : "Discord"} test delivered`, "Check the selected channel for the message.");
    } catch (error) {
      toast("Test delivery failed", error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Send test";
    }
  }));
}

async function initialize() {
  bindEvents();
  const hashView = location.hash.replace("#", "");
  if (pageMeta[hashView]) setView(hashView);
  await loadState({ quiet: true });
  setInterval(updateCountdown, 1000);
  setInterval(() => loadState({ quiet: true }), 5000);
}

initialize();
