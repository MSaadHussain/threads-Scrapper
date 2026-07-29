import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { classifyLead } from "./intent.js";
import { discordPayload, slackPayload } from "./webhook-format.js";
import { isDuplicateLead } from "./lead-dedupe.js";
import { isLeadFresh, parseThreadsTime } from "./thread-time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "threadline.json");
const PROFILE_DIR = path.join(DATA_DIR, "threads-profile");
const SCROLL_ROUNDS = Math.max(1, Number(process.env.SCRAPER_SCROLL_ROUNDS || 8));
const SCROLL_DELAY_MS = Math.max(250, Number(process.env.SCRAPER_SCROLL_DELAY_MS || 1200));
const HEADLESS = String(process.env.SCRAPER_HEADLESS || "false").toLowerCase() === "true";

fs.mkdirSync(DATA_DIR, { recursive: true });

const emptyState = {
  queries: [],
  leads: [],
  activities: [],
  notifications: {
    slack: { enabled: false, url: "" },
    discord: { enabled: false, url: "" },
    notifyOn: { newLeads: true, runCompleted: false, runFailed: false }
  },
  auth: { connected: false, username: "", checkedAt: null },
  stats: { totalRuns: 0, successfulRuns: 0, failedRuns: 0 }
};

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      ...structuredClone(emptyState),
      ...parsed,
      notifications: {
        ...structuredClone(emptyState.notifications),
        ...(parsed.notifications || {}),
        notifyOn: {
          ...emptyState.notifications.notifyOn,
          ...(parsed.notifications?.notifyOn || {})
        }
      }
    };
  } catch {
    return structuredClone(emptyState);
  }
}

let state = readState();
let browserContext = null;
let browserStarting = null;
let queueBusy = false;
const queuedIds = [];

let intentMigrationChanged = false;
for (const lead of state.leads) {
  const classification = classifyLead(lead.text, lead.query);
  if (
    lead.intent !== classification.intent ||
    lead.intentScore !== classification.intentScore ||
    lead.intentReason !== classification.intentReason
  ) {
    Object.assign(lead, classification);
    intentMigrationChanged = true;
  }
}
const acceptedStoredLeads = [];
for (const lead of [...state.leads].sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt))) {
  if (lead.intent === "buyer" && isDuplicateLead(lead, acceptedStoredLeads)) {
    lead.intent = "general";
    lead.intentScore = 0;
    lead.intentReason = "Duplicate or reposted request";
    intentMigrationChanged = true;
  }
  acceptedStoredLeads.push(lead);
}
for (const query of state.queries) {
  const qualifiedStoredCount = state.leads.filter((lead) =>
    lead.queryId === query.id && lead.intent === "buyer" && isLeadFresh(lead)
  ).length;
  if (query.lastQualifiedCount !== qualifiedStoredCount) {
    query.lastQualifiedCount = qualifiedStoredCount;
    intentMigrationChanged = true;
  }
}
if (state.notifications.notifyOn.runCompleted !== false || state.notifications.notifyOn.runFailed !== false) {
  state.notifications.notifyOn.runCompleted = false;
  state.notifications.notifyOn.runFailed = false;
  intentMigrationChanged = true;
}
if (intentMigrationChanged) {
  const temporary = `${DB_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temporary, DB_FILE);
}

function persist() {
  const temporary = `${DB_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temporary, DB_FILE);
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function addActivity(type, title, detail = "", tone = "neutral") {
  state.activities.unshift({ id: uid("evt"), type, title, detail, tone, at: now() });
  state.activities = state.activities.slice(0, 80);
}

function publicNotifications() {
  const mask = (value) => value ? `••••••••${value.slice(-8)}` : "";
  return {
    slack: { enabled: state.notifications.slack.enabled, url: mask(state.notifications.slack.url) },
    discord: { enabled: state.notifications.discord.enabled, url: mask(state.notifications.discord.url) },
    notifyOn: state.notifications.notifyOn
  };
}

function publicState() {
  const leads = state.leads
    .filter((lead) => isLeadFresh(lead))
    .sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt));
  return {
    queries: state.queries,
    leads,
    activities: state.activities.slice(0, 20),
    notifications: publicNotifications(),
    auth: state.auth,
    stats: state.stats,
    runtime: {
      queueBusy,
      queuedCount: queuedIds.length,
      browserOpen: Boolean(browserContext)
    }
  };
}

