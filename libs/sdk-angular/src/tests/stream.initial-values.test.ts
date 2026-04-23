import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import {
  InitialValuesStreamComponent,
  setInitialValuesFixture,
} from "./components/InitialValuesStream.js";

afterEach(() => {
  setInitialValuesFixture({ messages: [] });
});

it("renders cached messages synchronously from initialValues", async () => {
  const cached = {
    messages: [
      new HumanMessage({ id: "cached-1", content: "Cached user message" }),
      new AIMessage({ id: "cached-2", content: "Cached AI response" }),
    ] satisfies BaseMessage[],
  };
  setInitialValuesFixture(cached);

  const screen = await render(InitialValuesStreamComponent);

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Cached user message");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Cached AI response");
  await expect
    .element(screen.getByTestId("values"))
    .toHaveTextContent("Cached user message");
});

it("replaces initialValues with server state once a run starts", async () => {
  const cached = {
    messages: [
      new HumanMessage({ id: "cached-1", content: "Cached user message" }),
      new AIMessage({ id: "cached-2", content: "Cached AI response" }),
    ] satisfies BaseMessage[],
  };
  setInitialValuesFixture(cached);

  const screen = await render(InitialValuesStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Fresh request");
  await expect.element(screen.getByTestId("message-1")).toHaveTextContent("Hey");
});
