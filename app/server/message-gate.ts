import type { TokenBucket } from "../lib/mash";

// Tap messages one account may send each second over all its sockets, with a burst of one second. The client sends
// one batch each 200 ms (MASH_BATCH_MS), so this is twice that.
const MESSAGE_RATE = 10;
// Tap messages one room handles at a time.
export const MAX_PENDING_MESSAGES = 64;

// The admission of tap messages in a live room, before any D1 read: a flood can neither queue D1 work in the room
// nor make D1 reads for one account above its budget.
export class MessageGate {
  private readonly buckets = new Map<string, TokenBucket>();
  private pending = 0;

  // A message may start. Each `enter` that returns true needs one `leave`.
  enter(): boolean {
    if (this.pending >= MAX_PENDING_MESSAGES) return false;
    this.pending += 1;
    return true;
  }

  leave(): void {
    this.pending -= 1;
  }

  // Takes one message from the budget of `userId`. False when the account sent too many messages.
  admit(userId: string, now: number): boolean {
    const bucket: TokenBucket | undefined = this.buckets.get(userId);
    const elapsed: number = bucket ? Math.max(0, now - bucket.at) : Number.POSITIVE_INFINITY;
    const tokens: number = Math.min(MESSAGE_RATE, (bucket?.tokens ?? MESSAGE_RATE) + (elapsed * MESSAGE_RATE) / 1_000);
    const admitted: boolean = tokens >= 1;
    this.buckets.set(userId, { tokens: admitted ? tokens - 1 : tokens, at: now });
    return admitted;
  }
}
