/**
 * Subscription-efficiency tests for the experimental stream.
 *
 * The new protocol is designed so that components only open server
 * subscriptions for the *specific* slice of data they render. This
 * matters most for deep-agent UIs where a page may carry many
 * subagent cards but only a few are actually visible at once —
 * mounting / unmounting those cards must move the underlying
 * subscription set in lock-step.
 *
 * Each test drives the `DeepAgentSubscriptionStream` harness which
 * toggles individual observer components on and off and publishes
 * `ChannelRegistry.size` so we can assert on the live entry count.
 *
 * Invariants we check:
 *  1. Mounting the hook alone opens zero scoped subscriptions.
 *  2. `useMessages(stream)` at the root never touches the registry —
 *     it reads `stream.messages` directly.
 *  3. Every *unique* `(selector, namespace)` pair opens exactly one
 *     registry entry, regardless of how many components consume it.
 *  4. Different namespaces are independent: messages for subagent A
 *     never appear in subagent B's snapshot.
 *  5. Unmounting the last consumer for a key releases the entry.
 *  6. Stacking `useMessages` + `useToolCalls` on the same subagent
 *     opens two entries (different projection keys) but tearing down
 *     one doesn't affect the other.
 */
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { DeepAgentSubscriptionStream } from "./components/DeepAgentSubscriptionStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("does not open any scoped subscriptions for a bare useStream mount", async () => {
  const screen = await render(<DeepAgentSubscriptionStream apiUrl={apiUrl} />);

  try {
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    // No selector hooks are mounted yet — the always-on root
    // projections live on the controller itself, not in the
    // ref-counted registry, so size must be zero.
    await expect
      .element(screen.getByTestId("registry-size"))
      .toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});

