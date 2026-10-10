// Whether the terminal is a host (SDK.md §3.8): a state machine with the
// time passed in, in milliseconds.

import { query } from "./commands.ts";
import { VERSION } from "./constants.ts";
import type { Caps, Reply } from "./messages.ts";

/** How long to wait for any answer at all. */
export const DETECT_TIMEOUT = 1500;
/** After a DA1 that arrives before any reply: it may answer an earlier question. */
export const DETECT_AFTER_DA1 = 150;
/** After the reply to the query, for the DA1 behind it. */
export const DETECT_AFTER_REPLY = 300;

/** What detection has found: not yet, a host, or a terminal that is not one. */
export type DetectState = "detecting" | "native" | "text";

/** Options of a {@link Detector}. */
export interface DetectorOptions {
  /** The query's number; 1 by default. */
  n?: number;
  /**
   * Ask for a late answer (SPEC §4): the first reply that answers the query
   * once the state is text, and makes the terminal a host, does, with its
   * capabilities. Still decided and done.
   */
  late?: boolean;
}

/**
 * Decides whether the terminal is a HOTTY host this SDK can use (SPEC §4).
 * A reply to the query makes it one when it is `a=ok` and its capabilities
 * decode and name {@link VERSION}; any other reply to the query, an error
 * (EVERSION or another) or capabilities that do not decode (a 0.1 host's
 * JSON) or name another version, makes it text at once. Every input first
 * lets the time pass: whatever was due at or before `now` happens before
 * the input is taken.
 */
export class Detector {
  /** The query's number. */
  readonly n: number;
  /** Whether the query asks for a late answer. */
  readonly late: boolean;
  state: DetectState = "detecting";
  /** The host's capabilities, when native; undefined otherwise. */
  caps: Caps | undefined;
  /** Whether the state is known: when the reply to the query arrives, if one does. */
  decided = false;
  /** Whether nothing more of the detection will arrive. */
  done = false;
  #timeout: number | undefined;
  #grace: number | undefined;
  #after: number | undefined;

  constructor(options: DetectorOptions = {}) {
    this.n = options.n ?? 1;
    this.late = options.late ?? false;
  }

  /** When to call tick next; undefined before start and once done. */
  get deadline(): number | undefined {
    if (this.done || this.#timeout === undefined) return undefined;
    if (this.state === "detecting") return this.#grace === undefined ? this.#timeout : Math.min(this.#timeout, this.#grace);
    return this.#after;
  }

  /** Starts detection, and returns the query to send, with its DA1 fence. */
  start(now: number): string {
    this.#timeout = now + DETECT_TIMEOUT;
    return query(this.n, { late: this.late });
  }

  #fire(now: number) {
    if (this.done || this.#timeout === undefined) return;
    if (this.state === "detecting") {
      if (now >= this.#timeout || (this.#grace !== undefined && now >= this.#grace)) {
        this.state = "text";
        this.decided = this.done = true;
      }
    } else if (this.#after !== undefined && now >= this.#after) {
      this.done = true;
    }
  }

  /** The time is now. */
  tick(now: number): void {
    this.#fire(now);
  }

  /**
   * A DA1 answer arrived. Returns whether it was detection's: every DA1
   * from the start until done is, and the caller swallows it.
   */
  da1(now: number): boolean {
    this.#fire(now);
    if (this.done) return false;
    if (this.state === "detecting") {
      this.#grace ??= now + DETECT_AFTER_DA1;
      return true;
    }
    this.done = true;
    return true;
  }

  /**
   * A reply arrived. Returns whether it answers the query (`re=q`, the
   * query's n, `a=ok` or `a=err`): it is detection's whenever it arrives,
   * and the caller swallows it. The first decides: a host when it is `a=ok`
   * with capabilities that decode and name {@link VERSION}, text otherwise,
   * and done when the DA1 behind it arrives or 300 ms later. A late one
   * changes nothing, unless the query asked for it: then the first that
   * makes the terminal a host does.
   */
  reply(r: Reply, now: number): boolean {
    this.#fire(now);
    if (!(r.re === "q" && r.n === this.n)) return false;
    const caps = r.caps();
    const host = caps !== undefined && caps.v === VERSION;
    if (this.state === "detecting") {
      this.state = host ? "native" : "text";
      this.decided = true;
      this.caps = host ? caps : undefined;
      this.#after = Math.min(now + DETECT_AFTER_REPLY, this.#timeout ?? Infinity);
    } else if (this.state === "text" && this.late && host) {
      this.state = "native";
      this.caps = caps;
    }
    return true;
  }

  /** The input ended, or the caller gave up: text if nothing was decided. */
  end(now: number): void {
    this.#fire(now);
    if (!this.decided) {
      this.state = "text";
      this.decided = true;
    }
    this.done = true;
  }
}
