import assert from "node:assert/strict";
import { isLeadFresh, parseThreadsTime } from "../thread-time.js";

const reference = Date.parse("2026-07-30T12:00:00.000Z");

const elevenHours = parseThreadsTime("11 hours ago", "11h", reference);
assert.equal(elevenHours.isRecent, true);
assert.equal(elevenHours.postedAt, "2026-07-30T01:00:00.000Z");
assert.equal(elevenHours.timeText, "11h");

assert.equal(parseThreadsTime("24 hours ago", "24h", reference).isRecent, false);
assert.equal(parseThreadsTime("25 hours ago", "25h", reference).isRecent, false);
assert.equal(parseThreadsTime("2 days ago", "2d", reference).isRecent, false);
assert.equal(parseThreadsTime("2 days ago", "2d", reference, 72 * 60 * 60 * 1000).isRecent, true);
assert.equal(parseThreadsTime("3 days ago", "3d", reference, 72 * 60 * 60 * 1000).isRecent, true);
assert.equal(parseThreadsTime("7 days ago", "7d", reference, 7 * 24 * 60 * 60 * 1000).isRecent, true);
assert.equal(parseThreadsTime("", "3h", reference).isRecent, true);
assert.equal(parseThreadsTime("", "", reference).isRecent, false);

assert.equal(isLeadFresh({ postedAt: "2026-07-29T13:00:00.000Z" }, reference), true);
assert.equal(isLeadFresh({ postedAt: "2026-07-29T12:00:00.000Z" }, reference), false);
assert.equal(isLeadFresh({ postedAt: "2026-07-29T11:59:59.000Z" }, reference), false);
assert.equal(isLeadFresh({ postedAt: "2026-07-28T12:00:01.000Z", maxAgeHours: 72 }, reference), true);
assert.equal(isLeadFresh({
  postedAt: "2026-07-27T12:00:00.000Z",
  freshUntil: "2026-07-31T12:00:00.000Z",
  maxAgeHours: 72
}, reference), true);

console.log("Threads relative timestamps: valid");
console.log("24-hour freshness gate: valid");
