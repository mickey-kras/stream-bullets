/**
 * The responsive matrix owns 198.51.100.1-88 (TEST-NET-2), one address per case.
 * Client IPs for the e2e specs: the last octet of 192.0.2.x (TEST-NET-1), sent as CF-Connecting-IP.
 * The worker's REQUEST_LIMITER allows 120 requests a minute per IP, so specs that share an address can push
 * each other over the limit when they run back to back. Each spec owns the inclusive ranges below and asks for
 * its addresses through `clientIp`, which refuses an address outside them. Give a new spec a free range here.
 */
const ranges = {
  platform: [[10, 15]],
  mutations: [[25, 27]],
  account: [[40, 40]],
  pagination: [[50, 51]],
  moderation: [[60, 65]],
  shell: [[66, 67]],
  "discussion-history": [[75, 78]],
  // Reserved: these addresses are used without clientIp.
  mash: [[80, 82]],
  "overlay-control": [[90, 94]],
  community: [[95, 96]],
  threads: [[100, 100]],
  ideas: [[105, 111]],
  "admin-keys": [[120, 124]],
  schedule: [
    [125, 129],
    [131, 132],
  ],
  profile: [[130, 130]],
  directory: [[135, 135]],
  "route-errors": [[136, 136]],
  alignment: [[140, 149]],
  oauth: [[150, 153]],
  landing: [[154, 155]],
  a11y: [[175, 179]],
  i18n: [
    [180, 181],
    [232, 235],
  ],
  roles: [[200, 219]],
} as const satisfies Record<string, readonly (readonly [number, number])[]>;

export type Spec = keyof typeof ranges;

/** Every range as [spec, first, last], sorted by first address. */
function allocations(): [Spec, number, number][] {
  return (Object.entries(ranges) as [Spec, readonly (readonly [number, number])[]][])
    .flatMap(([spec, list]) => list.map(([first, last]): [Spec, number, number] => [spec, first, last]))
    .sort((a, b) => a[1] - b[1]);
}

/** Fails at import if a range leaves 1-254 or two ranges overlap, so a clash shows up before any test runs. */
function checkAllocations(): void {
  let previous: [Spec, number, number] | null = null;
  for (const current of allocations()) {
    const [spec, first, last] = current;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > 254 || first > last) {
      throw new Error(`Client IP range ${first}-${last} for ${spec} is not inside 192.0.2.1-254.`);
    }
    if (previous && first <= previous[2]) {
      throw new Error(`Client IP ranges of ${previous[0]} and ${spec} overlap at 192.0.2.${first}.`);
    }
    previous = current;
  }
}
checkAllocations();

/** The last octet `octet`, after checking that `spec` owns it. */
export function clientIp(spec: Spec, octet: number): number {
  if (!ranges[spec].some(([first, last]) => Number.isInteger(octet) && octet >= first && octet <= last)) {
    throw new Error(`192.0.2.${octet} is not in the ${spec} client IP range (see tests/e2e/client-ips.ts).`);
  }
  return octet;
}

/** The full address for a CF-Connecting-IP header. */
export function clientAddress(spec: Spec, octet: number): string {
  return `192.0.2.${clientIp(spec, octet)}`;
}
