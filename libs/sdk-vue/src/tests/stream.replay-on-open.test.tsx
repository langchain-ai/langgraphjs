import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { ChatSessionHarness } from "./components/ChatSessionHarness.js";
import {
  QUICK_REPLY,
  SLOW_MARKER,
  SLOW_REPLY,
} from "./fixtures/streaming-constants.js";
import { apiUrl } from "./test-utils.js";

/**
 * Every new event stream replays the thread's retained events, on LangGraph
 * Platform and on the embedded dev server alike. A freshly opened thread
 * must not apply that history on top of the state it just loaded, and a
 * replayed terminal of an earlier run must not end the run a `submit()` just
 * started (langchain-ai/langgraphjs#3024).
 */

type Screen = Awaited<ReturnType<typeof render>>;

const text = (screen: Screen, testId: string) =>
  screen.getByTestId(testId).element().textContent ?? "";

/**
 * Make the dev server's replay look like LangGraph Platform's: earlier runs
 * keep their `synth:<run_id>` lifecycle ids, replayed `values` come without
 * their checkpoint envelope, and the replay arrives spread out over time.
 */
const PLATFORM_REPLAY = {
  methods: [],
  synthesizeRunIds: true,
  stripReplayedCheckpoints: true,
  replayFrameDelayMs: 5,
};

async function sendAndSettle(screen: Screen, button: string, count: number) {
  await screen.getByTestId(button).click();
  await expect
    .poll(() => text(screen, "message-count"), { timeout: 5_000 })
    .toBe(String(count));
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
}

async function reload(screen: Screen, session: number) {
  await screen.getByTestId("reload").click();
  await expect
    .element(screen.getByTestId("session"))
    .toHaveTextContent(String(session));
  await expect
    .element(screen.getByTestId("thread-loading"), { timeout: 5_000 })
    .toHaveTextContent("Ready");
}

it(
  "opens a running thread without rewinding its earlier turns",
  { timeout: 25_000 },
  async () => {
    const screen = await render(ChatSessionHarness, {
      props: {
        apiUrl,
        assistantId: "streaming_text_graph",
        inputs: ["One", "Two", "Three", `${SLOW_MARKER} Four`],
        replay: PLATFORM_REPLAY,
      },
    });

    try {
      await sendAndSettle(screen, "submit-0", 2);
      await sendAndSettle(screen, "submit-1", 4);
      await sendAndSettle(screen, "submit-2", 6);

      await screen.getByTestId("submit-3").click();
      await expect
        .poll(() => text(screen, "transcript"), { timeout: 5_000 })
        .toContain(SLOW_REPLY.slice(0, 9));

      await reload(screen, 1);
      await expect
        .poll(() => text(screen, "transcript"), { timeout: 10_000 })
        .toBe(
          [
            "One",
            QUICK_REPLY,
            "Two",
            QUICK_REPLY,
            "Three",
            QUICK_REPLY,
            `${SLOW_MARKER} Four`,
            SLOW_REPLY,
          ].join(" | ")
        );
      await expect
        .element(screen.getByTestId("loading"), { timeout: 5_000 })
        .toHaveTextContent("Not loading");

      // Every message count the reopened thread showed: it may only grow
      // from what it loaded, never fall back to an earlier turn.
      const counts = text(screen, "count-history")
        .split(",")
        .map(Number)
        .filter((count) => count > 0);
      expect(counts[0]).toBeGreaterThanOrEqual(6);
      expect(counts).toEqual([...counts].sort((a, b) => a - b));
    } finally {
      await screen.unmount();
    }
  }
);

it(
  "keeps a submit sent right after opening a thread loading until its own run ends",
  { timeout: 20_000 },
  async () => {
    const screen = await render(ChatSessionHarness, {
      props: {
        apiUrl,
        assistantId: "streaming_text_graph",
        inputs: ["One", `${SLOW_MARKER} Two`],
        replay: PLATFORM_REPLAY,
      },
    });

    try {
      await sendAndSettle(screen, "submit-0", 2);
      await reload(screen, 1);
      await expect.poll(() => text(screen, "message-count")).toBe("2");

      await screen.getByTestId("submit-1").click();

      // The first time the reopened session stops loading, the slow reply
      // must have finished: an earlier run's replayed completion settles
      // the submit while the new run is still streaming.
      await expect
        .poll(() => text(screen, "settled-with"), { timeout: 10_000 })
        .not.toBe("");
      expect(text(screen, "settled-with")).toBe(SLOW_REPLY);
      expect(text(screen, "completed-count")).toBe("1");
      expect(text(screen, "message-count")).toBe("4");
    } finally {
      await screen.unmount();
    }
  }
);
