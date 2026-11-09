import { describe, expect, it } from "vitest";
import { largestRemainder } from "../app/lib/percent";

const sum = (values: number[]): number => values.reduce((total: number, value: number): number => total + value, 0);

describe("largestRemainder", () => {
  it("gives 0% to every option when nobody has voted", () => {
    expect(largestRemainder([0, 0, 0])).toEqual([0, 0, 0]);
    expect(largestRemainder([])).toEqual([]);
  });

  it("keeps exact shares unchanged", () => {
    expect(largestRemainder([1, 1, 2])).toEqual([25, 25, 50]);
    expect(largestRemainder([5])).toEqual([100]);
    expect(largestRemainder([3, 0])).toEqual([100, 0]);
  });

  it("gives remainder ties to the first-listed option", () => {
    expect(largestRemainder([1, 1, 1])).toEqual([34, 33, 33]);
    expect(largestRemainder([1, 1, 1, 1, 1, 1])).toEqual([17, 17, 17, 17, 16, 16]);
    expect(largestRemainder([1, 1, 1, 0])).toEqual([34, 33, 33, 0]);
    expect(largestRemainder([2, 1, 1, 2])).toEqual([33, 17, 17, 33]);
  });

  it("gives the missing points to the largest remainders first", () => {
    // 0.7 -> 0 and 32.7 -> 32 (remainder .7) beat 66.6 -> 66 (remainder .6).
    expect(largestRemainder([7, 666, 327])).toEqual([1, 66, 33]);
    // 28.57, 42.86, 28.57: the .86 wins first, then the first of the tied .57s.
    expect(largestRemainder([2, 3, 2])).toEqual([29, 43, 28]);
  });

  it("always totals exactly 100 when anyone has voted", () => {
    for (let a = 0; a < 12; a += 1)
      for (let b = 0; b < 12; b += 1)
        for (let c = 0; c < 12; c += 1) {
          const counts: number[] = [a, b, c, (a * b + c) % 7];
          const shares: number[] = largestRemainder(counts);
          expect(sum(shares)).toBe(sum(counts) === 0 ? 0 : 100);
          shares.forEach((share: number, index: number) => {
            const exact: number = sum(counts) === 0 ? 0 : (counts[index] * 100) / sum(counts);
            expect(Math.abs(share - exact)).toBeLessThan(1);
          });
        }
  });

  it("treats negative, fractional and invalid counts safely", () => {
    expect(largestRemainder([-3, 2, Number.NaN, 2.9])).toEqual([0, 50, 0, 50]);
    expect(largestRemainder([Number.POSITIVE_INFINITY, 1])).toEqual([0, 100]);
  });
});
