const HOUR_MS = 60 * 60 * 1000;
export const MAX_LEAD_AGE_MS = 24 * HOUR_MS;

const UNIT_MS = {
  second: 1000,
  minute: 60 * 1000,
  hour: HOUR_MS,
  day: 24 * HOUR_MS,
  week: 7 * 24 * HOUR_MS,
  month: 30 * 24 * HOUR_MS,
  year: 365 * 24 * HOUR_MS
};

export function parseThreadsTime(
  ariaLabel = "",
  visibleText = "",
  referenceTime = Date.now(),
  maxAgeMs = MAX_LEAD_AGE_MS
) {
  const label = String(ariaLabel || "").trim();
  const visible = String(visibleText || "").trim();
  const copy = `${label} ${visible}`.toLowerCase().replace(/\s+/g, " ").trim();
  let ageMs = null;
  let precisionMs = 0;

  const relative = copy.match(/\b(\d+|a|an)\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/);
  if (relative) {
    const amount = ["a", "an"].includes(relative[1]) ? 1 : Number(relative[1]);
    ageMs = amount * UNIT_MS[relative[2]];
    precisionMs = UNIT_MS[relative[2]];
  }

  if (ageMs === null) {
    const shorthand = visible.toLowerCase().match(/^(\d+)\s*(s|m|h|d|w)$/);
    const shorthandUnits = { s: 1000, m: 60 * 1000, h: HOUR_MS, d: 24 * HOUR_MS, w: 7 * 24 * HOUR_MS };
    if (shorthand) {
      ageMs = Number(shorthand[1]) * shorthandUnits[shorthand[2]];
      precisionMs = shorthandUnits[shorthand[2]];
    }
  }

  if (ageMs === null && /\bjust now\b/.test(copy)) {
    ageMs = 0;
    precisionMs = 60 * 1000;
  }
  if (ageMs === null && /\byesterday\b/.test(copy)) {
    ageMs = 24 * HOUR_MS;
    precisionMs = 24 * HOUR_MS;
  }

  if (ageMs !== null) {
    const extendedBoundaryTolerance = maxAgeMs > MAX_LEAD_AGE_MS && ageMs === maxAgeMs
      ? precisionMs
      : 0;
    const isRecent = ageMs < maxAgeMs || extendedBoundaryTolerance > 0;
    const postedAtMs = referenceTime - ageMs;
    return {
      postedAt: new Date(postedAtMs).toISOString(),
      freshUntil: isRecent
        ? new Date(postedAtMs + maxAgeMs + extendedBoundaryTolerance).toISOString()
        : null,
      ageMs,
      isRecent,
      timeLabel: label || visible,
      timeText: visible || label
    };
  }

  const absoluteTime = Date.parse(label);
  if (Number.isFinite(absoluteTime) && absoluteTime <= referenceTime + 5 * 60 * 1000) {
    const absoluteAge = Math.max(0, referenceTime - absoluteTime);
    return {
      postedAt: new Date(absoluteTime).toISOString(),
      freshUntil: absoluteAge < maxAgeMs
        ? new Date(absoluteTime + maxAgeMs).toISOString()
        : null,
      ageMs: absoluteAge,
      isRecent: absoluteAge < maxAgeMs,
      timeLabel: label,
      timeText: visible || label
    };
  }

  return {
    postedAt: null,
    freshUntil: null,
    ageMs: null,
    isRecent: false,
    timeLabel: label || visible,
    timeText: visible || label
  };
}

export function isLeadFresh(lead, referenceTime = Date.now()) {
  const timestamp = lead.postedAt || lead.discoveredAt;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const storedFreshUntil = Date.parse(lead.freshUntil);
  if (Number.isFinite(storedFreshUntil)) {
    return referenceTime >= parsed && referenceTime < storedFreshUntil;
  }
  const age = referenceTime - parsed;
  const configuredHours = Number(lead.maxAgeHours);
  const maxAgeMs = Number.isFinite(configuredHours) && configuredHours > 0
    ? configuredHours * HOUR_MS
    : MAX_LEAD_AGE_MS;
  return age >= 0 && age < maxAgeMs;
}
