import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import {
  OnRequestComponent,
  onRequestCalls,
  resetOnRequestCalls,
} from "./components/OnRequest.js";

it("routes client-backed requests through onRequest", async () => {
  resetOnRequestCalls();

  const screen = await render(OnRequestComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-1"), { timeout: 15_000 })
    .toHaveTextContent("Hey");

  expect(onRequestCalls.length).toBeGreaterThan(0);
  expect(onRequestCalls.some(([url]) => /\/threads\/[^/]+\/state\b/.test(url)))
    .toBe(true);
});
