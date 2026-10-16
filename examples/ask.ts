// Ask asks what a deploy needs with a form, and prints the answers as JSON
// for the script that ran it:
//
//   answers=$(node examples/ask.ts) && echo "$answers"
//
// It shows a surface the program reads events from. The form is the
// program's while it asks: it takes the keyboard (a=focus), reports a
// submit, and lets Escape through to the program (SPEC §10). Then a
// detached summary replaces it, so that nothing is left that reports to
// the shell (SPEC §5.5). Where the terminal is not a HOTTY host, it asks a
// question a line. Either way the questions go to the terminal and only
// the answers to stdout.
//
// A program of its own imports from "@neuroplastio/hotty" and
// "@neuroplastio/hotty/terminal".

import { doc, focus, place } from "../src/index.ts";
import { type Input, NoTerminalError, Terminal } from "../src/terminal.ts";

export interface Env {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  open: () => Terminal;
}

type Answers = Record<string, string>;

const FORM = `<style>
  form { display: flex; gap: 1.5ch; align-items: center; margin: 0; height: 100vh; }
  input:invalid { outline: 1px solid var(--hotty-ansi-1); }
  button, select { cursor: pointer; }
</style>
<form id="deploy">
  <label>Service <input id="service" name="service" placeholder="api" required size="12"></label>
  <label>Environment <select id="env" name="env"><option>staging</option><option>production</option></select></label>
  <button id="go">Deploy</button>
</form>`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const summary = (a: Answers) =>
  `<p style="margin: 0">Deploying <b>${esc(a.service ?? "")}</b> to <b>${esc(a.env ?? "")}</b>.</p>`;

// Escape and Ctrl-C cancel. In raw mode Ctrl-C is a key, not a signal.
const quits = (i: Input) => i.kind === "data" && (i.data.includes(0x1b) || i.data.includes(0x03));

async function askSurface(t: Terminal): Promise<Answers | undefined> {
  await t.lineStart();
  const name = t.surface("form");
  // Sent attached: the form is the program's, and reports to it.
  t.send(doc(name, FORM), place(name, { cols: Math.min(72, t.size.cols), rows: 1 }), focus(name, "service"));
  let answers: Answers | undefined;
  for await (const i of t.events()) {
    if (quits(i)) break;
    if (i.kind !== "message") continue; // other keys: the surface has the keyboard
    const r = i.message.reply();
    if (r && !r.ok) throw r.err()!;
    const ev = i.message.event();
    if (ev?.surface === name && ev.kind === "submit") {
      answers = Object.fromEntries(ev.fields() ?? []); // pairs, in order: this form has a field a name
      break;
    }
  }
  // The same surface, its placement kept, its document replaced, and
  // detached: it reports nothing from now on.
  t.send(doc(name, answers ? summary(answers) : `<p style="margin: 0">Cancelled.</p>`, { detached: true }));
  await t.fence();
  return answers;
}

// A question a line, in the terminal's own line editing.
async function askCells(t: Terminal): Promise<Answers | undefined> {
  const it = t.events();
  let typed = ""; // what came after the last line
  const line = async (prompt: string) => {
    t.send(prompt);
    for (;;) {
      const nl = typed.search(/\r\n?|\n/);
      if (nl >= 0) {
        const s = typed.slice(0, nl).trim();
        typed = typed.slice(nl).replace(/^(\r\n?|\n)/, "");
        return s;
      }
      const r = await it.next();
      if (r.done || quits(r.value)) return undefined;
      if (r.value.kind === "data") typed += new TextDecoder().decode(r.value.data);
    }
  };
  try {
    let service: string | undefined = "";
    while (service === "") service = await line("Service: ");
    if (service === undefined) return undefined;
    const env = await line("Environment (staging, production) [staging]: ");
    if (env === undefined) return undefined;
    return { service, env: env === "" ? "staging" : env };
  } finally {
    await it.return(undefined);
  }
}

export async function run(env: Env): Promise<number> {
  let t: Terminal;
  try {
    t = env.open();
  } catch (e) {
    if (!(e instanceof NoTerminalError)) throw e;
    env.stderr.write("ask: no terminal to ask on\n");
    return 2;
  }
  try {
    let answers: Answers | undefined;
    if (await t.detect()) {
      const restore = t.raw(); // keys as they are typed: Escape at once
      try {
        answers = await askSurface(t);
      } finally {
        restore(); // before printing: raw mode does not return the carriage
      }
    } else {
      answers = await askCells(t);
    }
    if (!answers) return 130;
    env.stdout.write(JSON.stringify(answers) + "\n");
    return 0;
  } catch (e) {
    env.stderr.write(`ask: ${(e as Error).message}\n`);
    return 1;
  } finally {
    t.close();
  }
}

if (import.meta.main) {
  process.exitCode = await run({ stdout: process.stdout, stderr: process.stderr, open: () => Terminal.open("ask") });
}
