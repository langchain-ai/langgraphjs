import { Client } from "@langchain/langgraph-sdk";
import { expect, inject, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";

import BasicStream from "./components/BasicStream.svelte";
import OnRequest from "./components/OnRequest.svelte";

const serverUrl = inject("serverUrl");

it("routes client-backed requests through onRequest", async () => {
  const onRequestCallback = vi.fn();
  const threadId = crypto.randomUUID();

  const client = new Client({
    apiUrl: serverUrl,
    onRequest: (url, init) => {
      onRequestCallback(url.toString(), init);
      return init;
    },
  });

  const seed = render(BasicStream, {
    apiUrl: serverUrl,
    threadId,
  });
  await seed.getByTestId("submit").click();
  await expect
    .element(seed.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");
  seed.unmount();

  onRequestCallback.mockClear();

  const screen = render(OnRequest, {
    apiUrl: serverUrl,
    client,
    threadId,
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");

  expect(onRequestCallback.mock.calls.length).toBeGreaterThan(0);

  const urls = (
    onRequestCallback.mock.calls as Array<[string, RequestInit | undefined]>
  ).map((call) => call[0]);
  expect(urls.some((url) => /\/threads\/[^/]+\/state\b/.test(url))).toBe(true);

  for (const [, init] of onRequestCallback.mock.calls as Array<
    [string, RequestInit | undefined]
  >) {
    expect(init).toBeDefined();
  }
});
