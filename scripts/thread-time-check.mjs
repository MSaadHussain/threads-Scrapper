import assert from "node:assert/strict";
import { isLeadFresh, parseThreadsTime } from "../thread-time.js";

const reference = Date.parse("2026-07-30T12:00:00.000Z");

const elevenHours = parseThreadsTime("11 hours ago", "11h", reference);
assert.equal(elevenHours.isRecent, true);
assert.equal(elevenHours.postedAt, "2026-07-30T01:00:00.000Z");
assert.equal(elevenHours.timeText, "11h");

assert.equal(parseThreadsTime("24 hours ago", "24h", reference).isRecent, true);
assert.equal(parseThreadsTime("25 hours ago", "25h", reference).isRecent, false);
assert.equal(parseThreadsTime("2 days ago", "2d", reference).isRecent, false);
assert.equal(parseThreadsTime("", "3h", reference).isRecent, true);
assert.equal(parseThreadsTime("", "", reference).isRecent, false);

assert.equal(isLeadFresh({ postedAt: "2026-07-29T13:00:00.000Z" }, reference), true);
assert.equal(isLeadFresh({ postedAt: "2026-07-29T11:59:59.000Z" }, reference), false);

console.log("Threads relative timestamps: valid");
console.log("24-hour freshness gate: valid");
