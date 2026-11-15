// Responsive cases own 198.51.100.1-88. Mobile dialog/search cases own 203.0.113.1-11 and .30-40.
// Other specs use owned 192.0.2.x ranges via CF-Connecting-IP. clientIp rejects out-of-range addresses.
// Allocate free ranges to isolate each spec's 120 requests/min quota.
const ranges = {
  platform: [[10, 15]],
  mutations: [[25, 27]],
  account: [[40, 40]],
  pagination: [[50, 51]],
  moderation: [[60, 65]],
  shell: [[66, 67]],
  "discussion-history": [[75, 78]],
  // Reserved for callers without clientIp.
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
  "board-navigation": [[160, 163]],
  a11y: [[175, 179]],
  i18n: [
    [180, 181],
    [232, 235],
  ],
  roles: [[200, 219]],
  "overlay-composition": [[240, 244]],
} as const satisfies Record<string, readonly (readonly [number, number])[]>;

export type Spec = keyof typeof ranges;

function allocations(): [Spec, number, number][] {
  return (Object.entries(ranges) as [Spec, readonly (readonly [number, number])[]][])
    .flatMap(([spec, list]) => list.map(([first, last]): [Spec, number, number] => [spec, first, last]))
    .sort((a, b) => a[1] - b[1]);
}

// Reject out-of-range (1-254) or overlapping allocations at import.
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

// Validate that `spec` owns `octet`.
export function clientIp(spec: Spec, octet: number): number {
  if (!ranges[spec].some(([first, last]) => Number.isInteger(octet) && octet >= first && octet <= last)) {
    throw new Error(`192.0.2.${octet} is not in the ${spec} client IP range (see tests/e2e/client-ips.ts).`);
  }
  return octet;
}

export function clientAddress(spec: Spec, octet: number): string {
  return `192.0.2.${clientIp(spec, octet)}`;
}
