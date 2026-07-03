import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import {
  HttpAgentServerAdapter,
  type AgentServerAdapter,
} from "@langchain/langgraph-sdk";

import { ReattachStream } from "./components/ReattachStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

type ActiveRunAdapter = AgentServerAdapter & {
  apiUrl: string;
  hasActiveRun?: () => Promise<boolean>;
};

function createIdleHydrateAdapter(
  baseUrl: string,
  threadId: string,
  hits?: { getState: number },
  fetch?: typeof globalThis.fetch,
): ActiveRunAdapter {
  const delegate = new HttpAgentServerAdapter({
    apiUrl: baseUrl,
    threadId,
    fetch,
  }) as ActiveRunAdapter;
  return {
    apiUrl: baseUrl,
    get threadId() {
      return delegate.threadId;
    },
    setThreadId(nextThreadId) {
      delegate.setThreadId?.(nextThreadId);
    },
    getState: async <StateType,>() => {
      if (hits != null) hits.getState += 1;
      return {
        values: { messages: [] } as StateType,
        next: [],
        tasks: [],
        checkpoint: null,
        parent_checkpoint: null,
        metadata: { step: 0 },
      };
    },
    open: () => delegate.open(),
    send: (command) => delegate.send(command),
    events: () => delegate.events(),
    openEventStream: (params) => {
      const handle = delegate.openEventStream?.(params);
      if (handle == null) {
        throw new Error("Expected test delegate to support event streams.");
      }
      return handle;
    },
    hasActiveRun: () => delegate.hasActiveRun?.() ?? Promise.resolve(false),
    close: () => delegate.close(),
  };
}

function createActiveRunFetch(baseUrl: string, threadId: string): {
  fetch: typeof fetch;
  hits: { count: number };
} {
  const hits = { count: 0 };
  const wrappedFetch: typeof fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(
      rawUrl,
      rawUrl.startsWith("/") ? baseUrl : undefined,
    );
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "GET" && url.pathname === `/threads/${threadId}/runs`) {
      hits.count += 1;
      return new Response(
        JSON.stringify([{ run_id: "active-run", status: "running" }]),
        { headers: { "content-type": "application/json" } },
      );
    }
    return globalThis.fetch(input, init);
  };
  return {
    fetch: wrappedFetch,
    hits,
  };
}

/**
 * R2.7 re-attach harness automation. Boots a slow graph (see
 * `fixtures/slow-graph.ts`) and mounts a second `useStream`
 * hook on the same `threadId` mid-run, asserting that the second hook
 * observes the in-flight run via `isLoading: true` and ends up with
 * the same terminal state as the primary hook.
 */
it("secondary hook attaches to an in-flight run on the same thread", async () => {
  const screen = await render(<ReattachStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("primary-submit").click();

    await expect
      .element(screen.getByTestId("primary-loading"))
      .toHaveTextContent("Loading...");

    await expect
      .poll(() =>
        screen.getByTestId("primary-thread-id").element().textContent?.trim()
      )
      .not.toBe("none");

    await screen.getByTestId("secondary-mount").click();

    await expect
      .element(screen.getByTestId("secondary-mounted"))
      .toHaveTextContent("yes");

    // Re-attach acceptance: the secondary hook should pick up the
    // in-flight run's lifecycle through the shared subscription (the
    // persistent root lifecycle listener registered in S1.1).
    await expect
      .element(screen.getByTestId("secondary-loading"))
      .toHaveTextContent("Loading...");

    // Both hooks terminate on the same thread's final state.
    await expect
      .element(screen.getByTestId("primary-loading"))
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("secondary-loading"))
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("primary-message-count"))
      .toHaveTextContent("2");

    await expect
      .element(screen.getByTestId("secondary-message-count"))
      .toHaveTextContent("2");

    await screen.getByTestId("secondary-unmount").click();
    await expect
      .element(screen.getByTestId("secondary-mounted"))
      .toHaveTextContent("no");

    await screen.getByTestId("primary-submit").click();
    await screen.getByTestId("secondary-mount").click();
    await expect
      .element(screen.getByTestId("secondary-mounted"))
      .toHaveTextContent("yes");
    await expect
      .element(screen.getByTestId("primary-loading"))
      .toHaveTextContent("Loading...");

    await expect
      .element(screen.getByTestId("primary-loading"))
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("secondary-loading"))
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("primary-message-count"))
      .toHaveTextContent("4");
    await expect
      .element(screen.getByTestId("secondary-message-count"))
      .toHaveTextContent("4");
  } finally {
    await cleanupRender(screen);
  }
});

it("reattaches when the hydrated checkpoint looks idle but the run is active", async () => {
  const adapterHits = { getState: 0 };
  let activeRunFetch: ReturnType<typeof createActiveRunFetch> | undefined;
  const screen = await render(
    <ReattachStream
      apiUrl={apiUrl}
      createSecondaryTransport={(threadId) => {
        activeRunFetch = createActiveRunFetch(apiUrl, threadId);
        return createIdleHydrateAdapter(
          apiUrl,
          threadId,
          adapterHits,
          activeRunFetch.fetch,
        );
      }}
    />,
  );

  try {
    await screen.getByTestId("primary-submit").click();

    await expect
      .element(screen.getByTestId("primary-loading"))
      .toHaveTextContent("Loading...");

    await expect
      .poll(() =>
        screen.getByTestId("primary-thread-id").element().textContent?.trim(),
      )
      .not.toBe("none");
    await expect
      .element(screen.getByTestId("primary-run-created"))
      .toHaveTextContent("yes");
    const threadId = screen
      .getByTestId("primary-thread-id")
      .element()
      .textContent?.trim();
    expect(threadId).toMatch(/.+/);
    expect(activeRunFetch).toBeDefined();

    await screen.getByTestId("secondary-mount").click();

    await expect
      .element(screen.getByTestId("secondary-mounted"))
      .toHaveTextContent("yes");
    await expect.poll(() => adapterHits.getState).toBeGreaterThan(0);
    await expect
      .poll(() => activeRunFetch?.hits.count ?? 0)
      .toBeGreaterThan(0);

    // Regression coverage for a page refresh before the new run writes
    // a state-advancing checkpoint. `getState()` can still return the
    // previous idle checkpoint, but the controller should discover and
    // reattach to the active run instead of rendering an idle UI.
    await expect
      .element(screen.getByTestId("secondary-loading"), { timeout: 1_000 })
      .toHaveTextContent("Loading...");

    await expect
      .element(screen.getByTestId("secondary-loading"))
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("secondary-message-count"))
      .toHaveTextContent("2");
  } finally {
    await cleanupRender(screen);
  }
});
