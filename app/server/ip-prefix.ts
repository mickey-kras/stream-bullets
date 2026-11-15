// The eight 16-bit groups of an IPv6 address, or null when the text is not one.
function ipv6Groups(address: string): number[] | null {
  // A dotted IPv4 tail (`::ffff:192.0.2.1`) becomes its two hex groups.
  const dotted = /(^|:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address);
  let text: string = address;
  if (dotted) {
    const bytes: number[] = dotted.slice(2).map(Number);
    if (bytes.some((byte: number): boolean => byte > 255)) return null;
    const hex = (high: number, low: number): string => ((high << 8) | low).toString(16);
    text = `${address.slice(0, dotted.index)}${dotted[1]}${hex(bytes[0], bytes[1])}:${hex(bytes[2], bytes[3])}`;
  }
  const halves: string[] = text.split("::");
  if (halves.length > 2) return null;
  const parts = (half: string): string[] => (half ? half.split(":") : []);
  const left: string[] = parts(halves[0]);
  const right: string[] = halves.length === 2 ? parts(halves[1]) : [];
  const missing: number = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all: string[] = [...left, ...Array.from({ length: missing }, (): string => "0"), ...right];
  if (!all.every((group: string): boolean => /^[0-9a-f]{1,4}$/u.test(group))) return null;
  return all.map((group: string): number => Number.parseInt(group, 16));
}

// Rate-limit key: full IPv4 or IPv6 /64, preventing 2^64 identities per network. Canonicalize IPv4-mapped IPv6
// in all spellings. Invalid input stays unchanged.
export function visitorPrefix(ip: string): string {
  const address: string = ip.trim().toLowerCase().split("%")[0];
  if (!address.includes(":")) return address;
  const groups = ipv6Groups(address);
  if (!groups) return address;
  if (groups.slice(0, 5).every((group: number): boolean => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group: number): string => group.toString(16))
    .join(":")}::/64`;
}