async function ensureBrowser() {
  if (browserContext) return browserContext;
  if (browserStarting) return browserStarting;

  browserStarting = chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1440, height: 960 },
    locale: "en-US",
    args: ["--disable-blink-features=AutomationControlled"]
  }).then((context) => {
    browserContext = context;
    browserStarting = null;
    context.on("close", () => {
      browserContext = null;
      state.auth.checkedAt = now();
      persist();
    });
    return context;
  }).catch((error) => {
    browserStarting = null;
    throw error;
  });

  return browserStarting;
}

async function getSessionIdentity(context) {
  const cookies = await context.cookies();
  const sessionCookie = cookies.find((cookie) => ["sessionid", "ds_user_id"].includes(cookie.name));
  return {
    connected: Boolean(sessionCookie),
    username: state.auth.username || "",
    checkedAt: now()
  };
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function extractLeads(page, maxResults) {
  const raw = await page.locator('[data-pagelet^="threads_search_results_"]').evaluateAll((roots) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();

    return roots.map((root) => {
      const anchors = Array.from(root.querySelectorAll('a[href^="/@"]'));
      const profileAnchor = anchors.find((anchor) => !anchor.getAttribute("href")?.includes("/post/"));
      const postAnchor = anchors.find((anchor) => anchor.getAttribute("href")?.includes("/post/"));
      const timeNode = root.querySelector('abbr[aria-label]');
      const profilePath = profileAnchor?.getAttribute("href") || "";
      const username = normalize(profileAnchor?.textContent) || profilePath.split("/")[1]?.replace("@", "") || "";

      const candidates = Array.from(root.querySelectorAll("span"))
        .map((span) => normalize(span.innerText))
        .filter((text) => {
          if (!text || text === username || text.length < 18) return false;
          if (/^(like|reply|repost|share|follow|translate)$/i.test(text)) return false;
          if (/^\d+\s*(m|h|d|w|mo|y)$/i.test(text)) return false;
          return true;
        })
        .sort((a, b) => b.length - a.length);

      return {
        username,
        profilePath,
        threadPath: postAnchor?.getAttribute("href") || "",
        text: candidates[0] || "",
        timeLabel: timeNode?.getAttribute("aria-label") || "",
        timeText: normalize(timeNode?.textContent)
      };
    });
  });

  const seen = new Set();
  const referenceTime = Date.now();
  return raw
    .map((lead) => {
      const time = parseThreadsTime(lead.timeLabel, lead.timeText, referenceTime);
      return {
        username: cleanText(lead.username).replace(/^@/, ""),
        profileUrl: lead.profilePath ? new URL(lead.profilePath, "https://www.threads.com").href : "",
        threadUrl: lead.threadPath ? new URL(lead.threadPath, "https://www.threads.com").href : "",
        text: cleanText(lead.text),
        postedAt: time.postedAt,
        timeLabel: time.timeLabel,
        timeText: time.timeText,
        ageHoursAtDiscovery: time.ageMs === null ? null : Number((time.ageMs / 3600000).toFixed(2)),
        isRecent: time.isRecent
      };
    })
    .filter((lead) => lead.username && lead.text)
    .filter((lead) => lead.isRecent)
    .filter((lead) => {
      const key = lead.threadUrl || `${lead.username}:${lead.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxResults);
}

async function scrapeQuery(query) {
  const context = await ensureBrowser();
  const identity = await getSessionIdentity(context);
  state.auth = identity;
  if (!identity.connected) {
    throw new Error("Threads is not connected. Open Threads login and finish signing in first.");
  }

  const page = await context.newPage();
  const url = `https://www.threads.com/search?q=${encodeURIComponent(query.phrase)}&filter=recent&serp_type=default`;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1800);

    const loginVisible = await page.locator('a[href*="/login"], input[name="username"]').first().isVisible().catch(() => false);
    if (loginVisible) {
      state.auth.connected = false;
      throw new Error("The Threads session expired. Sign in again to resume this search.");
    }

    const resultsAppeared = await page.locator('[data-pagelet^="threads_search_results_"]').first()
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!resultsAppeared) {
      const pageCopy = cleanText(await page.locator("body").innerText().catch(() => ""));
      if (/no results|couldn.?t find|try searching/i.test(pageCopy)) {
        return { url, leads: [] };
      }
      throw new Error("Threads did not return searchable results. Check the session and try again.");
    }

    let previousCount = 0;
    let unchangedRounds = 0;
    for (let round = 0; round < SCROLL_ROUNDS; round += 1) {
      const count = await page.locator('[data-pagelet^="threads_search_results_"]').count();
      if (count >= Math.min(query.maxResults * 2, 100)) break;
      unchangedRounds = count === previousCount ? unchangedRounds + 1 : 0;
      if (unchangedRounds >= 2) break;
      previousCount = count;
      await page.mouse.wheel(0, Math.max(900, await page.evaluate(() => window.innerHeight * 0.88)));
      await page.waitForTimeout(SCROLL_DELAY_MS);
    }

    return { url, leads: await extractLeads(page, query.maxResults) };
  } finally {
    await page.close().catch(() => {});
  }
}

