import type { SpilledMessage } from "@superagent/domain";

const STOPWORDS = new Set(
	"the and for are but not you all any can had her was one our out has have this that with from they will would there their what about which when make like just into than them then its also please".split(
		" ",
	),
);

/** Lower-cased, de-duplicated words of 3+ characters, minus common stopwords. */
export function keywordTerms(query: string): string[] {
	const words = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u);
	return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

/**
 * Rank spilled messages by how many distinct query terms they contain; ties go to the
 * more recent message. Returns the top `limit` with at least one hit, oldest first.
 */
export function rankByKeywords(
	candidates: readonly SpilledMessage[],
	query: string,
	limit: number,
): SpilledMessage[] {
	const terms = keywordTerms(query);
	if (terms.length === 0 || limit <= 0) return [];
	return candidates
		.map((c) => {
			const text = c.message.content.toLowerCase();
			return { c, score: terms.filter((t) => text.includes(t)).length };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || b.c.seq - a.c.seq)
		.slice(0, limit)
		.map((x) => x.c)
		.sort((a, b) => a.seq - b.seq);
}