it("root useMessages(stream) is served by the always-on projection and never registers an entry", async () => {
  const screen = await render(<DeepAgentSubscriptionStream apiUrl={apiUrl} />);

  try {
    await expect
      .element(screen.getByTestId("registry-size"))
      .toHaveTextContent("0");

    await screen.getByTestId("toggle-root-messages").click();

    // A root-scoped observer mounted — but the selector hook short
    // circuits to `stream.messages` for the root namespace, so the
    // ref-counted registry must still be empty.
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("0");

    await screen.getByTestId("toggle-root-messages").click();

    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});

it("opens exactly one scoped subscription per (selector, namespace) and releases it on unmount", async () => {
  // Pre-flip the researcher-A toggle so the observer attaches the
  // moment the subagent is discovered. Scoped projections only see
  // events that arrive *after* they subscribe — pre-arming the
  // toggle avoids racing the deep-agent's orchestration.
  const screen = await render(
    <DeepAgentSubscriptionStream
      apiUrl={apiUrl}
      initialMounts={{ researcherMessagesA: true }}
    />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    // One observer mounted → one entry.
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("obs-researcher-a-namespace"))
      .toHaveTextContent(/^tools:/);

    // And it actually received data scoped to that namespace.
    await expect
      .element(screen.getByTestId("obs-researcher-a-count"))
      .not.toHaveTextContent("0");

    await screen.getByTestId("toggle-researcher-messages-a").click();

    // Last consumer released → entry torn down.
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});

it("dedupes registry entries across multiple consumers of the same (selector, namespace)", async () => {
  const screen = await render(
    <DeepAgentSubscriptionStream
      apiUrl={apiUrl}
      initialMounts={{
        researcherMessagesA: true,
        researcherMessagesB: true,
      }}
    />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
      .toHaveTextContent("2");

    // Both observers share the same subagent → ref count is 2 but
    // the registry only has one entry for the `messages|<ns>` key.
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("1");

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    // The terminal lifecycle event is dispatched as soon as the run
    // ends, but the scoped messages projection drains its replay on a
    // separate subscription. In CI we sometimes observe the terminal
    // flip before any messages have landed in the projection store —
    // the synchronous reads below would then capture a `0/0` pair that
    // matches the (a == b) invariant but trips `toBeGreaterThan(0)`.
    // Poll for the projection to populate before sampling so the
    // assertions describe a steady state rather than a transient one.
    await expect
      .element(screen.getByTestId("obs-researcher-a-count"), {
        timeout: 5_000,
      })
      .not.toHaveTextContent("0");

    // Both consumers see identical snapshots — the shared store
    // guarantees they read from exactly the same value.
    const a = Number(
      screen.getByTestId("obs-researcher-a-count").element().textContent,
    );
    const b = Number(
      screen.getByTestId("obs-researcher-b-count").element().textContent,
    );
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);

    // Releasing one of them must not tear down the shared entry.
    await screen.getByTestId("toggle-researcher-messages-a").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("1");

    // The surviving observer still holds the same data.
    await expect
      .element(screen.getByTestId("obs-researcher-b-count"))
      .toHaveTextContent(String(b));

    // Releasing the last one drops the entry.
    await screen.getByTestId("toggle-researcher-messages-b").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});

it("keeps subagent message streams fully isolated across namespaces", async () => {
  const screen = await render(
    <DeepAgentSubscriptionStream
      apiUrl={apiUrl}
      initialMounts={{
        researcherMessagesA: true,
        analystMessages: true,
      }}
    />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
      .toHaveTextContent("2");

    // Two distinct namespaces → two entries.
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("2");

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    const researcherNs = screen
      .getByTestId("obs-researcher-a-namespace")
      .element().textContent;
    const analystNs = screen
      .getByTestId("obs-analyst-namespace")
      .element().textContent;
    expect(researcherNs).toBeTruthy();
    expect(analystNs).toBeTruthy();
    expect(researcherNs).not.toBe(analystNs);

    // Wait for both scoped projections to finish replaying before
    // sampling the counts synchronously. The terminal lifecycle event
    // can land before per-namespace replay is done, so a bare read
    // racing the run completion could observe `0` even though the
    // projections are healthy.
    await expect
      .element(screen.getByTestId("obs-researcher-a-count"), {
        timeout: 5_000,
      })
      .not.toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("obs-analyst-count"), { timeout: 5_000 })
      .not.toHaveTextContent("0");

    // Both must carry some messages on their own — if the
    // subscriptions leaked across namespaces we'd expect the first
    // one to be empty and the second to carry everyone's messages.
    const researcherCount = Number(
      screen.getByTestId("obs-researcher-a-count").element().textContent,
    );
    const analystCount = Number(
      screen.getByTestId("obs-analyst-count").element().textContent,
    );
    expect(researcherCount).toBeGreaterThan(0);
    expect(analystCount).toBeGreaterThan(0);

    await screen.getByTestId("toggle-researcher-messages-a").click();

    // Only one namespace is observed now.
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("1");

    await screen.getByTestId("toggle-analyst-messages").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});

it("opens separate registry entries for different selector kinds on the same subagent", async () => {
  const screen = await render(
    <DeepAgentSubscriptionStream
      apiUrl={apiUrl}
      initialMounts={{
        researcherMessagesA: true,
        researcherToolCalls: true,
      }}
    />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
      .toHaveTextContent("2");

    // useToolCalls uses a different projection key (`toolcalls|...`
    // vs `messages|...`) so it must add its own entry rather than
    // folding into the messages one.
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("2");

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("obs-researcher-tc-names"), {
        timeout: 5_000,
      })
      .toHaveTextContent("search_web");

    // Releasing the tool-calls observer drops back to one entry.
    await screen.getByTestId("toggle-researcher-toolcalls").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("1");

    // Messages observer still there, so size stays at 1.
    await expect
      .element(screen.getByTestId("obs-researcher-a-count"))
      .not.toHaveTextContent("0");

    await screen.getByTestId("toggle-researcher-messages-a").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
}, 20_000);

it("opens subagent subscriptions lazily — entry count ratchets with each observer mounted", async () => {
  const screen = await render(<DeepAgentSubscriptionStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    // Walk through four observers of different kinds / namespaces.
    // The registry must grow monotonically as unique keys come in
    // and shrink monotonically as they leave.
    const readSize = () =>
      Number(screen.getByTestId("registry-size").element().textContent);

    const steps: Array<{ click: string; expected: number }> = [
      { click: "toggle-researcher-messages-a", expected: 1 },
      { click: "toggle-researcher-messages-b", expected: 1 }, // deduped
      { click: "toggle-analyst-messages", expected: 2 }, // new namespace
      { click: "toggle-researcher-toolcalls", expected: 3 }, // new selector
    ];

    for (const step of steps) {
      await screen.getByTestId(step.click).click();
      await expect
        .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
        .toHaveTextContent(String(step.expected));
      expect(readSize()).toBe(step.expected);
    }

    // Unwind in reverse (and an extra dedup step at the end).
    const teardown: Array<{ click: string; expected: number }> = [
      { click: "toggle-researcher-toolcalls", expected: 2 },
      { click: "toggle-analyst-messages", expected: 1 },
      { click: "toggle-researcher-messages-b", expected: 1 }, // still deduped
      { click: "toggle-researcher-messages-a", expected: 0 },
    ];

    for (const step of teardown) {
      await screen.getByTestId(step.click).click();
      await expect
        .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
        .toHaveTextContent(String(step.expected));
    }
  } finally {
    await cleanupRender(screen);
  }
});