function isAllowedWebhook(type, value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (type === "slack") return url.hostname === "hooks.slack.com";
    if (type === "discord") return ["discord.com", "discordapp.com"].includes(url.hostname) && url.pathname.includes("/api/webhooks/");
    return false;
  } catch {
    return false;
  }
}

async function postWebhook(type, url, message) {
  if (!url) return;
  const payload = type === "discord" ? discordPayload(message) : slackPayload(message);

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`${type} returned ${response.status}`);
}

async function notify(message) {
  const deliveries = [];
  for (const type of ["slack", "discord"]) {
    const channel = state.notifications[type];
    if (!channel.enabled || !channel.url) continue;
    deliveries.push(
      postWebhook(type, channel.url, message)
        .then(() => ({ type, ok: true }))
        .catch((error) => ({ type, ok: false, error: error.message }))
    );
  }
  return Promise.all(deliveries);
}

async function runQuery(queryId) {
  const query = state.queries.find((item) => item.id === queryId);
  if (!query || query.status === "paused") return;

  const startedAt = now();
  query.status = "running";
  query.lastRunAt = startedAt;
  query.lastError = "";
  addActivity("run", "Search started", `“${query.phrase}” is scanning recent Threads posts.`, "live");
  persist();

  try {
    const result = await scrapeQuery(query);
    let newCount = 0;
    let newQualifiedCount = 0;
    const newQualifiedLeads = [];
    const classifiedResults = result.leads.map((item) => ({
      ...item,
      ...classifyLead(item.text, query.phrase)
    }));
    const acceptedResults = [];

    for (const item of classifiedResults) {
      if (isDuplicateLead(item, [...state.leads, ...acceptedResults])) continue;
      newCount += 1;
      const lead = {
        id: uid("lead"),
        queryId: query.id,
        query: query.phrase,
        ...item,
        status: "new",
        discoveredAt: now()
      };
      if (item.intent === "buyer") {
        newQualifiedCount += 1;
        newQualifiedLeads.push(lead);
      }
      state.leads.push(lead);
      acceptedResults.push(lead);
    }

    query.status = "watching";
    query.lastResultCount = result.leads.length;
    query.lastNewCount = newCount;
    query.lastQualifiedCount = acceptedResults.filter((lead) => lead.intent === "buyer").length;
    query.runCount = (query.runCount || 0) + 1;
    query.nextRunAt = new Date(Date.now() + query.intervalMinutes * 60000).toISOString();
    state.stats.totalRuns += 1;
    state.stats.successfulRuns += 1;
    addActivity(
      "leads",
      newQualifiedCount
        ? `${newQualifiedCount} buyer-intent lead${newQualifiedCount === 1 ? "" : "s"} found`
        : newCount
          ? `${newCount} new match${newCount === 1 ? "" : "es"} classified`
          : "Search is up to date",
      `“${query.phrase}” checked ${result.leads.length} posts: ${query.lastQualifiedCount} buyer intent, ${result.leads.length - query.lastQualifiedCount} general.`,
      newQualifiedCount ? "success" : "neutral"
    );
    persist();

    if (newQualifiedCount > 0 && state.notifications.notifyOn.newLeads) {
      await notify({
        kind: "buyer_digest",
        query: query.phrase,
        leads: newQualifiedLeads,
        nextRunAt: query.nextRunAt
      });
    }
  } catch (error) {
    query.status = state.auth.connected ? "error" : "needs_login";
    query.lastError = error.message;
    query.nextRunAt = new Date(Date.now() + query.intervalMinutes * 60000).toISOString();
    state.stats.totalRuns += 1;
    state.stats.failedRuns += 1;
    addActivity("error", "Search could not finish", `${query.phrase}: ${error.message}`, "error");
    persist();

  }
}

