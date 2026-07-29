import assert from "node:assert/strict";
import { discordPayload, slackPayload } from "../webhook-format.js";

const message = {
  kind: "buyer_digest",
  query: "looking for a web developer",
  nextRunAt: "2026-07-29T14:30:00.000Z",
  leads: [{
    username: "sample.founder",
    profileUrl: "https://www.threads.com/@sample.founder",
    threadUrl: "https://www.threads.com/@sample.founder/post/sample",
    text: "Looking for a web developer to rebuild our company website. Paid project, starting next week.",
    intentScore: 96,
    intentReason: "Direct first-person hiring language",
    timeText: "11h",
    discoveredAt: "2026-07-29T14:15:00.000Z"
  }]
};

const slack = slackPayload(message);
assert.equal(slack.blocks[0].type, "header");
assert.match(slack.blocks[0].text.text, /1 new buyer-intent lead$/);
assert.equal(slack.blocks.filter((block) => block.type === "section").length, 2);
assert.match(slack.blocks[3].text.text, /Buyer 96\/100/);
assert.match(slack.blocks[3].text.text, /Posted 11h/);
assert.match(slack.blocks[3].text.text, /Open original Threads post/);
assert.doesNotMatch(slack.text, /search completed/i);

const discord = discordPayload(message);
assert.equal(discord.embeds.length, 1);
assert.equal(discord.embeds[0].author.name, "@sample.founder");
assert.equal(discord.embeds[0].fields[1].value, "96/100");
assert.equal(discord.embeds[0].fields[2].value, "11h");

console.log("Slack buyer card: valid");
console.log("Discord buyer embed: valid");
