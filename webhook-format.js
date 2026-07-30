function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeSlack(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncate(value, limit) {
  const copy = clean(value);
  return copy.length > limit ? `${copy.slice(0, limit - 1)}…` : copy;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "https://www.threads.com";
  } catch {
    return "https://www.threads.com";
  }
}

export function slackPayload(message) {
  if (message.kind === "buyer_digest") {
    const count = message.leads.length;
    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `🎯 ${count} new buyer-intent lead${count === 1 ? "" : "s"}`,
          emoji: true
        }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Search*\n${escapeSlack(message.query)}` },
          { type: "mrkdwn", text: `*Qualified*\n${count} new` },
          ...(message.locationLabel ? [{ type: "mrkdwn", text: `*Location*\n${escapeSlack(message.locationLabel)}` }] : [])
        ]
      },
      { type: "divider" }
    ];

    message.leads.slice(0, 5).forEach((lead, index) => {
      const profileUrl = safeUrl(lead.profileUrl);
      const threadUrl = safeUrl(lead.threadUrl || lead.profileUrl);
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${profileUrl}|@${escapeSlack(lead.username)}>*  \`Buyer ${lead.intentScore || 0}/100\`  _Posted ${escapeSlack(lead.timeText || "recently")}_\n${escapeSlack(truncate(lead.text, 260))}\n<${threadUrl}|Open original Threads post →>`
        }
      });
      if (index < Math.min(message.leads.length, 5) - 1) blocks.push({ type: "divider" });
    });

    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `Threadline · Next scan ${escapeSlack(new Date(message.nextRunAt).toLocaleString())}`
      }]
    });

    return {
      text: `${count} new buyer-intent lead${count === 1 ? "" : "s"} for “${message.query}”`,
      blocks
    };
  }

  return {
    text: message.title,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: message.title, emoji: true }
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: escapeSlack(message.body) }
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Threadline · Buyer-intent lead radar" }]
      }
    ]
  };
}

export function discordPayload(message) {
  if (message.kind === "buyer_digest") {
    const count = message.leads.length;
    return {
      username: "Threadline",
      content: `🎯 **${count} new buyer-intent lead${count === 1 ? "" : "s"}**`,
      embeds: message.leads.slice(0, 5).map((lead) => ({
        author: { name: `@${lead.username}` },
        title: truncate(lead.text, 90),
        description: truncate(lead.text, 320),
        url: safeUrl(lead.threadUrl || lead.profileUrl),
        color: 16741975,
        fields: [
          { name: "Search", value: truncate(message.query, 80), inline: true },
          ...(message.locationLabel ? [{ name: "Location", value: message.locationLabel, inline: true }] : []),
          { name: "Buyer intent", value: `${lead.intentScore || 0}/100`, inline: true },
          { name: "Posted", value: lead.timeText || "Recently", inline: true },
          { name: "Why it matched", value: truncate(lead.intentReason, 100), inline: false }
        ],
        timestamp: lead.discoveredAt || new Date().toISOString()
      }))
    };
  }

  return {
    username: "Threadline",
    embeds: [{
      title: message.title,
      description: message.body,
      color: message.tone === "error" ? 15158332 : 16741975,
      timestamp: new Date().toISOString()
    }]
  };
}
