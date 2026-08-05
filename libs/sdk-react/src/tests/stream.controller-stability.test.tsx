/**
 * Regression: the controller must stay referentially stable across
 * re-renders so it self-hydrates exactly once.
 *
 * The controller self-hydrates in its constructor (`getState` +
 * `getHistory`). It used to live in a `useMemo`, but React does not
 * guarantee `useMemo` identity — it may drop the cache on a re-render,
 * rebuilding the controller and re-firing a *duplicate* hydrate. A real
 * page load reproduced this: a parent re-render (an unrelated
 * health-check resolving) produced a second `getState` + `getHistory`.
 *
 * The fix pins the controller in a `useRef` (recreated only when its
 * identity inputs actually change). This test forces several re-renders
 * during/after hydration and asserts the controller identity is stable
 * and hydration fires only once. It also verifies that changing a controller
 * capability intentionally creates a new controller with the new behavior.
 *
 * Note: in a normal test env `useMemo` would also stay stable, so this
 * guards primarily against future regressions (e.g. an unstable
 * identity dep) rather than failing on the exact production drop.
 */
import { useRef, useState } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BasicStream } from "./components/BasicStream.js";
import { useStream, STREAM_CONTROLLER } from "../index.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

function StabilityProbe({
  apiUrl,
  threadId,
}: {
  apiUrl: string;
  threadId: string;
}) {
  const [, forceRender] = useState(0);
  const [discoverSubgraphsOnHydrate, setDiscoverSubgraphsOnHydrate] =
    useState<boolean | undefined>(false);

  const stream = useStream<{ messages: unknown[] }>({
    assistantId: "stategraph_text",
    apiUrl,
    threadId,
    discoverSubgraphsOnHydrate,
  });

  // Track controller identity across renders.
  const controller = stream[STREAM_CONTROLLER];
  const firstController = useRef(controller);
  const identityChanges = useRef(0);
  if (firstController.current !== controller) {
    identityChanges.current += 1;
    firstController.current = controller;
  }

  return (
    <div>
      <button data-testid="rerender" onClick={() => forceRender((n) => n + 1)}>
        Re-render
      </button>
      <button
        data-testid="toggle-subgraph-discovery"
        onClick={() => setDiscoverSubgraphsOnHydrate((enabled) => !enabled)}
      >
        Toggle subgraph discovery
      </button>
      <button
        data-testid="default-subgraph-discovery"
        onClick={() => setDiscoverSubgraphsOnHydrate(undefined)}
      >
        Default subgraph discovery
      </button>
      <div data-testid="thread-loading">
        {stream.isThreadLoading ? "Hydrating..." : "Ready"}
      </div>
      <div data-testid="identity-changes">{identityChanges.current}</div>
    </div>
  );
}

it("keeps one controller (single hydrate) across re-renders", async () => {
  // Seed a real thread with checkpoint state to hydrate.
  const seedScreen = await render(<BasicStream apiUrl={apiUrl} />);
  await seedScreen.getByTestId("submit").click();
  await expect
    .element(seedScreen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  const threadId = seedScreen
    .getByTestId("thread-id")
    .element()
    .textContent?.trim();
  await cleanupRender(seedScreen);
  expect(threadId).toMatch(/.+/);

  // Count hydrate requests for this thread by wrapping global fetch.
  // `getState` / `getHistory` route through the SDK `Client` (global
  // fetch), not the transport `fetch` option, so we intercept here.
  let stateRequests = 0;
  let historyRequests = 0;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (typeof url === "string" && url.includes(threadId!)) {
      if (url.includes("/history")) historyRequests += 1;
      else if (url.includes("/state")) stateRequests += 1;
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const screen = await render(
    <StabilityProbe apiUrl={apiUrl} threadId={threadId!} />
  );

  try {
    // Wait for the initial hydrate to settle.
    await expect
      .element(screen.getByTestId("thread-loading"), { timeout: 20_000 })
      .toHaveTextContent("Ready");

    // Force several re-renders — the controller must not be rebuilt.
    for (let i = 0; i < 5; i += 1) {
      await screen.getByTestId("rerender").click();
    }
    // Let any (erroneous) re-hydrate fetch land.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(
      Number.parseInt(
        screen.getByTestId("identity-changes").element().textContent || "0",
        10
      )
    ).toBe(0);
    expect(stateRequests).toBe(1);
    expect(historyRequests).toBe(0);

    // Controller capabilities are identity inputs. Enabling subgraph
    // discovery must replace the controller so the next hydrate performs the
    // history read instead of retaining the previous controller's behavior.
    await screen.getByTestId("toggle-subgraph-discovery").click();
    await expect
      .element(screen.getByTestId("identity-changes"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("thread-loading"), { timeout: 20_000 })
      .toHaveTextContent("Ready");
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(stateRequests).toBe(2);
    expect(historyRequests).toBe(1);

    // `undefined` uses the same enabled default as `true`, so this render
    // must retain the current controller and avoid another hydration.
    await screen.getByTestId("default-subgraph-discovery").click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect
      .element(screen.getByTestId("identity-changes"))
      .toHaveTextContent("1");
    expect(stateRequests).toBe(2);
    expect(historyRequests).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupRender(screen);
  }
});
