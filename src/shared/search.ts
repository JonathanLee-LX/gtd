/** D1 rejects LIKE / GLOB patterns longer than this many UTF-8 bytes. */
export const D1_LIKE_PATTERN_MAX_BYTES = 50;

/**
 * Max UTF-8 bytes for the user term inside `%…%`.
 * Two bytes are reserved for the wrapping wildcards.
 */
export const SEARCH_Q_MAX_BYTES = D1_LIKE_PATTERN_MAX_BYTES - 2;

/** Character cap for Zod / API validation (byte truncate still applied server-side). */
export const SEARCH_Q_MAX_CHARS = SEARCH_Q_MAX_BYTES;

/** Truncate `input` to at most `maxBytes` UTF-8 bytes without splitting a code unit. */
export function truncateUtf8Bytes(input: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = new TextEncoder().encode(input);
	if (bytes.length <= maxBytes) return input;
	let end = maxBytes;
	// Skip UTF-8 continuation bytes (10xxxxxx) so we don't cut mid-character.
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
		end -= 1;
	}
	return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * Strip LIKE wildcards from user input and truncate to a D1-safe byte length.
 * Caller wraps the result as `%term%` (total ≤ {@link D1_LIKE_PATTERN_MAX_BYTES}).
 */
export function sanitizeSearchQuery(q: string): string {
	const cleaned = q.replace(/%/g, "").replace(/_/g, "").trim();
	return truncateUtf8Bytes(cleaned, SEARCH_Q_MAX_BYTES);
}
