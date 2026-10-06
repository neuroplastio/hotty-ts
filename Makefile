# hotty-ts. Toolchain from mise.toml (Node and Bun): `mise install`, then
# `make install` for the dev dependencies.
NODE      ?= mise x -- node
BUN       ?= mise x -- bun
NPM       ?= mise x -- npm
TSC       ?= $(NPM) exec -- tsc
HOTTY_DIR ?= ../../hotty/main
export HOTTY_DIR

.PHONY: check install typecheck build test test-node test-bun package vectors clean

check: typecheck build test package   ## the gate

install:   ## the dev dependencies, as package-lock.json has them
	$(NPM) ci

typecheck:   ## the sources, the tests and the examples
	$(TSC) --noEmit -p .

build:   ## dist: the JavaScript and its declarations, as the package ships them
	rm -rf dist
	$(TSC) -p tsconfig.build.json

test: test-node test-bun   ## the tests, the vectors among them, on both runtimes

test-node:
	$(NODE) --test 'test/**/*.test.ts'

test-bun:
	$(BUN) test ./test

package: build   ## the built package, imported by its name, on both runtimes
	$(NODE) test/package/smoke.mjs
	$(BUN) test/package/smoke.mjs

vectors:   ## the conformance vectors, from a checkout of neuroplastio/hotty (HOTTY_DIR)
	cp $(HOTTY_DIR)/conformance/vectors.json test/testdata/vectors.json

clean:
	rm -rf dist
