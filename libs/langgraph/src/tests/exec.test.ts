import { describe, it, expect } from "@jest/globals";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  isAIMessage,
  isToolMessage,
} from "@langchain/core/messages";
import { StateGraph } from "../graph/state.js";
import { END, Messages, MessagesAnnotation, START } from "../web.js";
import { Annotation } from "../graph/annotation.js";
import { exec } from "../pregel/exec.js";
import { FakeChatModel } from "./utils.js";
import { MessagesEvent } from "../pregel/types.js";

describe("exec", () => {
  describe("single layer graph", () => {
    it("should have strongly typed values stream", async () => {
      const model = new FakeChatModel({
        responses: [new AIMessage("Cold, with a low of 3℃")],
      });

      const callModel = async (state: typeof MessagesAnnotation.State) => {
        const { messages } = state;
        const responseMessage = await model.invoke(messages);
        return { messages: [responseMessage] };
      };

      const workflow = new StateGraph(MessagesAnnotation)
        .addNode("agent", callModel)
        .addEdge(START, "agent")
        .addEdge("agent", END);

      const graph = workflow.compile();

      const inputs = {
        messages: [new HumanMessage("what's the weather in sf")],
      };

      const pv = exec(graph, { streamMode: "values" })(inputs);

      const messages: BaseMessage[] = [];

      for await (const chunk of pv) {
        // Split declarataion from assignment so the TS type checker errors on type mismatches
        let mode: "values";
        let payload: { messages: BaseMessage[] };

        // eslint-disable-next-line prefer-const
        [mode, payload] = chunk;

        expect(mode).toBe("values");
        // only push the last message
        messages.push(payload.messages[payload.messages.length - 1]);
      }

      expect(messages.length).toEqual(2);
      expect(messages[0].getType()).toEqual("human");
      expect(messages[0].content).toEqual("what's the weather in sf");
      expect(messages[1].getType()).toEqual("ai");
      expect(messages[1].content).toEqual("Cold, with a low of 3℃");
    });

    it("should have strongly typed updates stream", async () => {
      const StateAnnotation = Annotation.Root({
        ...MessagesAnnotation.spec,
        foo: Annotation<string[]>({
          reducer: (left, right) => {
            return [...left, ...right];
          },
          default: () => [],
        }),
      });

      const model = new FakeChatModel({
        responses: [new AIMessage("Cold, with a low of 3℃")],
      });

      const callModel = async (state: typeof StateAnnotation.State) => {
        const { messages } = state;
        const responseMessage = await model.invoke(messages);
        return { messages: [responseMessage] };
      };

      const workflow = new StateGraph(StateAnnotation)
        .addNode("agent", callModel)
        .addEdge(START, "agent")
        .addEdge("agent", END);

      const graph = workflow.compile();

      const inputs = {
        messages: [new HumanMessage("what's the weather in sf")],
      };

      const pv = exec(graph, { streamMode: "updates" })(inputs);

      const messages: BaseMessage[] = [];

      for await (const chunk of pv) {
        // Split declarataion from assignment so the TS type checker errors on type mismatches
        let mode: "updates";
        let payload: {
          agent: {
            foo?: string[] | string[][] | undefined;
            messages?: Messages | Messages[] | undefined;
          };
        };

        // eslint-disable-next-line prefer-const
        [mode, payload] = chunk;
        expect(mode).toBe("updates");

        // TODO: updates stream mode yields record of node name to return val
        expect(payload.agent.messages).toBeDefined();
        expect(Array.isArray(payload.agent.messages)).toBe(true);
        expect(payload.agent.foo).toBeUndefined();
        messages.push(...(payload.agent.messages as BaseMessage[]));
      }

      expect(messages.length).toEqual(1);
      expect(messages[0].getType()).toEqual("ai");
      expect(messages[0].content).toEqual("Cold, with a low of 3℃");
    });

    it("should have strongly typed messages stream", async () => {
      const model = new FakeChatModel({
        responses: [new AIMessage("Cold, with a low of 3℃")],
      });

      const callModel = async (state: typeof MessagesAnnotation.State) => {
        const { messages } = state;
        const responseMessage = await model.invoke(messages);
        return { messages: [responseMessage] };
      };

      const workflow = new StateGraph(MessagesAnnotation)
        .addNode("agent", callModel)
        .addEdge(START, "agent")
        .addEdge("agent", END);

      const graph = workflow.compile();

      const inputs = {
        messages: [new HumanMessage("what's the weather in sf")],
      };

      const pv = exec(graph, { streamMode: "messages" })(inputs);

      const messages: BaseMessage[] = [];

      for await (const chunk of pv) {
        // Split declarataion from assignment so the TS type checker errors on type mismatches
        let mode: "messages";
        let payload: MessagesEvent;

        // eslint-disable-next-line prefer-const
        [mode, payload] = chunk;
        expect(mode).toBe("messages");
        // TODO: updates stream mode yields record of node name to return val
        expect(payload.message).toBeDefined();
        expect(payload.metadata).toBeDefined();
        expect(
          isAIMessage(payload.message) || isToolMessage(payload.message)
        ).toBe(true);
        messages.push(payload.message);
      }

      expect(messages.length).toEqual(1);
      expect(messages[0].getType()).toEqual("ai");
      expect(messages[0].content).toEqual("Cold, with a low of 3℃");
    });
  });
});
