import fs from "node:fs";
import { classifyLead } from "../intent.js";
import { isDuplicateLead } from "../lead-dedupe.js";

const state = JSON.parse(fs.readFileSync(new URL("../data/threadline.json", import.meta.url), "utf8"));
const audited = state.leads.map((lead) => ({
  ...lead,
  previousIntent: lead.intent,
  ...classifyLead(lead.text, lead.query)
}));
const accepted = [];
for (const lead of [...audited].sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt))) {
  if (lead.intent === "buyer" && isDuplicateLead(lead, accepted)) {
    lead.intent = "general";
    lead.intentScore = 0;
    lead.intentReason = "Duplicate or reposted request";
  }
  accepted.push(lead);
}

const buyers = audited.filter((lead) => lead.intent === "buyer");
const downgraded = audited.filter((lead) => lead.previousIntent === "buyer" && lead.intent === "general");
const upgraded = audited.filter((lead) => lead.previousIntent !== "buyer" && lead.intent === "buyer");

console.log(`Audited: ${audited.length}`);
console.log(`Buyer intent: ${buyers.length}`);
console.log(`Downgraded sellers/noise: ${downgraded.length}`);
console.log(`Upgraded buyers: ${upgraded.length}`);
console.log("\nCurrent buyer candidates:");
for (const lead of buyers) {
  console.log(`- @${lead.username} [${lead.intentScore}] ${lead.text.slice(0, 180)}`);
}
