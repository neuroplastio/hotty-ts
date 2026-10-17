// Progress shows a task's progress as a bar that moves in place, and leaves
// its last state in the scrollback.
//
// It shows the cheap way to change a surface many times a second: one delta
// whose ops move the bar (a custom property) and change the labels (text),
// a few dozen bytes each, which the host shows together (SPEC §6.1). Where the terminal is not a hotty
// host, the line is redrawn with a carriage return; into a pipe, a line per
// step.
//
//   node examples/progress.ts --files 40 --delay 50
//
// A program of its own imports from "@neuroplastio/hotty" and
// "@neuroplastio/hotty/terminal".

import { parseArgs } from "node:util";

import { attr, delta, text, varOp } from "../src/index.ts";
import { NoTerminalError, Terminal } from "../src/terminal.ts";

export interface Env {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  /** Whether stdout is the terminal. */
  tty: boolean;
  open: () => Terminal;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

// How a rendition shows the work: each step, then the end.
interface View {
  step(done: number, total: number, name: string): void;
  end(done: number, total: number, took: number): Promise<void> | void;
}

const PAGE = `<style>
  .row   { display: flex; align-items: center; gap: 12px; height: 100vh; font: 13px system-ui, sans-serif; }
  .track { flex: 1; height: 8px; border-radius: 4px; background: var(--hotty-ansi-8); overflow: hidden; }
  .fill  { width: calc(var(--p, 0) * 1%); height: 100%; border-radius: 4px; background: var(--hotty-ansi-4); }
  .done .fill { background: var(--hotty-ansi-2); }
  #pct   { width: 4ch; text-align: right; font-variant-numeric: tabular-nums; }
  #label { width: 24ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
<div class="row" id="row"><span id="label">starting</span><div class="track"><div class="fill" id="fill"></div></div><span id="pct">0%</span></div>`;

// The surface: printed once, then changed by deltas.
async function bar(t: Terminal): Promise<View> {
  await t.lineStart();
  // Detached from the start: the program reads nothing from it, and it
  // stays in the scrollback after the program exits (SPEC §5.5).
  const s = t.print("bar", PAGE, { cols: Math.min(72, t.size.cols), rows: 1 });
  return {
    step(done, total, name) {
      const pct = Math.floor((done * 100) / total);
      t.send(delta(s, [varOp("fill", "p", pct), text("label", name), text("pct", `${pct}%`)]));
    },
    async end(_done, total, took) {
      t.send(delta(s, [text("label", `${total} files in ${took} ms`), attr("row", "class", "row done")]));
      // Read the host's replies before the shell does.
      await t.fence().catch(() => []);
    },
  };
}

// The line redrawn in place.
const cells = (out: Env["stdout"]): View => ({
  step(done, total, name) {
    const n = Math.floor((done * 30) / total);
    const pct = String(Math.floor((done * 100) / total)).padStart(3);
    out.write(`\r\x1b[K[${"#".repeat(n)}${".".repeat(30 - n)}] ${pct}% ${name}`);
  },
  end(_done, total, took) {
    out.write(`\r\x1b[K✓ ${total} files in ${took} ms\n`);
  },
});

// A line a step, for a pipe.
const lines = (out: Env["stdout"]): View => ({
  step: (_d, _t, name) => void out.write(name + "\n"),
  end: () => {},
});

export async function run(args: string[], env: Env): Promise<number> {
  let opts: { files: number; delay: number };
  try {
    const { values } = parseArgs({ args, options: { files: { type: "string", default: "20" }, delay: { type: "string", default: "80" } } });
    opts = { files: Number(values.files), delay: Number(values.delay) };
    if (!(opts.files >= 1) || !(opts.delay >= 0)) throw new Error("--files is at least 1, --delay at least 0");
  } catch (e) {
    env.stderr.write(`progress: ${(e as Error).message}\n`);
    return 2;
  }
  let t: Terminal | undefined;
  let view = lines(env.stdout);
  if (env.tty) {
    try {
      t = env.open();
      view = (await t.detect()) ? await bar(t) : cells(env.stdout);
    } catch (e) {
      if (!(e instanceof NoTerminalError)) throw e;
    }
  }
  try {
    const start = env.now();
    for (let i = 1; i <= opts.files; i++) {
      await env.sleep(opts.delay);
      view.step(i, opts.files, `file-${String(i).padStart(2, "0")}.dat`);
    }
    await view.end(opts.files, opts.files, Math.round(env.now() - start));
    return 0;
  } finally {
    t?.close();
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    tty: process.stdout.isTTY === true,
    open: () => Terminal.open("progress"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => performance.now(),
  });
}