function enqueue(queryId) {
  if (!queuedIds.includes(queryId)) queuedIds.push(queryId);
  processQueue().catch((error) => {
    console.error("Queue error:", error);
  });
}

async function processQueue() {
  if (queueBusy) return;
  queueBusy = true;
  try {
    while (queuedIds.length) {
      const nextId = queuedIds.shift();
      await runQuery(nextId);
    }
  } finally {
    queueBusy = false;
  }
}

setInterval(() => {
  const due = state.queries.filter((query) =>
    ["watching", "queued", "error", "needs_login"].includes(query.status) &&
    (!query.nextRunAt || Date.parse(query.nextRunAt) <= Date.now())
  );
  due.forEach((query) => enqueue(query.id));
}, 5000).unref();

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", (_request, response) => response.json(publicState()));

app.post("/api/auth/login", async (_request, response) => {
  try {
    const context = await ensureBrowser();
    let page = context.pages().find((item) => item.url().includes("threads.com"));
    if (!page) page = await context.newPage();
    await page.goto("https://www.threads.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.bringToFront();
    addActivity("auth", "Threads login opened", "Finish signing in in the browser window, then check the connection.", "live");
    persist();
    response.json({ ok: true, message: "Threads login opened in a browser window." });
  } catch (error) {
    response.status(500).json({ error: `Could not open Threads login: ${error.message}` });
  }
});

app.post("/api/auth/check", async (_request, response) => {
  try {
    const context = await ensureBrowser();
    state.auth = await getSessionIdentity(context);
    addActivity(
      "auth",
      state.auth.connected ? "Threads connected" : "Threads login not finished",
      state.auth.connected ? "The saved session is ready for scheduled searches." : "Complete login in the open browser window.",
      state.auth.connected ? "success" : "warning"
    );
    persist();
    response.json({ ok: true, auth: state.auth });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/auth/logout", async (_request, response) => {
  try {
    if (browserContext) await browserContext.clearCookies();
    state.auth = { connected: false, username: "", checkedAt: now() };
    addActivity("auth", "Threads disconnected", "Scheduled searches will wait for a new login.", "neutral");
    persist();
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/queries", (request, response) => {
  const phrase = cleanText(request.body.phrase);
  const intervalMinutes = Number(request.body.intervalMinutes || 15);
  const maxResults = Number(request.body.maxResults || 30);
  if (phrase.length < 3 || phrase.length > 180) {
    return response.status(400).json({ error: "Search phrase must be between 3 and 180 characters." });
  }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    return response.status(400).json({ error: "Interval must be between 1 minute and 24 hours." });
  }
  if (!Number.isFinite(maxResults) || maxResults < 5 || maxResults > 100) {
    return response.status(400).json({ error: "Results per run must be between 5 and 100." });
  }

  const query = {
    id: uid("qry"),
    phrase,
    intervalMinutes,
    maxResults,
    status: "queued",
    createdAt: now(),
    nextRunAt: now(),
    lastRunAt: null,
    lastResultCount: 0,
    lastNewCount: 0,
    lastQualifiedCount: 0,
    runCount: 0,
    lastError: ""
  };
  state.queries.unshift(query);
  addActivity("query", "Search added to the queue", `“${phrase}” will run now, then every ${intervalMinutes} minutes.`, "live");
  persist();
  enqueue(query.id);
  response.status(201).json({ ok: true, query });
});

app.patch("/api/queries/:id", (request, response) => {
  const query = state.queries.find((item) => item.id === request.params.id);
  if (!query) return response.status(404).json({ error: "Search not found." });

  if (request.body.status) {
    if (!["paused", "watching"].includes(request.body.status)) {
      return response.status(400).json({ error: "Status must be paused or watching." });
    }
    query.status = request.body.status;
    query.nextRunAt = request.body.status === "watching" ? now() : query.nextRunAt;
  }
  if (request.body.intervalMinutes !== undefined) {
    const interval = Number(request.body.intervalMinutes);
    if (!Number.isFinite(interval) || interval < 1 || interval > 1440) {
      return response.status(400).json({ error: "Interval must be between 1 minute and 24 hours." });
    }
    query.intervalMinutes = interval;
    query.nextRunAt = new Date(Date.now() + interval * 60000).toISOString();
  }
  persist();
  if (query.status === "watching" && Date.parse(query.nextRunAt) <= Date.now()) enqueue(query.id);
  response.json({ ok: true, query });
});

app.delete("/api/queries/:id", (request, response) => {
  const index = state.queries.findIndex((item) => item.id === request.params.id);
  if (index < 0) return response.status(404).json({ error: "Search not found." });
  const [query] = state.queries.splice(index, 1);
  addActivity("query", "Search removed", `“${query.phrase}” will no longer run. Its leads are still available.`, "neutral");
  persist();
  response.json({ ok: true });
});

app.post("/api/queries/:id/run", (request, response) => {
  const query = state.queries.find((item) => item.id === request.params.id);
  if (!query) return response.status(404).json({ error: "Search not found." });
  if (query.status === "running") return response.status(409).json({ error: "This search is already running." });
  query.status = "queued";
  query.nextRunAt = now();
  persist();
  enqueue(query.id);
  response.json({ ok: true });
});

app.patch("/api/leads/:id", (request, response) => {
  const lead = state.leads.find((item) => item.id === request.params.id);
  if (!lead) return response.status(404).json({ error: "Lead not found." });
  if (!["new", "saved", "dismissed"].includes(request.body.status)) {
    return response.status(400).json({ error: "Lead status must be new, saved, or dismissed." });
  }
  lead.status = request.body.status;
  persist();
  response.json({ ok: true, lead });
});

app.delete("/api/leads", (_request, response) => {
  const deletedCount = state.leads.length;
  state.leads = [];
  for (const query of state.queries) {
    query.lastNewCount = 0;
    query.lastQualifiedCount = 0;
  }
  addActivity(
    "leads",
    "All leads deleted",
    `${deletedCount} collected lead${deletedCount === 1 ? "" : "s"} permanently removed. Scheduled searches are unchanged.`,
    "neutral"
  );
  persist();
  response.json({ ok: true, deletedCount });
});

app.post("/api/notifications", (request, response) => {
  for (const type of ["slack", "discord"]) {
    const incoming = request.body[type] || {};
    const suppliedUrl = cleanText(incoming.url);
    if (suppliedUrl && !suppliedUrl.startsWith("••••")) {
      if (!isAllowedWebhook(type, suppliedUrl)) {
        return response.status(400).json({ error: `Enter a valid ${type === "slack" ? "Slack" : "Discord"} HTTPS webhook URL.` });
      }
      state.notifications[type].url = suppliedUrl;
    }
    if (typeof incoming.enabled === "boolean") state.notifications[type].enabled = incoming.enabled;
  }
  state.notifications.notifyOn = {
    newLeads: true,
    runCompleted: false,
    runFailed: false
  };
  addActivity("notification", "Notification settings saved", "New delivery rules apply to the next search run.", "success");
  persist();
  response.json({ ok: true, notifications: publicNotifications() });
});

app.post("/api/notifications/test/:type", async (request, response) => {
  const type = request.params.type;
  if (!["slack", "discord"].includes(type)) return response.status(404).json({ error: "Channel not found." });
  const channel = state.notifications[type];
  if (!channel.url) return response.status(400).json({ error: `Save a ${type} webhook URL first.` });
  try {
    await postWebhook(type, channel.url, {
      kind: "buyer_digest",
      query: "looking for a web developer",
      nextRunAt: new Date(Date.now() + 15 * 60000).toISOString(),
      leads: [{
        username: "sample.founder",
        profileUrl: "https://www.threads.com/@sample.founder",
        threadUrl: "https://www.threads.com/@sample.founder/post/sample",
        text: "Looking for a web developer to rebuild our company website. This is a paid project and we would like to start next week.",
        intentScore: 96,
        intentReason: "Direct first-person hiring language",
        discoveredAt: now()
      }]
    });
    response.json({ ok: true });
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

app.use((_request, response) => response.sendFile(path.join(__dirname, "public", "index.html")));

const server = app.listen(PORT, () => {
  console.log(`Threadline is running at http://localhost:${PORT}`);
});

async function shutdown() {
  if (browserContext) await browserContext.close().catch(() => {});
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
