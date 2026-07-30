import assert from "node:assert/strict";
import { matchLocation } from "../location-filter.js";

assert.equal(matchLocation("Looking for a developer in the United States.", "united_states").locationMatch, true);
assert.equal(matchLocation("USA-based founders only", "united_states").locationMatch, true);
assert.equal(matchLocation("Need a U.S. WordPress specialist", "united_states").locationMatch, true);
assert.equal(matchLocation("Call +1 (415) 555-0123", "united_states").locationMatch, true);
assert.equal(matchLocation("Please send us your portfolio", "united_states").locationMatch, false);
assert.equal(matchLocation("Based in the UK", "united_states").locationMatch, false);
assert.equal(matchLocation("Anywhere is fine", "any").locationMatch, true);

console.log("United States keyword matching: valid");
console.log("+1 phone matching: valid");
console.log("Lowercase pronoun “us” rejection: valid");
