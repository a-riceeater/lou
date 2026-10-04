/**
 * Small BM25 index used for skill (and memory fallback) retrieval. Personal-scale
 * corpora are tiny, so an in-memory index rebuilt on change is plenty.
 */
export interface SearchDoc {
  id: string;
  text: string;
}

export interface SearchHit {
  id: string;
  score: number;
}

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have i if in into is it its me my of on or our so that the their them then there these they this to up was we were what when which who will with you your".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t)).map(stem);
}

/** Very light stemmer: enough to match "replying"/"replies"/"reply". */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export class Bm25Index {
  private docs: Array<{ id: string; tf: Map<string, number>; len: number }> = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(docs: SearchDoc[] = [], private readonly k1 = 1.2, private readonly b = 0.75) {
    this.rebuild(docs);
  }

  rebuild(docs: SearchDoc[]): void {
    this.docs = [];
    this.df.clear();
    let total = 0;
    for (const doc of docs) {
      const tokens = tokenize(doc.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: doc.id, tf, len: tokens.length });
      total += tokens.length;
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 0;
  }

  search(query: string, limit = 5): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length || !this.docs.length) return [];
    const n = this.docs.length;
    const hits: SearchHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of terms) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * doc.len) / (this.avgLen || 1)));
      }
      if (score > 0) hits.push({ id: doc.id, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
