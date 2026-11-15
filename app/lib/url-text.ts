// Reject control, format and whitespace characters. URL parsing silently removes tabs/newlines; stored links
// and ICS lines must never contain them.
export function isPlainUrlText(value: string): boolean {
  return /^[^\p{Cc}\p{Cf}\s]*$/u.test(value);
}
