// The tests run under Node's test runner and Bun's: this is whichever of
// the two is running them. Assertions come from node:assert, which both
// have.

type Fn = () => void | Promise<void>;
interface Test {
  (name: string, fn: Fn): void;
  skip(name: string, fn: Fn): void;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const runner = (isBun ? await import("bun:test") : await import("node:test")) as unknown as {
  test: Test;
  describe: (name: string, fn: () => void) => void;
};

/** One test; test.skip registers one that is skipped. */
export const test: Test = runner.test;
/** A group of tests. */
export const describe = runner.describe;
/** Which runtime runs the tests. */
export const runtime: "bun" | "node" = isBun ? "bun" : "node";
