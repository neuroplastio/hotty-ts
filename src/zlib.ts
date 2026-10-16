// zlib (RFC 1950), which the wire layer needs only to compress what a
// program sends (SDK.md §3.3) and to read what a relay passes on: hosts never
// compress (SPEC §3.3). It is the runtime's own, node:zlib, found without an
// import so that the wire layer loads where there is none (a page); there
// it neither compresses nor inflates, unless the program gives it one
// (setZlib).

/**
 * A zlib codec: deflate and inflate, synchronously. inflate throws on bad
 * data, and on data that inflates to more than max bytes when a max is given.
 */
export interface Zlib {
  deflate(data: Uint8Array): Uint8Array;
  inflate(data: Uint8Array, max?: number): Uint8Array;
}

interface NodeZlib {
  deflateSync(data: Uint8Array, options: { level: number }): Uint8Array;
  inflateSync(data: Uint8Array, options?: { maxOutputLength?: number }): Uint8Array;
}

const plain = (b: Uint8Array) => (b.constructor === Uint8Array ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

function runtime(): Zlib | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  let z: NodeZlib | undefined;
  try {
    z = proc?.getBuiltinModule?.("node:zlib") as NodeZlib | undefined;
  } catch {
    z = undefined;
  }
  if (!z) return null;
  const node = z;
  return {
    // zlib's default level, 6, as hotty-go compresses (SDK.md §3.3).
    deflate: (data) => plain(node.deflateSync(data, { level: 6 })),
    inflate: (data, max) => plain(node.inflateSync(data, max === undefined ? {} : { maxOutputLength: max })),
  };
}

let current: Zlib | null | undefined;

/** The zlib the wire layer uses, or null when it has none. */
export function getZlib(): Zlib | null {
  if (current === undefined) current = runtime();
  return current;
}

/**
 * Sets the zlib the wire layer uses: an environment without node:zlib
 * brings its own, and null turns compression and inflating off.
 */
export function setZlib(z: Zlib | null): void {
  current = z;
}
