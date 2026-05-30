import { expect, inject, it } from "vitest";
import { render } from "vitest-browser-svelte";

import DeepAgentSubscriptionStream from "./components/DeepAgentSubscriptionStream.svelte";

const serverUrl = inject("serverUrl");

it("does not open scoped subscriptions for a bare useStream mount", async () => {
  const screen = render(DeepAgentSubscriptionStream, { apiUrl: serverUrl });

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("registry-size")).toHaveTextContent("0");
});

it("root useMessages(stream) delegates to the root projection", async () => {
  const screen = render(DeepAgentSubscriptionStream, { apiUrl: serverUrl });

  await expect.element(screen.getByTestId("registry-size")).toHaveTextContent("0");

  await screen.getByTestId("toggle-root-messages").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("0");

  await screen.getByTestId("toggle-root-messages").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("0");
});

it("opens one scoped subscription per selector/namespace and releases it", async () => {
  const screen = render(DeepAgentSubscriptionStream, {
    apiUrl: serverUrl,
    initialMounts: { researcherMessagesA: true },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("obs-researcher-a-namespace"))
    .toHaveTextContent(/^tools:/);

  await screen.getByTestId("toggle-researcher-messages-a").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("0");
});

it("dedupes registry entries across multiple consumers of one namespace", async () => {
  const screen = render(DeepAgentSubscriptionStream, {
    apiUrl: serverUrl,
    initialMounts: {
      researcherMessagesA: true,
      researcherMessagesB: true,
    },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  // Wait for the scoped projection to finish replaying. The terminal
  // lifecycle event can flip `isLoading` before the per-namespace
  // replay lands, which would let a synchronous read observe `0/0`
  // (consistent but pre-data) and trip the `> 0` assertion below.
  await expect
    .element(screen.getByTestId("obs-researcher-a-count"), { timeout: 5_000 })
    .not.toHaveTextContent("0");

  const a = Number(
    screen.getByTestId("obs-researcher-a-count").element().textContent,
  );
  const b = Number(
    screen.getByTestId("obs-researcher-b-count").element().textContent,
  );
  expect(a).toBe(b);
  expect(a).toBeGreaterThan(0);

  await screen.getByTestId("toggle-researcher-messages-a").click();
  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("1");

  await screen.getByTestId("toggle-researcher-messages-b").click();
  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("0");
});

it("keeps subagent message streams isolated across namespaces", async () => {
  const screen = render(DeepAgentSubscriptionStream, {
    apiUrl: serverUrl,
    initialMounts: {
      researcherMessagesA: true,
      analystMessages: true,
    },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
    .toHaveTextContent("2");
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
});

it("tracks message and tool-call selectors independently", async () => {
  const screen = render(DeepAgentSubscriptionStream, {
    apiUrl: serverUrl,
    initialMounts: {
      researcherMessagesA: true,
      researcherToolCalls: true,
    },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("obs-researcher-tc-count"))
    .not.toHaveTextContent("0");

  await screen.getByTestId("toggle-researcher-messages-a").click();
  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("1");

  await screen.getByTestId("toggle-researcher-toolcalls").click();
  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("0");
});

it("opens subagent subscriptions lazily — entry count ratchets with each observer mounted", async () => {
  const screen = render(DeepAgentSubscriptionStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  const readSize = () =>
    Number(screen.getByTestId("registry-size").element().textContent);

  const steps: Array<{ click: string; expected: number }> = [
    { click: "toggle-researcher-messages-a", expected: 1 },
    { click: "toggle-researcher-messages-b", expected: 1 },
    { click: "toggle-analyst-messages", expected: 2 },
    { click: "toggle-researcher-toolcalls", expected: 3 },
  ];

  for (const step of steps) {
    await screen.getByTestId(step.click).click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent(String(step.expected));
    expect(readSize()).toBe(step.expected);
  }

  const teardown: Array<{ click: string; expected: number }> = [
    { click: "toggle-researcher-toolcalls", expected: 2 },
    { click: "toggle-analyst-messages", expected: 1 },
    { click: "toggle-researcher-messages-b", expected: 1 },
    { click: "toggle-researcher-messages-a", expected: 0 },
  ];

  for (const step of teardown) {
    await screen.getByTestId(step.click).click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent(String(step.expected));
    expect(readSize()).toBe(step.expected);
  }
});
