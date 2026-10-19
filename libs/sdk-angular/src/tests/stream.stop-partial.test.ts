import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { ChatSessionHarnessComponent } from "./components/ChatSessionHarness.js";
import {
  DRAFT_REPLY,
  QUICK_REPLY,
  SLOW_MARKER,
  SLOW_REPLY,
} from "./fixtures/streaming-constants.js";

/**
 * A reply cut off by `stop()` was never checkpointed, so it must not stay on
 * screen: not after the run ends, not below the next turn, not after a
 * reload and not in another view of the thread. A reply that finished
 * streaming before the run paused for input is the exception and stays until
 * the run resumes (langchain-ai/langgraphjs#2962).
 */

type Screen = Awaited<ReturnType<typeof render>>;

const text = (screen: Screen, testId: string) =>
  screen.getByTestId(testId).element().textContent ?? "";

/** The first words of the slow reply, visible once it has started streaming. */
const SLOW_REPLY_START = SLOW_REPLY.slice(0, 9);

const SLOW_INPUT = `${SLOW_MARKER} Hello`;

async function stopMidReply(screen: Screen) {
  await screen.getByTestId("submit-0").click();
  await expect
    .poll(() => text(screen, "transcript"), { timeout: 5_000 })
    .toContain(SLOW_REPLY_START);
  await screen.getByTestId("stop").click();
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
}

it(
  "drops a reply cut off by stop() and keeps it out of the next turn",
  { timeout: 15_000 },
  async () => {
    const screen = await render(ChatSessionHarnessComponent, {
      inputs: {
        assistantId: "streaming_text_graph",
        inputs: [SLOW_INPUT, "Follow-up"],
      },
    });

    await stopMidReply(screen);

    await expect.poll(() => text(screen, "transcript")).toBe(SLOW_INPUT);

    await screen.getByTestId("submit-1").click();
    await expect
      .poll(() => text(screen, "transcript"), { timeout: 5_000 })
      .toBe(`${SLOW_INPUT} | Follow-up | ${QUICK_REPLY}`);
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
    expect(text(screen, "transcript")).toBe(
      `${SLOW_INPUT} | Follow-up | ${QUICK_REPLY}`
    );
  }
);

it(
  "keeps a stopped reply gone across reloads while the conversation goes on",
  { timeout: 20_000 },
  async () => {
    const screen = await render(ChatSessionHarnessComponent, {
      inputs: {
        assistantId: "streaming_text_graph",
        inputs: [SLOW_INPUT, "Follow-up", "Third"],
      },
    });

    await stopMidReply(screen);

    await screen.getByTestId("reload").click();
    await expect.element(screen.getByTestId("session")).toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("thread-loading"))
      .toHaveTextContent("Ready");
    await expect.poll(() => text(screen, "transcript")).toBe(SLOW_INPUT);

    await screen.getByTestId("submit-1").click();
    await expect
      .poll(() => text(screen, "transcript"), { timeout: 5_000 })
      .toBe(`${SLOW_INPUT} | Follow-up | ${QUICK_REPLY}`);
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    await screen.getByTestId("reload").click();
    await expect.element(screen.getByTestId("session")).toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("thread-loading"))
      .toHaveTextContent("Ready");

    await screen.getByTestId("submit-2").click();
    const expected = `${SLOW_INPUT} | Follow-up | ${QUICK_REPLY} | Third | ${QUICK_REPLY}`;
    await expect
      .poll(() => text(screen, "transcript"), { timeout: 5_000 })
      .toBe(expected);
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
    expect(text(screen, "transcript")).toBe(expected);
  }
);

it(
  "drops a stopped reply in a second view of the thread",
  { timeout: 15_000 },
  async () => {
    const screen = await render(ChatSessionHarnessComponent, {
      inputs: {
        assistantId: "streaming_text_graph",
        inputs: [SLOW_INPUT, "Follow-up"],
      },
    });

    await screen.getByTestId("submit-0").click();
    await expect
      .poll(() => text(screen, "thread-id"))
      .not.toBe("none");
    await screen.getByTestId("observer-mount").click();
    await expect
      .poll(() => text(screen, "observer-transcript"), { timeout: 5_000 })
      .toContain(SLOW_REPLY_START);

    await screen.getByTestId("stop").click();
    await expect
      .element(screen.getByTestId("observer-loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect
      .poll(() => text(screen, "observer-transcript"))
      .toBe(SLOW_INPUT);

    await screen.getByTestId("submit-1").click();
    await expect
      .poll(() => text(screen, "observer-transcript"), { timeout: 5_000 })
      .toBe(`${SLOW_INPUT} | Follow-up | ${QUICK_REPLY}`);
  }
);

it(
  "keeps one copy of a reply streamed before a pause, across a reload and the resume",
  { timeout: 15_000 },
  async () => {
    const screen = await render(ChatSessionHarnessComponent, {
      inputs: {
        assistantId: "reply_then_interrupt_graph",
        inputs: ["Please draft"],
        respondValue: { approved: true },
      },
    });

    await screen.getByTestId("submit-0").click();
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 5_000 })
      .toHaveTextContent("1");
    await expect
      .poll(() => text(screen, "transcript"))
      .toBe(`Please draft | ${DRAFT_REPLY}`);

    await screen.getByTestId("reload").click();
    await expect.element(screen.getByTestId("session")).toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 5_000 })
      .toHaveTextContent("1");
    await expect
      .poll(() => text(screen, "transcript"), { timeout: 5_000 })
      .toBe(`Please draft | ${DRAFT_REPLY}`);

    await screen.getByTestId("respond").click();
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 5_000 })
      .toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
    await expect
      .poll(() => text(screen, "transcript"))
      .toBe(`Please draft | ${DRAFT_REPLY}`);
  }
);
