import { expect, inject, it } from "vitest";
import { render } from "vitest-browser-svelte";

import ChatSessionHarness from "./components/ChatSessionHarness.svelte";
import { SLOW_MARKER, SLOW_REPLY } from "./fixtures/streaming-constants.js";

const serverUrl = inject("serverUrl");

/**
 * A server that rejects a thread's protocol WebSocket after accepting it
 * closes it with 4000 + the HTTP status, the only signal a browser gets. A
 * 4xx close (other than 408 and 429) must end the stream with that status
 * instead of reconnecting, and `useStream` must report it through `error`
 * and stop loading (langchain-ai/langgraphjs#3031).
 */

type Screen = Awaited<ReturnType<typeof render>>;

const text = (screen: Screen, testId: string) =>
  screen.getByTestId(testId).element().textContent ?? "";

async function socketOpens(threadId: string): Promise<number> {
  const response = await fetch(`${serverUrl}/test-ws/${threadId}`);
  return ((await response.json()) as { opens: number }).opens;
}

it.each([4403, 4404, 4422])(
  "stops on a %i close mid-run and reports it without reconnecting",
  { timeout: 15_000 },
  async (code) => {
    const screen = await render(ChatSessionHarness, {
      apiUrl: serverUrl,
      assistantId: "streaming_text_graph",
      inputs: [`${SLOW_MARKER} Hello`],
      transport: "websocket",
    });

    try {
      await screen.getByTestId("submit-0").click();
      await expect
        .poll(() => text(screen, "transcript"), { timeout: 5_000 })
        .toContain(SLOW_REPLY.slice(0, 9));
      const threadId = text(screen, "thread-id");
      expect(await socketOpens(threadId)).toBe(1);

      await fetch(`${serverUrl}/test-ws/${threadId}/close/${code}`, {
        method: "POST",
      });

      await expect
        .poll(() => text(screen, "error"), { timeout: 5_000 })
        .toContain(`closed by the server: ${code}`);
      await expect
        .element(screen.getByTestId("loading"))
        .toHaveTextContent("Not loading");

      // Long enough for the first reconnect attempts to have gone out.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(await socketOpens(threadId)).toBe(1);
    } finally {
      await screen.unmount();
    }
  }
);
