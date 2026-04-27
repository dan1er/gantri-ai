const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'of', 'in', 'on', 'at', 'to', 'is', 'are',
  'was', 'were', 'by', 'from', 'this', 'that', 'these', 'those', 'me', 'my', 'we', 'our', 'team',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'y', 'o', 'pero', 'para',
  'con', 'en', 'es', 'son', 'por', 'que', 'mi', 'nos', 'nuestro', 'nuestra',
]);

export function extractKeywords(text: string): string[] {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

export function scoreSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  let n = 0;
  for (const k of b) if (setA.has(k)) n++;
  return n;
}

export interface SimilarityCandidate {
  slug: string;
  title: string;
  ownerSlackId: string;
  score: number;
}

/**
 * Picks reports whose intent_keywords overlap the query keywords by ≥`minScore`.
 * Returns sorted desc by score, capped at `limit`.
 */
export function rankCandidates(
  queryKeywords: string[],
  candidates: Array<{ slug: string; title: string; ownerSlackId: string; intentKeywords: string[] }>,
  minScore = 3,
  limit = 5,
): SimilarityCandidate[] {
  return candidates
    .map((c) => ({ slug: c.slug, title: c.title, ownerSlackId: c.ownerSlackId, score: scoreSimilarity(queryKeywords, c.intentKeywords) }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
