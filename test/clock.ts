// A clock a test moves by hand, and a way to let what is pending run.

import type { Clock } from "../src/link.ts";

/** Lets every promise and I/O callback that is ready run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** A Clock whose time moves only when the test says. */
export class FakeClock implements Clock {
  t = 0;
  #timers: { at: number; fn: () => void; id: number }[] = [];
  #id = 0;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#id;
    this.#timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers = this.#timers.filter((x) => x.id !== handle);
  }

  /** Moves the time on by ms, running each timer when its time comes, and what it sets off. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await settle();
    for (;;) {
      const due = this.#timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }

  /** How many timers are set. */
  get pending(): number {
    return this.#timers.length;
  }
}
