const { POSTS_PER_SITE } = require("./paths");

function postsBatchPrompt(niche) {
  return `You are the editor of an automated niche blog. Return ONLY valid JSON as an object with a "posts" array containing exactly ${POSTS_PER_SITE} posts.
Each post object must have exactly these fields:
{
  "slug": "kebab-case",
  "title": "string",
  "category": "one of: ${niche.categories.join(", ")}",
  "dek": "one-sentence standfirst under 160 chars",
  "takeaway": "one-sentence key takeaway",
  "whatHappened": "2-3 sentence paragraph",
  "whyItMatters": "2-3 sentence paragraph",
  "howToThink": "2-3 sentence paragraph of practical advice",
  "pros": ["3 short strings"],
  "cons": ["3 short strings"],
  "watchOut": "one-sentence caution",
  "faq": [{"q": "string", "a": "string"}, {"q": "string", "a": "string"}, {"q": "string", "a": "string"}],
  "tags": ["2 short strings"]
}
Niche: ${niche.name}
Audience: ${niche.audience}
Categories: ${niche.categories.join(", ")}
Tone: punchy, editorial, practical — a trend brief for ${niche.audience}. No fluff.
HONESTY RULES (hard requirements, not suggestions):
- Never invent statistics, percentages, study results, survey data, or named researchers/people. No "a 2024 study found", no "73% of users", no fake expert quotes.
- Never state specific measurements ("1 ms drop", "37% faster", "saves 4 hours a week") unless they are generic, well-known facts (e.g. "SSDs are faster than spinning disks").
- Never invent testimonials, case studies, or anecdotes about named or unnamed individuals ("one collector told me...").
- If a detail cannot be verified from general knowledge, write around it or omit it — vague-but-true beats specific-and-false. Prefer mechanisms, trade-offs, and how-to reasoning over claimed outcomes.
Respond with: { "posts": [ ... ] }`;
}

function hourlyPostPrompt(niche, existingPosts) {
  const recentTitles = existingPosts.slice(0, 12).map((post) => post.title);
  return `You are the editor of "${niche.name}", an automated dispatch blog for ${niche.audience}.
Write ONE new post. Return ONLY valid JSON as a single object with exactly these fields:
{
  "slug": "kebab-case",
  "title": "string — must NOT overlap these recent titles: ${JSON.stringify(recentTitles)}",
  "category": "one of: ${niche.categories.join(", ")}",
  "dek": "one-sentence standfirst under 160 chars",
  "takeaway": "one-sentence key takeaway",
  "whatHappened": "2-3 sentence paragraph",
  "whyItMatters": "2-3 sentence paragraph",
  "howToThink": "2-3 sentence paragraph of practical advice",
  "pros": ["3 short strings"],
  "cons": ["3 short strings"],
  "watchOut": "one-sentence caution",
  "faq": [{"q": "string", "a": "string"}, {"q": "string", "a": "string"}, {"q": "string", "a": "string"}],
  "tags": ["2 short strings"]
}
Tone: punchy, editorial, practical. Stay strictly on the niche: ${niche.categories.join(", ")} for ${niche.audience}.
HONESTY RULES (hard requirements, not suggestions):
- Never invent statistics, percentages, study results, survey data, or named researchers/people.
- Never state specific measurements ("1 ms drop", "37% faster") unless they are generic, well-known facts.
- Never invent testimonials, case studies, or anecdotes about named or unnamed individuals.
- If a detail cannot be verified from general knowledge, write around it or omit it — vague-but-true beats specific-and-false.`;
}

function parseModelJson(text) {
  const cleaned = String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

function extractPostsArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.posts)) return parsed.posts;
  throw new Error("Model returned invalid posts array");
}

module.exports = {
  postsBatchPrompt,
  hourlyPostPrompt,
  parseModelJson,
  extractPostsArray,
  POSTS_PER_SITE
};
