// Board is a full-screen program: a column of cards on the alternate
// screen. j and k (or the arrows) choose one, Enter marks it done, a click
// chooses it too, and q quits.
//
// It shows the Session (SDK.md §4.3) under a renderer of its own, as a UI
// framework's adapter puts it under the framework's:
// - each frame, the program says where it wants its surfaces (layout);
// - the frame's cells and what flush returns go out in one write, in
//   synchronized output, so that a placement lands with the cells around it;
// - the Session watches the cells on their way out, and asks for a new
//   layout (relayout) after the screen was erased;
// - its messages (ready, events, keys) drive the program.
// A card's document is made as the card is when it is sent: the first time,
// and again if the host lost it. While the host has it, changing the card
// is a delta (setAttr, setText), not a new document.
// Where the terminal is not a HOTTY host, the cards are drawn in cells.
//
//   node examples/board.ts
//
// A program of its own imports from "@neuroplastio/hotty",
// "@neuroplastio/hotty/session" and "@neuroplastio/hotty/terminal".

import { setAttr, setText } from "../src/index.ts";
import { Session, type SessionMessage, type Want } from "../src/session.ts";
import { NoTerminalError, Terminal } from "../src/terminal.ts";

export interface Env {
  stderr: { write(s: string): unknown };
  open: () => Terminal;
  /** Calls back when the terminal's size changes; returns what stops it. */
  onResize?: (f: () => void) => () => void;
}

const TASKS = ["Write the spec", "Build the SDK", "Ship the demo"];

const card = (title: string, chosen: boolean, done: boolean) => `<style>
  .card { height: 100vh; box-sizing: border-box; padding: 0 1ch; border: 1px solid var(--hotty-ansi-8);
          border-radius: 6px; display: flex; align-items: center; gap: 1ch; font: 14px system-ui, sans-serif; }
  .chosen { border-color: var(--hotty-ansi-4); }
  #state { margin-left: auto; color: var(--hotty-ansi-8); }
</style>
<div id="card" class="${chosen ? "card chosen" : "card"}" data-on="click"><b>${title}</b><span id="state">${done ? "done" : "to do"}</span></div>`;

export async function run(env: Env): Promise<number> {
  let t: Terminal;
  try {
    t = env.open();
  } catch (e) {
    if (!(e instanceof NoTerminalError)) throw e;
    env.stderr.write("board: no terminal\n");
    return 2;
  }
  const restore = t.raw();
  const names = TASKS.map((_, i) => t.surface(`card-${i}`));
  const done = TASKS.map(() => false);
  let chosen = 0;
  let quit: () => void = () => {};
  const finished = new Promise<void>((r) => (quit = r));
  let clear = true; // the next frame repaints the whole screen

  // The program's renderer: the cells of a frame, then the Session's
  // commands, in one write.
  const frame = () => {
    const { cols, rows } = t.size;
    let cells = clear ? "\x1b[2J" : "";
    clear = false;
    cells += "\x1b[1;1H\x1b[1mBoard\x1b[m  j/k choose, Enter done, q quit\x1b[K";
    const w = Math.min(60, cols - 4);
    const wants: Want[] = names.map((name, i) => ({ name, rect: { x: 2, y: 2 + i * 4, w, h: 3 }, keep: true, doc: () => card(TASKS[i]!, i === chosen, done[i]!) }));
    if (s.mode === "text") {
      TASKS.forEach((title, i) => {
        const mark = i === chosen ? ">" : " ";
        cells += `\x1b[${4 + i * 4};3H${mark} [${done[i] ? "x" : " "}] ${title}\x1b[K`;
      });
    }
    cells += `\x1b[${rows};1H${s.mode === "native" ? "HOTTY host: the cards are surfaces" : "not a HOTTY host: the cards are text"}\x1b[K`;
    s.layout(wants);
    s.watch(cells);
    t.send("\x1b[?2026h" + cells + s.flush() + "\x1b[?2026l");
  };

  // A delta, to a card whose document the host has.
  const change = (i: number, command: (name: string) => string) => {
    if (s.has(names[i]!)) s.send(command(names[i]!));
  };

  const choose = (i: number) => {
    change(chosen, (n) => setAttr(n, "card", "class", "card"));
    change(i, (n) => setAttr(n, "card", "class", "card chosen"));
    chosen = i;
    frame();
  };

  const key = (k: string) => {
    if (k === "q" || k === "\x03") quit();
    else if (k === "j" || k === "\x1b[B") choose((chosen + 1) % TASKS.length);
    else if (k === "k" || k === "\x1b[A") choose((chosen + TASKS.length - 1) % TASKS.length);
    else if (k === "\r") {
      done[chosen] = !done[chosen];
      change(chosen, (n) => setText(n, "state", done[chosen] ? "done" : "to do"));
      frame();
    }
  };

  const onMessage = (m: SessionMessage) => {
    switch (m.kind) {
      case "ready":
      case "relayout":
        frame();
        break;
      case "event":
        if (m.event.kind === "click" && names.includes(m.event.surface)) choose(names.indexOf(m.event.surface));
        break;
      case "input":
        // Keys as the terminal sent them; a key library decodes them in a
        // real program.
        for (const k of new TextDecoder().decode(m.data).match(/\x1b\[[A-D]|[^]/g) ?? []) key(k);
        break;
      case "error":
        env.stderr.write(`board: ${m.reply.err()!.message}\n`);
        break;
    }
  };

  const s = new Session({ link: t, onMessage });
  const stopResize = env.onResize?.(() => {
    clear = true;
    frame();
  });
  t.send("\x1b[?1049h\x1b[?25l"); // the alternate screen, no cursor
  s.detect();
  await finished;
  stopResize?.();
  // Delete the surfaces before leaving the alternate screen, and read the
  // host's replies before the shell does.
  t.send(s.close() + "\x1b[?25h\x1b[?1049l");
  await t.fence().catch(() => []);
  restore();
  t.close();
  return 0;
}

if (import.meta.main) {
  process.exitCode = await run({
    stderr: process.stderr,
    open: () => Terminal.open("board"),
    onResize: (f) => {
      process.on("SIGWINCH", f);
      return () => process.off("SIGWINCH", f);
    },
  });
}
