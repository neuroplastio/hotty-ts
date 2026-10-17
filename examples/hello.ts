// Hello prints a line of HTML in the terminal, and a line of text where the
// terminal cannot show HTML.
//
// It is the smallest hotty program: open the terminal, ask whether it is a
// host, print a document at the cursor, and read the host's replies before
// exiting, so that none is left for the shell.
//
//   node examples/hello.ts
//
// A program of its own imports from "@neuroplastio/hotty/terminal".

import { NoAnswerError, NoTerminalError, Terminal } from "../src/terminal.ts";

/** The process's streams, and its terminal: main has the OS's, a test the test host's. */
export interface Env {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  open: () => Terminal;
}

export async function run(env: Env): Promise<number> {
  let t: Terminal;
  try {
    t = env.open();
  } catch (e) {
    if (!(e instanceof NoTerminalError)) throw e;
    env.stdout.write("Hello.\n"); // no terminal at all: a pipe, a cron job
    return 0;
  }
  try {
    if (!(await t.detect())) {
      env.stdout.write("Hello. (This terminal is not a hotty host, so this is text.)\n");
      return 0;
    }
    // Surfaces are placed at the cursor: start on a line of their own.
    await t.lineStart();
    // The host's stylesheet gives every document the terminal's colours and
    // font (SPEC §8). print sends the document detached: nothing in it
    // reports, so nothing is left for the shell to read.
    t.print("hello", `<p style="margin: 0">Hello, <b style="color: var(--hotty-ansi-5)">HTML</b> in the terminal.</p>`, { cols: 40, rows: 1 });
    // The host replies to a command it refuses: the first reply is the
    // cause (EQUOTA: no room for another surface), the rest follow from it.
    const refused = (await t.fence()).find((r) => !r.ok);
    if (refused) {
      env.stderr.write(`hello: ${refused.err()!.message}\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (!(e instanceof NoAnswerError)) throw e;
    env.stderr.write(`hello: ${e.message}\n`);
    return 1;
  } finally {
    t.close();
  }
}

if (import.meta.main) {
  process.exitCode = await run({ stdout: process.stdout, stderr: process.stderr, open: () => Terminal.open("hello") });
}
