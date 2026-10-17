// Terminal.open on a real terminal: hello, run by this runtime on a pty that
// answers as a host (pty-driver.py), with stdin the terminal or a pipe.
// It needs python3 and Linux; elsewhere the tests are skipped.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { query } from "../src/index.ts";
import { Host } from "../src/test/index.ts";
import { describe, test } from "./harness.ts";

const here = new URL(".", import.meta.url).pathname;
const python = spawnSync("python3", ["-c", ""]).status === 0;
const usable = python && process.platform === "linux";

function hello(mode: "tty" | "pipe") {
  const dir = mkdtempSync(join(tmpdir(), "hotty-pty-"));
  try {
    const h = new Host();
    h.write(query());
    const reply = join(dir, "reply");
    writeFileSync(reply, h.take());
    const r = spawnSync("python3", ["-I", join(here, "pty-driver.py"), mode, reply, process.execPath, join(here, "../examples/hello.ts")], {
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(r.status, 0, r.stderr);
    const { code, out } = JSON.parse(r.stdout) as { code: number; out: string };
    return { code, out: Buffer.from(out, "base64").toString("latin1") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Terminal.open on a pty", () => {
  for (const mode of ["tty", "pipe"] as const) {
    (usable ? test : test.skip)(
      `stdin ${mode === "tty" ? "the terminal" : "a pipe"}: it reads the host's reply through /dev/tty, prints, fences, and exits`,
      () => {
        const { code, out } = hello(mode);
        assert.equal(code, 0, out);
        assert.doesNotMatch(out, /not a hotty host/);
        assert.match(out, /\x1b\]7279;a=doc:s=hello-\d+-hello:d=1[:;]/, "a detached document, named for the process");
        assert.match(out, /\x1b\]7279;a=place:s=hello-\d+-hello:c=40:r=1/);
        assert.match(out, /\x1b\[c$/, "the fence last");
      },
    );
  }
});
