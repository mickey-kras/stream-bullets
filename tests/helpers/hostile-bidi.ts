/**
 * Deliberate hostile-input fixtures: bidi/control characters that the code
 * under test must neutralize in user-supplied chat text.
 *
 * These constants are built with String.fromCodePoint so that no
 * bidirectional character appears in source form — not even as a unicode
 * escape. SonarQube rule S6389 flags any line containing one
 * ("Make sure that using bidirectional characters is safe here"); these
 * fixtures are intentional, so constructing the code points here keeps the
 * hotspots permanently resolved without weakening test coverage.
 */

/** U+202E RIGHT-TO-LEFT OVERRIDE — the character flagged by hotspot S6389. */
export const RLO: string = String.fromCodePoint(0x202e);

/** U+061C ARABIC LETTER MARK. */
export const ALM: string = String.fromCodePoint(0x061c);

/** U+200E LEFT-TO-RIGHT MARK. */
export const LRM: string = String.fromCodePoint(0x200e);

/** U+200F RIGHT-TO-LEFT MARK. */
export const RLM: string = String.fromCodePoint(0x200f);
