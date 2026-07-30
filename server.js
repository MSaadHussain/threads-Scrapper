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
import { LOCATION_FILTERS, matchLocation } from "./location-filter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "threadline.json");
const PROFILE_DIR = path.join(DATA_DIR, "threads-profile");
const SCROLL_ROUNDS = Math.max(1, Number(process.env.SCRAPER_SCROLL_ROUNDS || 8));
const SCROLL_DELAY_MS = Math.max(500, Number(process.env.SCRAPER_SCROLL_DELAY_MS || 1500));
const RESULTS_SETTLE_MS = Math.max(1000, Number(process.env.SCRAPER_RESULTS_SETTLE_MS || 3000));
const MAX_SCAN_TIME_MS = Math.max(30000, Number(process.env.SCRAPER_MAX_SCAN_MS || 120000));
const NO_NEW_RESULTS_LIMIT = Math.max(3, Number(process.env.SCRAPER_NO_NEW_LIMIT || 8));
const BROWSER_IDLE_TIMEOUT_MS = Math.max(10000, Number(process.env.SCRAPER_BROWSER_IDLE_MS || 60000));
const HEADLESS = String(process.env.SCRAPER_HEADLESS || "false").toLowerCase() === "true";
const POST_AGE_OPTIONS = new Set([24, 72, 168, 336, 720]);

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
let scraperPage = null;
let browserIdleTimer = null;
let queueBusy = false;
const queuedIds = [];

