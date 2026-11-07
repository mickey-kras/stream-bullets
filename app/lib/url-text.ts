/**
 * True when a link has no control, format or whitespace characters anywhere. WHATWG URL parsing drops tabs and line
 * breaks without a word, so a link with a CR or LF inside still parses. Those characters must never reach a stored
 * link or a line of an .ics file (security review finding 2).
 */
export function isPlainUrlText(value: string): boolean {
  return /^[^\p{Cc}\p{Cf}\s]*$/u.test(value);
}
