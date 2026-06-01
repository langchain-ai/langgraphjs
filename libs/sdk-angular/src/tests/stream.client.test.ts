import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import {
  OnRequestComponent,
  onRequestCalls,
  resetOnRequestCalls,
} from "./components/OnRequest.js";

let hydratedThreadId: string | undefined;

it("seeds a thread for the onRequest hydrate assertion", async () => {
  hydratedThreadId = crypto.randomUUID();
  const screen = await render(OnRequestComponent, {
    inputs: { threadId: hydratedThreadId },
  });
  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");
});

it("routes client-backed requests through onRequest", async () => {
  expect(hydratedThreadId).toMatch(/.+/);
  resetOnRequestCalls();

  const screen = await render(OnRequestComponent, {
    inputs: { threadId: hydratedThreadId! },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");

  expect(onRequestCalls.length).toBeGreaterThan(0);
  expect(onRequestCalls.some(([url]) => /\/threads\/[^/]+\/state\b/.test(url)))
    .toBe(true);
});
