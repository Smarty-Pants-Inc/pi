/** Conservative admission: no shell constructs, quotes, escapes, or partial words before the cursor. */
export function isShellPasteBoundary(text: string, cursor: { line: number; col: number } | undefined): boolean {
	if (!cursor || cursor.line !== 0 || text.includes("\n") || cursor.col < 0 || cursor.col > text.length) return false;
	const before = text.slice(0, cursor.col).replace(/^\s*!/, "");
	// Insertion adds a separator after the quoted argument when another word follows.
	return /^[\t A-Za-z0-9_./~:@-]*$/.test(before) && (before.length === 0 || /[\t ]$/.test(before));
}
