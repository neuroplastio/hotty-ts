# hotty-ts

hotty-ts is the TypeScript SDK for [HOTTY](https://github.com/neuroplastio/hotty),
HTML Over The TTY, for Node and Bun. With it, a terminal program shows small
HTML documents, called surfaces, on rectangles of cells, and hears what the
user does in them. It follows the hotty repository's SDK.md: the same two
layers, names and defaults as the other SDKs, and every SDK section of the
conformance vectors.

The package is `@neuroplastio/hotty`. It is not published yet: the first
release will be 0.1.0, once the repository is public.

```ts
import { NoTerminalError, Terminal } from "@neuroplastio/hotty/terminal";

let t: Terminal;
try {
  t = Terminal.open("hello"); // the terminal (/dev/tty), whatever stdout is
} catch (e) {
  if (!(e instanceof NoTerminalError)) throw e;
  console.log("Hello."); // no terminal: a pipe, a cron job
  process.exit(0);
}
try {
  if (await t.detect()) {
    await t.lineStart(); // surfaces are placed at the cursor
    t.print("hello", "<p>Hello, <b>HTML</b> in the terminal.</p>", { cols: 40, rows: 1 });
    await t.fence(); // the host's replies, before the shell reads the terminal
  } else {
    console.log("Hello."); // a terminal that is not a host
  }
} finally {
  t.close();
}
```

Testing it needs no terminal:

```ts
import { Host } from "@neuroplastio/hotty/test";

const h = new Host();
await run(new Terminal({ input: h, output: h, name: "hello", size: () => h }));
h.surface("hello-hello")?.text(); // "Hello, HTML in the terminal."
```

## Entry points

| import | what it is | SDK.md |
| --- | --- | --- |
| `@neuroplastio/hotty` | the wire layer: builders, `encode`, `Decoder`, `Scanner`, `Detector`, `Reply`, `Event`, `Caps`, and keys: `parseKey`, `decodeKeys`, `Keymap`, `TERMINAL_KEYS`. Pure: no I/O, no dependencies | §3 |
| `@neuroplastio/hotty/field` | `Field`, a text field's value and caret edited by SPEC §10.2's actions, for a program that draws its fields in cells | §4.6 |
| `@neuroplastio/hotty/terminal` | `Terminal`, for a program with a terminal: one that prints documents and exits, asks a question, or streams a chart | §4.1 |
| `@neuroplastio/hotty/session` | `Session`, for a UI framework's adapter: modes, layout, relayout, limits, messages | §4.3 |
| `@neuroplastio/hotty/link` | `Link`, what `Terminal` and `Session` stand on: for an environment that reads the terminal itself and hands over what it reads | §4.2 |
| `@neuroplastio/hotty/test` | `Host`, a HOTTY host that runs inside a test. Needs parse5 (an optional peer dependency) | §4.4 |

Only `@neuroplastio/hotty/test` has a dependency. The rest uses the runtime's
own modules (`node:fs`, `node:tty`, `node:zlib`), which Node and Bun both have.

## A framework's adapter

The `Session` never writes a frame, and owns no stream. With each frame, the
program says where its surfaces are, and the adapter writes what `flush`
returns in the same write as the frame's cells:

```ts
const s = new Session({ link: t, onMessage: (m) => program.send(m) }); // ready, event, error, ack, relayout, pong, input
s.detect();

// each frame:
s.layout([{ name: t.surface("chart"), rect: { x: 2, y: 3, w: 40, h: 10 }, doc: () => chartHtml() }]);
s.watch(cells); // the framework's output: erases and scrolls ask for a relayout
write("\x1b[?2026h" + cells + s.flush() + "\x1b[?2026l");

// on the way out:
write(s.close()); // deletes the surfaces it sent, and no one else's
```

Some environments parse their input themselves and hand over complete
sequences. OpenTUI is one: it may keep the DA1 answers for itself, and it
writes between its frames. For those, the `Session` stands on a `Link`
instead of a `Terminal`. The adapter calls `link.osc(seq)` with each OSC,
which returns whether it was HOTTY's, and `link.da1()` with a DA1 answer it
does not keep. Detection then decides on the host's reply alone, and is done
300 ms later. A byte stream goes to `link.bytes(chunk)`.

## Text fields in cells

A program that draws its fields in cells edits them with the keymap it gives
its surfaces' fields, so a field edits the same on a host and off one. It
puts `TERMINAL_KEYS` in the `data-keys` of an element that holds its fields,
and in cells looks each key up in the same keymap:

```ts
import { INSERT, TERMINAL_KEYS, decodeKeys, resolve } from "@neuroplastio/hotty";
import { Field } from "@neuroplastio/hotty/field";

const html = `<form data-keys="${TERMINAL_KEYS}"><input id=name></form>`; // on a host
const keys = resolve(false, TERMINAL_KEYS); // in cells
const f = new Field();
for (const key of decodeKeys(read)) {
  const a = key === undefined ? undefined : keys.lookup(key);
  if (a === INSERT) f.type(key === "Space" ? " " : key!);
  else if (a === "submit") submit(f.value);
  else if (a) f.do(a); // true when the value changed: an input event's worth
  else onKey(key); // not the field's: the program's own keymap has it
}
```

## Examples

Each one shows its HOTTY part in the open, and each is tested against the
test host (`test/examples.test.ts`):

| example | what it shows |
| --- | --- |
| [`hello`](examples/hello.ts) | open, detect, `lineStart`, `print`, `fence`: the smallest program |
| [`progress`](examples/progress.ts) | a bar moved by `setVar` and `setText` in `sync`; three renditions: surface, cells, pipe |
| [`ask`](examples/ask.ts) | a form that takes the keyboard and reports a submit, then a detached summary in its place |
| [`board`](examples/board.ts) | a full-screen program on a `Session` under its own renderer: layout, deltas, relayout, clicks and keys |

```
node examples/hello.ts      # or: bun examples/hello.ts
```

The SDK holds protocol tools only. Markdown, highlighting, charts and
document models are the program's, as SDK.md §1 has it.

## Names and choices

The names are Appendix A's TypeScript column: `placeAt`, `setText`, `delRes`,
`del` (`delete` is a reserved word), `fitRows`, `cellCss`. Options are
objects: `doc(s, html, { detached: true, q: 0 })`, `place(s, { cols, rows,
keepCursor })`.

- **Absence** is `undefined`: a reply's `code`, an event's `fields()`, a
  `Caps` field the host left out.
- **Errors** are exceptions: `HottyError` (from `reply.err()`), and
  `NoAnswerError` when a request or a fence gets no answer in time, which
  carries the replies read so far. `NoTerminalError` when the process has no
  terminal, and `HostError` from the test host.
- **Messages** are discriminated unions on `kind`: the `Scanner`'s segments,
  the link's input, the `Session`'s messages.
- **Escape.** A lone ESC at the end of a read is the Escape key once nothing
  follows it within 25 ms (`ESCAPE_DELAY`, the link's `escapeDelay`), so a
  sequence split between two reads is not taken for a key.
- **zlib** comes from the runtime's `node:zlib`. An environment without it
  gives the codec its own (`setZlib`).
- **Bun** cannot stop a blocking read of a terminal. So on Bun, `Terminal.open`
  reads stdin when stdin is the terminal, and otherwise polls /dev/tty
  without blocking, every 10 ms while it reads. Either way the process exits
  once the terminal is closed.
- **Windows** has no /dev/tty: `Terminal.open` throws `NoTerminalError`. A
  `Terminal` made from streams, the `Session` and the wire layer work
  anywhere.

## Conformance

The vectors are the hotty repository's `conformance/vectors.json`, of
version 0.1, copied to `test/testdata`, and checked against a checkout of
hotty when one is at hand (`HOTTY_DIR`, by default `../../hotty/main`).

- **SDK sections.** `wire`, `build`, `encode`, `decode`, `scan`, `detect`,
  `keys`, `keymap` and `edit` all run, and none is skipped: the runner
  declares every `requires`. Characters are grapheme clusters, from
  `Intl.Segmenter`, which Node and Bun both have (`graphemes`).
- **Host section.** The test host runs the commands, the inspections and
  the keys of the host vectors (`Host.key`, SPEC §10.2). It lays nothing
  out, so the rows it gives `r=auto` are an estimate and are not checked,
  and an event's `area` is not either. The vectors' pointer steps (drags,
  presses, hover), the keys of a vector that has them or that requires
  something (scrolling), and the events that follow from a layout, are not
  run: a vector whose every check is in such steps is reported as skipped.

## Development

The toolchain is in `mise.toml`: Node 26 and Bun.

```
make install   # npm ci
make check     # typecheck, build, the tests on Node and on Bun, the built package on both
make vectors   # copy the vectors from HOTTY_DIR
```

The sources are TypeScript that both runtimes run as they are (erasable
syntax only). `make build` writes the package's JavaScript and types to
`dist`.

## Licence

Apache-2.0.
