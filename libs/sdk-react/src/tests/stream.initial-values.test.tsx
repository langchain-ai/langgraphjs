import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { InitialValuesStream } from "./components/InitialValuesStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("renders cached messages synchronously from initialValues", async () => {
  const cached = {
    messages: [
      new HumanMessage({ id: "cached-1", content: "Cached user message" }),
      new AIMessage({ id: "cached-2", content: "Cached AI response" }),
    ] satisfies BaseMessage[],
    status: "cached-draft",
  };

  const screen = await render(
    <InitialValuesStream apiUrl={apiUrl} initialValues={cached} />,
  );

  try {
    await expect
      .element(screen.getByTestId("message-0"))
      .toHaveTextContent("Cached user message");
    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Cached AI response");
    await expect
      .element(screen.getByTestId("values"))
      .toHaveTextContent("Cached user message");
    await expect
      .element(screen.getByTestId("status-value"))
      .toHaveTextContent("cached-draft");
  } finally {
    await cleanupRender(screen);
  }
});

it("replaces initialValues with server state once a run starts", async () => {
  const cached = {
    messages: [
      new HumanMessage({ id: "cached-1", content: "Cached user message" }),
      new AIMessage({ id: "cached-2", content: "Cached AI response" }),
    ] satisfies BaseMessage[],
    status: "cached-draft",
  };

  const screen = await render(
    <InitialValuesStream apiUrl={apiUrl} initialValues={cached} />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("message-0"))
      .toHaveTextContent("Fresh request");
    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Plan accepted.");
  } finally {
    await cleanupRender(screen);
  }
});
