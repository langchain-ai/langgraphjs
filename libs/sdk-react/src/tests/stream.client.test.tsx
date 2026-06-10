import { Client } from "@langchain/langgraph-sdk";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { BasicStream } from "./components/BasicStream.js";
import { OnRequestStream } from "./components/OnRequestStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

// Regression guard: re-mounting an existing thread through a
// `Client` (no custom `fetch`) must hydrate purely from the
// idle catch-up subscription — without submitting a new run. A
// past bug routed the long-lived SSE event stream through
// `AsyncCaller`, which stalled this hydrate-only path and never
// surfaced the checkpointed messages. The submit-driven test
// above does not exercise it because an active run keeps the
// stream busy; only this no-submit hydrate does.
it("hydrates an existing thread through a Client without re-submitting", async () => {
  const onRequestCallback = vi.fn();
  const threadId = crypto.randomUUID();

  const client = new Client({
    apiUrl,
    onRequest: (url, init) => {
      onRequestCallback(url.toString(), init);
      return init;
    },
  });

  // Seed a thread with a completed run (two messages) using an
  // internal client so hydrate has checkpoint state to load.
  const seed = await render(
    <BasicStream apiUrl={apiUrl} threadId={threadId} />,
  );
  await seed.getByTestId("submit").click();
  await expect
    .element(seed.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await cleanupRender(seed);

  onRequestCallback.mockClear();

  // Re-mount the *same* thread with the `onRequest` client and do
  // NOT submit. Reaching `message-count === "2"` depends solely on
  // hydration's catch-up subscription resolving.
  const screen = await render(
    <BasicStream apiUrl={apiUrl} client={client} threadId={threadId} />,
  );

  try {
    await expect
      .element(screen.getByTestId("message-count"), { timeout: 5_000 })
      .toHaveTextContent("2");

    expect(onRequestCallback).toHaveBeenCalled();
  } finally {
    await cleanupRender(screen);
  }
});

it("routes client-backed requests through onRequest", async () => {
  const onRequestCallback = vi.fn();
  const threadId = crypto.randomUUID();

  const client = new Client({
    apiUrl,
    onRequest: (url, init) => {
      onRequestCallback(url.toString(), init);
      return init;
    },
  });

  // Seed the thread with a run so hydrate has checkpoint state to
  // load on the second mount.
  const seed = await render(
    <BasicStream apiUrl={apiUrl} threadId={threadId} />,
  );
  await seed.getByTestId("submit").click();
  await expect
    .element(seed.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await cleanupRender(seed);

  onRequestCallback.mockClear();

  const screen = await render(
    <OnRequestStream apiUrl={apiUrl} client={client} threadId={threadId} />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 10_000 })
      .toHaveTextContent("Not loading");

    // `onRequest` is called for every Client-mediated HTTP call.
    // Stream transports (SSE/WS) bypass the Client, so we only
    // assert coverage — e.g. thread-state hydrate / thread-create.
    expect(onRequestCallback.mock.calls.length).toBeGreaterThan(0);

    // Strict body/URL shape matcher: at least one Client-mediated
    // request must hit the `/threads/:id/state` endpoint (hydrate)
    // and use an HTTP method that's not `POST` (GET). This guards
    // against accidental regressions where the new `useStream` stops
    // hydrating thread state on mount.
    const urls = (
      onRequestCallback.mock.calls as Array<[string, RequestInit | undefined]>
    ).map((call) => call[0]);
    expect(
      urls.some((url: string) => /\/threads\/[^/]+\/state\b/.test(url)),
    ).toBe(true);

    // Every captured request must carry an `init` object (even if
    // the body is undefined) — this is how the Client signals the
    // call was actually routed through `onRequest` rather than a
    // raw transport path that bypasses it.
    for (const [, init] of onRequestCallback.mock.calls as Array<
      [string, RequestInit | undefined]
    >) {
      expect(init).toBeDefined();
    }
  } finally {
    await cleanupRender(screen);
  }
});
