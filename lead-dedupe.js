const TOKEN_STOP_WORDS = new Set([
  "a", "an", "and", "are", "for", "i", "in", "is", "it", "my", "of", "on",
  "or", "our", "the", "to", "we", "with"
]);

export function canonicalLeadText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9+#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value) {
  return new Set(
    canonicalLeadText(value)
      .split(" ")
      .filter((token) => token.length > 2 && !TOKEN_STOP_WORDS.has(token))
  );
}

export function textSimilarity(left, right) {
  const a = meaningfulTokens(left);
  const b = meaningfulTokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / new Set([...a, ...b]).size;
}

export function isDuplicateLead(candidate, existingLeads) {
  const candidateUrl = String(candidate.threadUrl || "").toLowerCase();
  const candidateUsername = String(candidate.username || "").toLowerCase();
  const candidateText = canonicalLeadText(candidate.text);
  if (!candidateText) return false;

  return existingLeads.some((lead) => {
    if (candidateUrl && String(lead.threadUrl || "").toLowerCase() === candidateUrl) return true;
    const existingText = canonicalLeadText(lead.text);
    if (candidateText === existingText) return true;
    const sameAuthor = candidateUsername && candidateUsername === String(lead.username || "").toLowerCase();
    return sameAuthor && textSimilarity(candidate.text, lead.text) >= 0.78;
  });
}
