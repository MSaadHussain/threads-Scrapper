export const LOCATION_FILTERS = new Set(["any", "united_states"]);

export function matchLocation(text, locationFilter = "any") {
  if (locationFilter === "any") {
    return { locationMatch: true, locationReason: "Any location" };
  }

  const copy = String(text || "");
  if (/\bunited states\b/i.test(copy)) {
    return { locationMatch: true, locationReason: "United States keyword" };
  }
  if (/(?:^|[^a-z])usa(?=$|[^a-z])/i.test(copy)) {
    return { locationMatch: true, locationReason: "USA keyword" };
  }
  if (/(?:^|[^A-Za-z])U\.?S\.?(?=$|[^A-Za-z])/.test(copy)) {
    return { locationMatch: true, locationReason: "US keyword" };
  }
  if (/(?:^|[^\d])\+1[\s().-]*(?:\d[\s().-]*){10}(?!\d)/.test(copy)) {
    return { locationMatch: true, locationReason: "+1 phone number" };
  }

  return { locationMatch: false, locationReason: "No United States signal" };
}
