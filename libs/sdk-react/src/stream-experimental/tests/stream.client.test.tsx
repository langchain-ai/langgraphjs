import { Client } from "@langchain/langgraph-sdk";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { BasicStream } from "./components/BasicStream.js";
import { OnRequestStream } from "./components/OnRequestStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

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
  cleanupRender(seed);

  onRequestCallback.mockClear();

  const screen = await render(
    <OnRequestStream apiUrl={apiUrl} client={client} />,
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
  } finally {
    cleanupRender(screen);
  }
});
