import { describe, expect, it } from "vitest";
import { MAX_PENDING_MESSAGES, MessageGate } from "../app/server/message-gate";

describe("the message gate of a live room", (): void => {
  it("admits ten messages a second for each account and refills over time", (): void => {
    const gate = new MessageGate();
    const admitted = Array.from({ length: 12 }, (): boolean => gate.admit("ana", 0));
    expect(admitted.filter(Boolean)).toHaveLength(10);
    expect(gate.admit("ben", 0)).toBe(true);
    expect(gate.admit("ana", 99)).toBe(false);
    expect(gate.admit("ana", 100)).toBe(true);
  });

  it("holds the room to its pending messages", (): void => {
    const gate = new MessageGate();
    for (let index = 0; index < MAX_PENDING_MESSAGES; index += 1) expect(gate.enter()).toBe(true);
    expect(gate.enter()).toBe(false);
    gate.leave();
    expect(gate.enter()).toBe(true);
  });

  it("forgets the full budgets of accounts without a socket and keeps the others", (): void => {
    const gate = new MessageGate();
    for (const user of ["gone", "here", "partial"]) gate.admit(user, 0);
    gate.prune(new Set(["here"]), 999);
    expect(gate.accounts).toBe(3);
    gate.admit("partial", 900);
    gate.prune(new Set(["here"]), 1_000);
    // "gone" is full again and has no socket; "here" is connected; "partial" spent its budget 100 ms ago.
    expect(gate.accounts).toBe(2);
    for (let index = 0; index < 9; index += 1) gate.admit("partial", 950);
    expect(gate.admit("partial", 950)).toBe(false);
  });
});
