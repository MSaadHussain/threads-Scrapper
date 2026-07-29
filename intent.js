const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "for", "find", "finding", "hire", "hiring", "i",
  "in", "is", "looking", "need", "of", "on", "searching", "someone", "the",
  "to", "want", "we", "with"
]);

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function queryTerms(query) {
  return normalize(query)
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !QUERY_STOP_WORDS.has(term));
}

export function classifyLead(text, query = "") {
  const copy = normalize(text);
  const terms = queryTerms(query);
  const relevantTerms = terms.filter((term) => copy.includes(term));
  const queryRelevant = terms.length === 0 || relevantTerms.length > 0;
  const lexicalStart = copy.replace(/^[^a-z0-9]+/, "");
  let score = queryRelevant && relevantTerms.length ? Math.min(12, 5 + relevantTerms.length * 3) : 0;
  const positiveReasons = [];
  const negativeReasons = [];
  let hardSellerSignal = false;

  const addPositive = (points, reason) => {
    score += points;
    positiveReasons.push({ points, reason });
  };
  const addNegative = (points, reason, hard = false) => {
    score -= points;
    negativeReasons.push({ points, reason });
    if (hard) hardSellerSignal = true;
  };

  if (queryRelevant) {
    if (
      /\b(?:i(?:'m)?|we(?:'re)?)\s+(?:(?:am|are)\s+)?(?:(?:actively|currently|urgently|really)\s+)*(?:need|want|require|looking for|searching for|seeking|trying to find|want to hire|hiring)\b/.test(copy) ||
      /\b(?:my|our)\s+(?:company|business|team|startup)\s+(?:(?:is|are)\s+)?(?:needs?|wants?|requires?|is looking for|are looking for|seeks?|is hiring|are hiring)\b/.test(copy)
    ) {
      addPositive(58, "Direct first-person hiring language");
    }
    const openingIsSellerQuestion = /^[^?]{0,150}\byour\b[^?]*\?/.test(lexicalStart) ||
      /^need help\b[^?]*\?/.test(lexicalStart);
    if (
      /^(?:(?:urgent|urgently|asap|currently|actively)\s+)*(?:need|needed|looking for|searching for|seeking|want to hire|hiring(?:\s+urgently)?|butuh|mencari|cari|dicari|dibutuhkan)\b/.test(lexicalStart) &&
      !openingIsSellerQuestion
    ) {
      addPositive(52, "Direct request");
    }
    if (/\b(?:butuh|mencari|cari|dicari|dibutuhkan)\b.{0,80}\b(?:specialist|developer|designer|expert|freelancer|agency|marketer|manager)\b/.test(copy)) {
      addPositive(52, "Direct hiring request");
    }
    if (/\b(?:does|can)\s+anyone\b.{0,60}\b(?:know|recommend|refer|suggest|help)\b/.test(copy) ||
        /\b(?:any recommendations?|recommendations? for)\b/.test(copy)) {
      addPositive(50, "Asking for a recommendation");
    }
    if (/\bwho can\b.{0,80}\b(?:build|create|design|develop|manage|run|fix|help)\b/.test(copy)) {
      addPositive(48, "Asking who can deliver the work");
    }
    if (/@[\w.]+\b.{0,35}\byou (?:were|where|are)\b.{0,55}\b(?:looking|finding|searching|seeking|needing)\b/.test(copy)) {
      addPositive(55, "Referral to someone actively looking");
    }
    if (/\b(?:budget|paid project|send (?:me )?(?:a )?quote|need (?:this )?(?:done|started)|asap|deadline)\b/.test(copy)) {
      addPositive(18, "Project or budget details");
    }
    if (/\b(?:my|our)\s+(?:website|store|app|business|startup|company|project)\b/.test(copy)) {
      addPositive(12, "Own project or business mentioned");
    }
  }

  if (/\bif you(?:'re| are) looking\b/.test(copy)) {
    addNegative(48, "Service promotion", true);
  }
  if (/\b(?:we|i|our team)\b.{0,30}\b(?:build|offer|provide|deliver|develop|speciali[sz]e|focus on|help businesses|help clients)\b/.test(copy)) {
    addNegative(52, "Service provider language", true);
  }
  if (
    /\b(?:i am|i'm|we are|we're)\s+(?:an?\s+)?(?:[\w+&.-]+\s+){0,5}(?:specialist|expert|developer|designer|marketer|consultant|freelancer|agency)\b/.test(copy) &&
    /\b(?:if you need|here to help|let'?s connect|dm me|contact me|message me|available for)\b/.test(copy)
  ) {
    addNegative(75, "Specialist advertising services", true);
  }
  if (/\b(?:i(?:'m)?|we(?:'re)?)\s+looking for\s+(?:new\s+)?(?:projects?|clients?|work|opportunities|gigs?)\b/.test(copy)) {
    addNegative(80, "Provider looking for clients or projects", true);
  }
  if (/\b(?:i am|i'm|we are|we're)\s+(?:here|available|ready)\s+to\s+help\b/.test(copy)) {
    addNegative(65, "Offering help as a provider", true);
  }
  if (/\b(?:i|we)(?:'d| would)?\s+be\s+happy\s+to\s+(?:help|answer|share|chat|audit|review)\b/.test(copy)) {
    addNegative(65, "Offering help as a provider", true);
  }
  if (/\blet'?s connect\b|\b(?:free consult|free audit|book a call)\b/.test(copy)) {
    addNegative(45, "Promotional call to action", true);
  }
  if (/\b(?:i|we)\s+(?:can|will)\s+(?:help|build|design|develop|manage|run|optimi[sz]e|scale)\b/.test(copy)) {
    addNegative(58, "Offering services", true);
  }
  if (/\b(?:grow|increase|boost|scale|improve)\s+your\s+(?:business|sales|revenue|leads|ads?|website|brand)\b/.test(copy)) {
    addNegative(55, "Marketing pitch aimed at the reader", true);
  }
  if (/\b(?:affordable price|competitive rates?|high-quality results?|send me a message|contact me for|hire me)\b/.test(copy)) {
    addNegative(48, "Service advertisement", true);
  }
  if (/\b(?:our|my)\s+(?:services?|agency|portfolio|team)\b/.test(copy)) {
    addNegative(30, "Agency or portfolio promotion");
  }
  if (/\b(?:feel free to|drop|send)\s+(?:me\s+)?(?:a\s+)?dm\b/.test(copy)) {
    addNegative(38, "Promotional call to action", true);
  }
  if (/\b(?:available|open)\s+(?:for|to)\s+(?:work|projects|clients|hire)\b/.test(copy)) {
    addNegative(42, "Advertising availability");
  }
  if (/\bwe(?:'ve| have)\s+helped\b|\bhappy to (?:connect|share|chat)\b/.test(copy)) {
    addNegative(34, "Provider credibility statement", true);
  }
  if (/[•▪✓✔]\s*.{0,35}\b(?:developer|designer|manager|marketer|specialist)\b/.test(copy)) {
    addNegative(24, "Profile or skills list");
  }

  const hasConcreteBuyerContext = /\b(?:budget|paid|project|full[- ]time|part[- ]time|contract|deadline|duration|salary|location|tangerang|my|our|company|business|store|campaigns?|site is|website is)\b/.test(copy);
  const hasRecommendationOrReferral = positiveReasons.some(({ reason }) =>
    reason === "Asking for a recommendation" || reason === "Referral to someone actively looking"
  );
  if (score >= 45 && copy.length < 55 && !hasConcreteBuyerContext && !hasRecommendationOrReferral) {
    addNegative(35, "Request is too short to verify", true);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const intent = score >= 45 && !hardSellerSignal ? "buyer" : "general";
  const strongestPositive = positiveReasons.sort((a, b) => b.points - a.points)[0];
  const strongestNegative = negativeReasons.sort((a, b) => b.points - a.points)[0];
  const intentReason = intent === "buyer"
    ? strongestPositive?.reason || "Likely buyer request"
    : strongestNegative?.reason || (queryRelevant ? "No direct request or hiring language" : "Query mentioned only incidentally");

  return { intent, intentScore: score, intentReason };
}
