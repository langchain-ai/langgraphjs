/**
 * `stateKeys`: the hook loads and exposes only the listed `values` keys
 * (plus the messages key). The mock server is the JS Agent Server, which
 * ignores `select` on `/state` and returns full state, so these tests
 * also cover the client-side narrowing of `stream.values`.
 */
import { useState } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useStream } from "../index.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

interface StatefulState {
  messages: BaseMessage[];
  status: string;
}

function StateKeysProbe({
  threadId,
  stateKeys,
}: {
  threadId?: string;
  stateKeys?: (keyof StatefulState)[];
}) {
  const [renders, setRenders] = useState(0);
  const stream = useStream<StatefulState>({
    assistantId: "stateful_values_graph",
    apiUrl,
    threadId,
    // A new array on every render, as an inline literal would be.
    stateKeys: stateKeys != null ? [...stateKeys] : undefined,
  });

  return (
    <div>
      <div data-testid="renders">{renders}</div>
      <div data-testid="thread-id">{stream.threadId ?? ""}</div>
      <div data-testid="thread-loading">
        {stream.isThreadLoading ? "Hydrating..." : "Ready"}
      </div>
      <div data-testid="loading">
        {stream.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="value-keys">
        {Object.keys(stream.values).sort().join(",")}
      </div>
      <div data-testid="message-count">{stream.messages.length}</div>
      <button
        data-testid="rerender"
        onClick={() => setRenders((n) => n + 1)}
      >
        Re-render
      </button>
      <button
        data-testid="submit"
        onClick={() =>
          void stream.submit({
            messages: [new HumanMessage("Hello")],
            status: "draft",
          })
        }
      >
        Send
      </button>
    </div>
  );
}

async function seedThread(): Promise<string> {
  const screen = await render(<StateKeysProbe />);
  try {
    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("message-count"), { timeout: 5_000 })
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("value-keys"))
      .toHaveTextContent(/^messages,status$/);
    const threadId = screen
      .getByTestId("thread-id")
      .element()
      .textContent?.trim();
    expect(threadId).toMatch(/.+/);
    return threadId!;
  } finally {
    await cleanupRender(screen);
  }
}

it("loads a thread with only the listed keys, once across re-renders", async () => {
  const threadId = await seedThread();

  const stateUrls: URL[] = [];
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    );
    if (url.pathname.endsWith(`/threads/${threadId}/state`)) {
      stateUrls.push(url);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const screen = await render(
    <StateKeysProbe threadId={threadId} stateKeys={[]} />
  );
  try {
    await expect
      .element(screen.getByTestId("thread-loading"), { timeout: 20_000 })
      .toHaveTextContent("Ready");
    await expect
      .element(screen.getByTestId("message-count"))
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("value-keys"))
      .toHaveTextContent(/^messages$/);

    for (let i = 0; i < 3; i += 1) {
      await screen.getByTestId("rerender").click();
    }
    await expect
      .element(screen.getByTestId("renders"))
      .toHaveTextContent("3");
    // Let any (erroneous) re-hydrate fetch land.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(stateUrls).toHaveLength(1);
    const select = stateUrls[0].searchParams.getAll("select");
    expect(select).toContain("values.messages");
    expect(select).toContain("tasks");
    expect(select).not.toContain("values.status");
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupRender(screen);
  }
});

it("keeps unlisted keys out of values while a run streams", async () => {
  const screen = await render(<StateKeysProbe stateKeys={[]} />);
  try {
    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Loading...");
    await expect
      .element(screen.getByTestId("value-keys"))
      .toHaveTextContent(/^messages$/);

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("message-count"))
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("value-keys"))
      .toHaveTextContent(/^messages$/);
  } finally {
    await cleanupRender(screen);
  }
});
