import assert from "node:assert/strict";
import { isDuplicateLead, textSimilarity } from "../lead-dedupe.js";

const existing = [{
  username: "__dynamic_prince3",
  threadUrl: "https://www.threads.com/@__dynamic_prince3/post/one",
  text: "I need urgent website developer."
}];

assert.equal(isDuplicateLead({
  username: "__dynamic_prince3",
  threadUrl: "https://www.threads.com/@__dynamic_prince3/post/two",
  text: "I need an urgent Professional Website Developer."
}, existing), true);

assert.equal(isDuplicateLead({
  username: "copied.account",
  threadUrl: "https://www.threads.com/@copied.account/post/three",
  text: "I need urgent website developer."
}, existing), true);

assert.equal(isDuplicateLead({
  username: "real.founder",
  threadUrl: "https://www.threads.com/@real.founder/post/four",
  text: "Looking for a WordPress developer to repair our checkout before Friday. Budget is $500."
}, existing), false);

assert.ok(textSimilarity(
  "I need urgent website developer.",
  "I need an urgent Professional Website Developer."
) >= 0.78);

console.log("Exact repost filtering: valid");
console.log("Same-author similarity filtering: valid");
