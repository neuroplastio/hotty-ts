# For agents

hotty-ts is the TypeScript SDK for hotty, published as `@neuroplastio/hotty`.
The protocol is `SPEC.md` and what an SDK owes is `SDK.md`, both in
neuroplastio/hotty. This repository implements them and must not grow them.

- **`make check` is the gate**: typecheck, build, the tests on Node and on
  Bun, and the built package imported on both. It finds hotty through
  `HOTTY_DIR`, or a checkout at `../../hotty/main`. Run tools through mise
  (`mise x -- …`). Push to main fast-forward only, gate first.
- **The vectors are the contract.** `test/testdata/vectors.json` is a copy,
  refreshed with `make vectors`, and a test fails when it falls behind the
  spec's. If the vectors and this SDK disagree, fix the SDK, or propose a
  change to the spec in the hotty repository. Don't quietly choose here.
- **The wire layer is pure** (`src/index.ts` and what it exports): no I/O,
  no timers, no runtime dependencies. Time is passed in.
- **Protocol tools only** (SDK.md §1). Markdown, highlighting, charts and
  document models are the program's, in examples if anywhere.
- **Both runtimes, one source.** The sources are TypeScript that Node runs by
  stripping types and Bun runs as it is: erasable syntax only, relative
  imports with `.ts`. Tests import `test/harness.ts`, not `node:test` or
  `bun:test`.
- **Build against native hosts first**: hottyterm, xterm-addon-hotty, plx,
  and the test host. The kitty graphics polyfill is secondary, and the
  `Terminal` and `Session` are not shaped around it. Reason about placement
  lifetime from SPEC §5.4 and SDK.md §4.3, not from any host's internals.
- **Publish only on the maintainer's go-ahead** (gov P-5 rule 5), and only
  through `.github/workflows/publish.yml`: its version is the spec's
  MAJOR.MINOR and a PATCH of its own (P-5 rule 6). The repository is
  public (the maintainer, 2026-10-18).
