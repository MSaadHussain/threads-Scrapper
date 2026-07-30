import assert from "node:assert/strict";
import { classifyLead } from "../intent.js";

const query = "finding web developer";
const cases = [
  ["general", "Finding a genuinely proper web developer can be tricky, but it's exactly what we focus on delivering for businesses. If you're looking for functional and professional, feel free to drop a DM."],
  ["general", "Finding the right web developer for your project is important. We often build custom web applications and happy to share some insights if you're still exploring options."],
  ["general", "• Video Editor • Social Media Manager • Graphic Designer • UI/UX Designer • Web Developer • Digital Marketer"],
  ["general", "I am running an agency and I am hiring a sales person that can sign clients for me."],
  ["general", "Meet Keivo, the latest housemate. He is a web developer and is open to finding love."],
  ["general", "Finding great web developer talent is a smart hunt. We're regularly connecting with developers, so feel free to DM."],
  ["general", "Finding the right professional developer can be a challenge; we've helped businesses build their web presence. Happy to connect."],
  ["general", "Hi! I am a Google and Meta Ads Specialist. If you need to increase your business sales, I am here to help you. Let's connect", "need meta ads specialist urgently"],
  ["general", "Need help improving your Facebook or Instagram ads? Whether you're looking for more leads, more sales, or a better return on your ad spend, I'd be happy to answer your questions.", "need meta ads specialist urgently"],
  ["general", "Hi! I fully understand - you need an urgent professional website developer. I work at iWeb and have 10+ years building reliable sites. I can review your requirements - DM me for a free consult."],
  ["general", "Hey everyone! I'm looking for new projects for WordPress website development or landing page creation. I am a web developer focused on delivering high-quality results at an affordable price. If you need a reliable website, send me a message!", "need a wordpress developer urgently"],
  ["general", "It’s been really tough securing a job as a Web Developer. If anyone has any open roles in any field, please connect with me. I urgently need a job and would be grateful for any opportunity.", "need web developer"],
  ["general", "I'm actively looking for a frontend developer role and I am open to work. Please refer me if your company has an opening.", "need web developer"],
  ["general", "Currently unemployed and seeking employment opportunities as a Meta Ads specialist.", "need meta ads specialist"],
  ["general", "I need urgent website developer.", "need website developer urgent"],
  ["buyer", "@alex377275 you where finding a web developer right?"],
  ["buyer", "I'm looking for a web developer to rebuild our company website. Please send me a quote."],
  ["buyer", "We are hiring a Web Developer for an open role on our product team. Send your portfolio.", "need web developer"],
  ["buyer", "Does anyone know a reliable web developer for a paid project?"],
  ["buyer", "Hi is there any website developer here? Looking for a website developer to build website for my business. Some sections must use WordPress or Webflow CMS.", "Web developer Needed"],
  ["buyer", "Need a web developer ASAP for our Shopify store."],
  ["buyer", "Looking for a web developer urgently. Our website is broken and I need an expert who can rebuild it. Please DM me your portfolio."],
  ["buyer", "Looking for a Meta Ads Specialist urgently. My campaigns are burning budget and I need an expert who can optimize them. Please DM me your portfolio.", "need meta ads specialist urgently"],
  ["buyer", "Urgently need Ads Specialist(meta), full time di Tangerang cari yang bisa handle akun dari 0, dan juga gak buta soal e-commerce.", "finding a meta ads specialist"],
  ["buyer", "🚨 Hiring Urgently – WordPress Developer Need a simple portfolio website built on WordPress. Project Duration: 2–3 Days Budget: ₹3,000 Scope: Clean and responsive.", "need a wordpress developer urgently"],
  ["buyer", "Urgently looking for a web developer who is conversant in WordPress and Elementor. My service provider is ghosting me and I urgently need to edit my site.", "need a wordpress developer urgently"]
];

for (const [expected, text, caseQuery = query] of cases) {
  const result = classifyLead(text, caseQuery);
  assert.equal(result.intent, expected, `${expected} expected for: ${text}\n${JSON.stringify(result)}`);
  console.log(`${result.intent.padEnd(7)} ${String(result.intentScore).padStart(3)}  ${result.intentReason}`);
}
