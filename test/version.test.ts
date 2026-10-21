// The package's version and the hotty version it speaks (gov P-5 rule 6):
// an SDK's MAJOR.MINOR is the spec's, and its PATCH its own. hotty 0.4 is
// @neuroplastio/hotty 0.4.x. The vectors are VERSION's (vectors.test.ts).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as hotty from "../src/index.ts";
import { test } from "./harness.ts";

test("the package's MAJOR.MINOR is the hotty version it speaks", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-next\.\d+)?$/);
  assert.equal(pkg.version.split(".").slice(0, 2).join("."), hotty.VERSION);
});
