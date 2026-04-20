import { afterEach, inject } from "vitest";
import { cleanup } from "vitest-browser-react";

/**
 * Shared vitest setup for every `stream.*.test.tsx` file in this
 * directory. We run the experimental hook against a single shared
 * mock server and rely on chrome's page-level connection pool, which
 * resets between files. To stay under chrome's per-origin HTTP/1.1
 * connection limit *within* a file, every test force-unmounts any
 * residual React roots after it runs so the `StreamController`'s
 * deferred-dispose cleanup fires before the next test starts.
 */
export const apiUrl = inject("protocolV2ServerUrl");

afterEach(async () => {
  await cleanup();
  await new Promise((resolve) => setTimeout(resolve, 50));
});

export function cleanupRender(screen: unknown): void {
  const withUnmount = screen as { unmount?: () => void };
  withUnmount.unmount?.();
  document.body.innerHTML = "";
}
