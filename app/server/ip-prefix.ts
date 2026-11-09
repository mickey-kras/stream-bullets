/**
 * The network a visitor's address belongs to, for counting and rate limits. An IPv4 address is its own key. An IPv6
 * address becomes its /64: one home or one server gets a whole /64, so keying the full address would give a single
 * attacker 2^64 identities (security review finding 3). An IPv4-mapped IPv6 address counts as the IPv4 address.
 * Text that is not an address comes back unchanged, which is no worse than keying the raw value.
 */
export function visitorPrefix(ip: string): string {
  const address: string = ip.trim().toLowerCase().split("%")[0];
  if (!address.includes(":")) return address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(address);
  if (mapped) return mapped[1];
  const halves: string[] = address.split("::");
  if (halves.length > 2) return address;
  const groups = (half: string | undefined): string[] => (half ? half.split(":") : []);
  // An embedded IPv4 tail fills two groups.
  const size = (parts: string[]): number =>
    parts.reduce((total: number, part: string) => total + (part.includes(".") ? 2 : 1), 0);
  const left: string[] = groups(halves[0]);
  const right: string[] = groups(halves[1]);
  const missing: number = 8 - size(left) - size(right);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return address;
  const full: string[] = [...left, ...Array.from({ length: missing }, (): string => "0"), ...right];
  const network: string[] = full.slice(0, 4);
  if (!network.every((group: string): boolean => /^[0-9a-f]{1,4}$/u.test(group))) return address;
  return `${network.map((group: string): string => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}
