// Largest-remainder rounding totals 100 using integers. Ties favor earlier options. No votes yields all zeros.
// Shared by polls, overlays and battles.
export function largestRemainder(counts: readonly number[]): number[] {
  const votes: number[] = counts.map((count: number): number =>
    Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
  );
  const total: number = votes.reduce((sum: number, count: number): number => sum + count, 0);
  if (total === 0) return votes.map((): number => 0);
  const shares: number[] = votes.map((count: number): number => Math.floor((count * 100) / total));
  const remainders: number[] = votes.map((count: number): number => (count * 100) % total);
  let missing: number = 100 - shares.reduce((sum: number, share: number): number => sum + share, 0);
  const order: number[] = votes
    .map((_: number, index: number): number => index)
    .sort((a: number, b: number): number => remainders[b] - remainders[a] || a - b);
  for (const index of order) {
    if (missing === 0) break;
    shares[index] += 1;
    missing -= 1;
  }
  return shares;
}
