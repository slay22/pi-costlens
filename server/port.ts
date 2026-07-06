/**
 * Port utilities for the Costlens dashboard.
 *
 * `findFreePort` returns the first port in 7331..7399 that isn't bound.
 * Used by the extension before spawning the server, and by the server
 * as a fallback if COSTLENS_PORT isn't set.
 *
 * Uses `node:net` (no shell-out to `lsof`) so it works the same on
 * macOS, Linux, and Windows.
 */

import { createServer } from "node:net";

export const PORT_RANGE_START = 7331;
export const PORT_RANGE_END = 7399;
export const DEFAULT_PORT = PORT_RANGE_START;

function isFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    server.once("error", () => finish(false));
    server.once("listening", () => {
      // Port is free; close and report. close()'s callback is the
      // canonical "fully closed" signal, but we resolve as soon as we
      // know the port is bound to us.
      server.close(() => finish(true));
    });
    try {
      server.listen(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * Find the first free port in the Costlens range, starting at `start`.
 * Returns `null` if every port in the range is taken.
 *
 * `start` is clamped to the range: values below PORT_RANGE_START
 * start at PORT_RANGE_START; values above PORT_RANGE_END return null
 * immediately.
 */
export async function findFreePort(start: number = DEFAULT_PORT): Promise<number | null> {
  if (start > PORT_RANGE_END) return null;
  const from = Math.max(PORT_RANGE_START, start);
  for (let p = from; p <= PORT_RANGE_END; p++) {
    if (await isFree(p)) return p;
  }
  return null;
}