let intentMigrationChanged = false;
for (const lead of state.leads) {
  if (lead.intentSource === "manual") continue;
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
  if (lead.intent === "buyer" && lead.intentSource !== "manual" && isDuplicateLead(lead, acceptedStoredLeads)) {
    lead.intent = "general";
    lead.intentScore = 0;
    lead.intentReason = "Duplicate or reposted request";
    intentMigrationChanged = true;
  }
  acceptedStoredLeads.push(lead);
}
for (const query of state.queries) {
  if (!LOCATION_FILTERS.has(query.locationFilter)) {
    query.locationFilter = "any";
    intentMigrationChanged = true;
  }
  if (!POST_AGE_OPTIONS.has(Number(query.maxAgeHours))) {
    query.maxAgeHours = 24;
    intentMigrationChanged = true;
  }
  if (query.status === "running") {
    query.status = "queued";
    query.nextRunAt = now();
    query.lastError = "Recovered after the scraper server restarted.";
    intentMigrationChanged = true;
  }
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

function cancelBrowserIdleClose() {
  if (!browserIdleTimer) return;
  clearTimeout(browserIdleTimer);
  browserIdleTimer = null;
}

function scheduleBrowserIdleClose() {
  cancelBrowserIdleClose();
  if (!browserContext) return;

  browserIdleTimer = setTimeout(async () => {
    browserIdleTimer = null;
    if (queueBusy || queuedIds.length) {
      scheduleBrowserIdleClose();
      return;
    }

    const context = browserContext;
    browserContext = null;
    scraperPage = null;
    await context?.close().catch((error) => {
      console.error("Could not close idle Threads browser:", error.message);
    });
  }, BROWSER_IDLE_TIMEOUT_MS);
  browserIdleTimer.unref();
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
  cancelBrowserIdleClose();
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
      cancelBrowserIdleClose();
      browserContext = null;
      scraperPage = null;
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

async function extractLeads(page, maxResults, maxAgeHours = 24) {
  const raw = await page.locator('[data-pagelet^="threads_search_results_"]').evaluateAll((roots) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();

    return roots.map((root) => {
      const anchors = Array.from(root.querySelectorAll('a[href^="/@"]'));
      const profileAnchor = anchors.find((anchor) => !anchor.getAttribute("href")?.includes("/post/"));
      const postAnchor = anchors.find((anchor) => anchor.getAttribute("href")?.includes("/post/"));
      const timeNode = root.querySelector('abbr[aria-label]');
      const fallbackTimeNode = Array.from(root.querySelectorAll("a, span, time")).find((node) => {
        if (node.children.length) return false;
        const value = normalize(node.textContent);
        return /^(?:\d+\s*(?:s|m|h|d|w)|\d{1,2}\/\d{1,2}\/\d{2,4}|yesterday|just now)$/i.test(value);
      });
      const profilePath = profileAnchor?.getAttribute("href") || "";
      const username = normalize(profileAnchor?.textContent) || profilePath.split("/")[1]?.replace("@", "") || "";

      const candidates = Array.from(root.querySelectorAll("span"))
        .filter((span) => !span.querySelector("span"))
        .map((span) => normalize(span.innerText))
        .filter((text) => {
          if (!text || text === username || text.length < 18) return false;
          if (/^(like|reply|repost|share|follow|translate)$/i.test(text)) return false;
          if (/^\d+\s*(m|h|d|w|mo|y)$/i.test(text)) return false;
          return true;
        });

      return {
        username,
        profilePath,
        threadPath: postAnchor?.getAttribute("href") || "",
        text: candidates[0] || "",
        timeLabel: timeNode?.getAttribute("aria-label") || normalize(fallbackTimeNode?.textContent),
        timeText: normalize(timeNode?.textContent) || normalize(fallbackTimeNode?.textContent)
      };
    });
  });

  const seen = new Set();
  const referenceTime = Date.now();
  return raw
    .map((lead) => {
      const time = parseThreadsTime(lead.timeLabel, lead.timeText, referenceTime, maxAgeHours * 60 * 60 * 1000);
      return {
        username: cleanText(lead.username).replace(/^@/, ""),
        profileUrl: lead.profilePath ? new URL(lead.profilePath, "https://www.threads.com").href : "",
        threadUrl: lead.threadPath ? new URL(lead.threadPath, "https://www.threads.com").href : "",
        text: cleanText(lead.text),
        postedAt: time.postedAt,
        freshUntil: time.freshUntil,
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

  const page = scraperPage && !scraperPage.isClosed()
    ? scraperPage
    : await context.newPage();
  scraperPage = page;
  const url = `https://www.threads.com/search?q=${encodeURIComponent(query.phrase)}&filter=recent&serp_type=default`;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(RESULTS_SETTLE_MS);

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
      return {
        url,
        leads: [],
        scan: { scrollRounds: 0, stopReason: "no_results", targetCount: query.maxResults }
      };
    }
    throw new Error("Threads did not return searchable results. Check the session and try again.");
  }

  const collected = new Map();
  const collectVisibleResults = async () => {
    const visibleLeads = await extractLeads(page, query.maxResults, query.maxAgeHours);
    for (const lead of visibleLeads) {
      const key = lead.threadUrl || `${lead.username}:${lead.text}`;
      if (!collected.has(key)) collected.set(key, lead);
    }
  };

  await collectVisibleResults();
  const scanStartedAt = Date.now();
  const maxScrollRounds = Math.min(120, Math.max(SCROLL_ROUNDS, query.maxResults * 2));
  let noNewRounds = 0;
  let scrollRounds = 0;
  let stopReason = "scroll_limit";

  for (let round = 0; round < maxScrollRounds; round += 1) {
    if (collected.size >= query.maxResults) {
      stopReason = "target_reached";
      break;
    }
    if (Date.now() - scanStartedAt >= MAX_SCAN_TIME_MS) {
      stopReason = "time_limit";
      break;
    }

    const previousUniqueCount = collected.size;
    await page.mouse.wheel(0, Math.max(900, await page.evaluate(() => window.innerHeight * 0.88)));
    await page.waitForTimeout(SCROLL_DELAY_MS);
    scrollRounds = round + 1;
    await collectVisibleResults();

    noNewRounds = collected.size === previousUniqueCount ? noNewRounds + 1 : 0;
    if (noNewRounds >= NO_NEW_RESULTS_LIMIT) {
      stopReason = "no_new_posts";
      break;
    }
  }

  await page.waitForTimeout(Math.min(RESULTS_SETTLE_MS, 2000));
  await collectVisibleResults();
  if (collected.size >= query.maxResults) stopReason = "target_reached";
  return {
    url,
    leads: Array.from(collected.values()).slice(0, query.maxResults),
    scan: { scrollRounds, stopReason, targetCount: query.maxResults }
  };
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
    const locationCheckedResults = result.leads.map((item) => ({
      ...item,
      ...matchLocation(item.text, query.locationFilter)
    }));
    const locatedResults = locationCheckedResults.filter((item) => item.locationMatch);
    const classifiedResults = locatedResults.map((item) => ({
      ...item,
      ...classifyLead(item.text, query.phrase)
    }));
    const acceptedResults = [];

    for (const item of classifiedResults) {
      const existingLead = state.leads.find((lead) =>
        lead.queryId === query.id &&
        lead.threadUrl &&
        item.threadUrl &&
        lead.threadUrl === item.threadUrl
      );
      if (existingLead) {
        const wasBuyer = existingLead.intent === "buyer";
        const manualIntent = existingLead.intentSource === "manual"
          ? {
              intent: existingLead.intent,
              intentScore: existingLead.intentScore,
              intentReason: existingLead.intentReason,
              intentSource: existingLead.intentSource,
              manuallyQualifiedAt: existingLead.manuallyQualifiedAt
            }
          : null;
        Object.assign(existingLead, item, {
          locationFilter: query.locationFilter,
          maxAgeHours: query.maxAgeHours
        });
        if (manualIntent) Object.assign(existingLead, manualIntent);
        if (!wasBuyer && existingLead.intent === "buyer") {
          newQualifiedCount += 1;
          newQualifiedLeads.push(existingLead);
        }
        acceptedResults.push(existingLead);
        continue;
      }
      if (isDuplicateLead(item, [...state.leads, ...acceptedResults])) continue;
      newCount += 1;
      const lead = {
        id: uid("lead"),
        queryId: query.id,
        query: query.phrase,
        locationFilter: query.locationFilter,
        maxAgeHours: query.maxAgeHours,
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
    query.lastScrapedCount = result.leads.length;
    query.lastScrollRounds = result.scan.scrollRounds;
    query.lastScanStopReason = result.scan.stopReason;
    query.lastLocationRejectedCount = result.leads.length - locatedResults.length;
    query.lastResultCount = locatedResults.length;
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
      query.locationFilter === "united_states"
        ? `“${query.phrase}” collected ${result.leads.length}/${query.maxResults} posts: ${locatedResults.length} matched United States signals, ${query.lastQualifiedCount} were buyer intent.`
        : `“${query.phrase}” collected ${result.leads.length}/${query.maxResults} posts: ${query.lastQualifiedCount} buyer intent, ${locatedResults.length - query.lastQualifiedCount} general.`,
      newQualifiedCount ? "success" : "neutral"
    );
    persist();

    if (newQualifiedCount > 0 && state.notifications.notifyOn.newLeads) {
      await notify({
        kind: "buyer_digest",
        query: query.phrase,
        locationLabel: query.locationFilter === "united_states" ? "United States" : "Any location",
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
  } finally {
    scheduleBrowserIdleClose();
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
    if (state.auth.connected) scheduleBrowserIdleClose();
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
  const locationFilter = cleanText(request.body.locationFilter || "any");
  const maxAgeHours = Number(request.body.maxAgeHours || 24);
  if (phrase.length < 3 || phrase.length > 180) {
    return response.status(400).json({ error: "Search phrase must be between 3 and 180 characters." });
  }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    return response.status(400).json({ error: "Interval must be between 1 minute and 24 hours." });
  }
  if (!Number.isFinite(maxResults) || maxResults < 5 || maxResults > 100) {
    return response.status(400).json({ error: "Results per run must be between 5 and 100." });
  }
  if (!LOCATION_FILTERS.has(locationFilter)) {
    return response.status(400).json({ error: "Location must be any or United States." });
  }
  if (!POST_AGE_OPTIONS.has(maxAgeHours)) {
    return response.status(400).json({ error: "Post age must be 24 hours, 3 days, 7 days, 14 days, or 30 days." });
  }

  const query = {
    id: uid("qry"),
    phrase,
    intervalMinutes,
    maxResults,
    locationFilter,
    maxAgeHours,
    status: "queued",
    createdAt: now(),
    nextRunAt: now(),
    lastRunAt: null,
    lastResultCount: 0,
    lastScrapedCount: 0,
    lastLocationRejectedCount: 0,
    lastNewCount: 0,
    lastQualifiedCount: 0,
    runCount: 0,
    lastError: ""
  };
  state.queries.unshift(query);
  addActivity(
    "query",
    "Search added to the queue",
    `“${phrase}” will run now, then every ${intervalMinutes} minutes${locationFilter === "united_states" ? " for United States signals" : ""}.`,
    "live"
  );
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
  if (request.body.locationFilter !== undefined) {
    const locationFilter = cleanText(request.body.locationFilter);
    if (!LOCATION_FILTERS.has(locationFilter)) {
      return response.status(400).json({ error: "Location must be any or United States." });
    }
    query.locationFilter = locationFilter;
    query.nextRunAt = now();
  }
  if (request.body.maxAgeHours !== undefined) {
    const maxAgeHours = Number(request.body.maxAgeHours);
    if (!POST_AGE_OPTIONS.has(maxAgeHours)) {
      return response.status(400).json({ error: "Post age must be 24 hours, 3 days, 7 days, 14 days, or 30 days." });
    }
    query.maxAgeHours = maxAgeHours;
    for (const lead of state.leads) {
      if (lead.queryId === query.id) lead.maxAgeHours = maxAgeHours;
    }
    query.nextRunAt = now();
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

app.post("/api/leads/:id/qualify", async (request, response) => {
  const lead = state.leads.find((item) => item.id === request.params.id);
  if (!lead) return response.status(404).json({ error: "Lead not found." });
  if (lead.intent === "buyer") {
    return response.status(409).json({ error: "This lead is already marked as buyer intent." });
  }

  lead.intent = "buyer";
  lead.intentScore = 100;
  lead.intentReason = "Manually marked as buyer intent";
  lead.intentSource = "manual";
  lead.manuallyQualifiedAt = now();
  if (lead.status === "dismissed") lead.status = "new";

  const query = state.queries.find((item) => item.id === lead.queryId);
  if (query) {
    query.lastQualifiedCount = state.leads.filter((item) =>
      item.queryId === query.id && item.intent === "buyer" && isLeadFresh(item)
    ).length;
  }
  persist();

  const deliveryResults = state.notifications.notifyOn.newLeads
    ? await notify({
        kind: "buyer_digest",
        query: lead.query,
        locationLabel: lead.locationFilter === "united_states" ? "United States" : "Any location",
        leads: [lead],
        nextRunAt: query?.nextRunAt || now()
      })
    : [];
  const notified = deliveryResults.filter((item) => item.ok).map((item) => item.type);
  const failed = deliveryResults.filter((item) => !item.ok).map((item) => ({
    type: item.type,
    error: item.error
  }));

  lead.manualNotificationAttemptedAt = now();
  if (notified.length) lead.manualNotificationSentAt = now();
  addActivity(
    "leads",
    "Lead manually marked as buyer",
    notified.length
      ? `@${lead.username} was qualified and sent to ${notified.join(" and ")}.`
      : failed.length
        ? `@${lead.username} was qualified, but notification delivery failed.`
        : `@${lead.username} was qualified. No delivery channel is enabled.`,
    failed.length ? "warning" : "success"
  );
  persist();

  response.json({ ok: true, lead, notified, failed });
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
