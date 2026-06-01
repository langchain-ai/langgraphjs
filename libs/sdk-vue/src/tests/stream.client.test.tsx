import { Client } from "@langchain/langgraph-sdk";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-vue";

import { BasicStream } from "./components/BasicStream.js";
import { apiUrl } from "./test-utils.js";

it("routes client-backed requests through onRequest", async () => {
  const onRequestCallback = vi.fn();
  const threadId = crypto.randomUUID();
  const client = new Client({
    apiUrl,
    onRequest: (url, init) => {
      onRequestCallback(url.toString(), init);
      return init;
    },
  });

  const seed = await render(BasicStream, {
    props: { apiUrl, threadId },
  });
  await seed.getByTestId("submit").click();
  await expect
    .element(seed.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await seed.unmount();

  const screen = await render(BasicStream, {
    props: { apiUrl, client, threadId },
  });

  try {
    await expect
      .element(screen.getByTestId("message-count"), { timeout: 5_000 })
      .toHaveTextContent("2");

    expect(onRequestCallback).toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
