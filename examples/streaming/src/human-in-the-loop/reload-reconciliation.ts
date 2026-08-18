/**
 * Reproduces a UI lifecycle where a resolved custom interrupt must not
 * reappear after page reload:
 *
 *   1. Submit a message that produces a custom interrupt.
 *   2. Respond to the interrupt and wait for the resumed run.
 *   3. Submit a normal follow-up message.
 *   4. Recreate the StreamController with the same thread id.
 *   5. Verify hydration does not surface the resolved interrupt.
 *
 * Run:
 *   npx tsx src/human-in-the-loop/reload-reconciliation.ts
 */

import assert from "node:assert/strict";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Client } from "@langchain/langgraph-sdk";
import {
  StreamController,
  type RootSnapshot,
  type StreamStore,
} from "@langchain/langgraph-sdk/stream";

import {
  INTERRUPT_PROMPT,
  type ApprovalInterrupt,
  type ApprovalResponse,
} from "../agents/custom-interrupt.js";
import { startDevServer } from "../shared/dev-server.js";

interface State {
  messages: BaseMessage[];
}

type Snapshot = RootSnapshot<State, ApprovalInterrupt>;

const FOLLOW_UP = "The interrupt is resolved. Continue normally.";
const WAIT_TIMEOUT_MS = 10_000;

function messageText(message: BaseMessage | undefined): string {
  if (message == null) return "";
  if (message.text.length > 0) return message.text;
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) =>
      typeof block === "string"
        ? block
        : "text" in block && typeof block.text === "string"
          ? block.text
          : ""
    )
    .join("");
}

async function waitForSnapshot(
  store: StreamStore<Snapshot>,
  predicate: (snapshot: Snapshot) => boolean,
  description: string
): Promise<Snapshot> {
  const current = store.getSnapshot();
  if (predicate(current)) return current;

  return new Promise<Snapshot>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      const snapshot = store.getSnapshot();
      reject(
        new Error(
          `Timed out waiting for ${description}: ${JSON.stringify({
            error: snapshot.error,
            interruptCount: snapshot.interrupts.length,
            isLoading: snapshot.isLoading,
            messages: snapshot.messages.map((message) =>
              messageText(message)
            ),
          })}`
        )
      );
    }, WAIT_TIMEOUT_MS);
    const unsubscribe = store.subscribe(() => {
      const snapshot = store.getSnapshot();
      if (!predicate(snapshot)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(snapshot);
    });
  });
}

async function main() {
  console.log("--- Starting dev server ---\n");
  const { url, stop } = await startDevServer({ silent: true });
  const client = new Client<State>({ apiUrl: url });
  let controller: StreamController<State, ApprovalInterrupt> | undefined;

  try {
    controller = new StreamController<State, ApprovalInterrupt>({
      assistantId: "custom-interrupt",
      client,
    });

    console.log("1. Submitting a message that requests approval...");
    await controller.submit({
      messages: [new HumanMessage(INTERRUPT_PROMPT)],
    });

    const interrupted = await waitForSnapshot(
      controller.rootStore,
      (snapshot) => snapshot.interrupts.length === 1,
      "the custom interrupt"
    );
    const pending = interrupted.interrupts[0];
    assert.ok(pending);
    assert.ok(pending.value);
    assert.equal(pending.value.type, "approval");
    console.log(`   Interrupt: ${pending.value.question}`);

    console.log("2. Approving the interrupt...");
    const response: ApprovalResponse = { approved: true };
    await controller.respond(response, { interruptId: pending.id });
    const resumed = await waitForSnapshot(
      controller.rootStore,
      (snapshot) =>
        !snapshot.isLoading &&
        snapshot.interrupts.length === 0 &&
        messageText(snapshot.messages.at(-1)) === "Request approved.",
      "the resumed run to complete"
    );
    assert.equal(messageText(resumed.messages.at(-1)), "Request approved.");

    console.log("3. Submitting a normal follow-up turn...");
    await controller.submit({
      messages: [new HumanMessage(FOLLOW_UP)],
    });
    const followedUp = await waitForSnapshot(
      controller.rootStore,
      (snapshot) =>
        !snapshot.isLoading &&
        messageText(snapshot.messages.at(-1)) === `Echo: ${FOLLOW_UP}`,
      "the follow-up run to complete"
    );
    assert.equal(followedUp.interrupts.length, 0);

    const threadId = followedUp.threadId;
    assert.ok(threadId, "Expected the controller to create a thread id.");
    console.log(`4. Simulating reload of thread ${threadId}...`);

    await controller.dispose();
    controller = new StreamController<State, ApprovalInterrupt>({
      assistantId: "custom-interrupt",
      client,
      threadId,
    });
    await controller.hydrationPromise;

    const reloaded = await waitForSnapshot(
      controller.rootStore,
      (snapshot) =>
        messageText(snapshot.messages.at(-1)) === `Echo: ${FOLLOW_UP}`,
      "the reloaded messages to reconcile"
    );
    assert.equal(
      reloaded.interrupts.length,
      0,
      "Reload surfaced an already-resolved interrupt."
    );
    assert.equal(
      reloaded.interrupt,
      undefined,
      "Reload selected an already-resolved interrupt."
    );

    console.log("   ✓ Messages reconciled and no resolved interrupt resurfaced.");
  } finally {
    await controller?.dispose();
    stop();
  }
}

await main();
