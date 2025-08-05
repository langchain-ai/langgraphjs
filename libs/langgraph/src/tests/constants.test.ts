import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import {
  Command,
  Send,
  CommandParams,
  _deserializeCommandSendObjectGraph,
} from "../constants.js";

describe("_deserializeCommandSendObjectGraph", () => {
  it("handles primitive values", () => {
    expect(_deserializeCommandSendObjectGraph(null)).toBeNull();
    expect(_deserializeCommandSendObjectGraph(undefined)).toBeUndefined();
    expect(_deserializeCommandSendObjectGraph(123)).toBe(123);
    expect(_deserializeCommandSendObjectGraph("test")).toBe("test");
    expect(_deserializeCommandSendObjectGraph(true)).toBe(true);
    expect(_deserializeCommandSendObjectGraph(false)).toBe(false);
  });

  it("handles arrays by mapping each element", () => {
    const input = [1, "test", { key: "value" }];
    const result = _deserializeCommandSendObjectGraph(input);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([1, "test", { key: "value" }]);
  });

  it("preserves Command objects", () => {
    const command = new Command({ goto: "next" });
    const result = _deserializeCommandSendObjectGraph(command);

    expect(result).toBe(command);
  });

  it("preserves Send objects", () => {
    const send = new Send("node", { data: "value" });
    const result = _deserializeCommandSendObjectGraph(send);

    expect(result).toBe(send);
  });

  it("converts serialized Command to Command objects", () => {
    const params: CommandParams<string> = {
      lg_name: "Command",
      goto: "next",
      update: { value: "test" },
    };
    const result = _deserializeCommandSendObjectGraph(params);

    expect(result).toBeInstanceOf(Command);
    expect((result as Command).goto).toEqual(["next"]);
    expect((result as Command).update).toEqual({ value: "test" });
  });

  it("converts SendInterface to Send objects", () => {
    const sendInterface = {
      node: "testNode",
      args: { data: "value" },
    };
    const result = _deserializeCommandSendObjectGraph(sendInterface);

    expect(result).toBeInstanceOf(Send);
    expect((result as Send).node).toBe("testNode");
    expect((result as Send).args).toEqual({ data: "value" });
  });

  it("recursively processes nested objects", () => {
    const nestedObject = {
      a: 1,
      b: {
        c: "test",
        d: {
          e: true,
        },
      },
    };
    const result = _deserializeCommandSendObjectGraph(nestedObject);

    expect(result).toEqual(nestedObject);
  });

  it("converts nested serialized Commands and SendInterface", () => {
    const complex = {
      command: { lg_name: "Command", goto: "next", update: { foo: "bar" } },
      send: { lg_name: "Send", node: "testNode", args: { data: "value" } },
      mixed: [1, { lg_name: "Command", goto: "another", update: {} }],
    };

    const result = _deserializeCommandSendObjectGraph(complex) as {
      command: Command;
      send: Send;
      mixed: [number, Command];
    };

    expect(result.command).toBeInstanceOf(Command);
    expect(result.send).toBeInstanceOf(Send);
    expect(result.mixed[1]).toBeInstanceOf(Command);
  });

  it("handles cycles in object tree gracefully", () => {
    // Create an object with a cycle
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objA: any = { name: "A" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objB: any = { name: "B" };
    objA.ref = objB;
    objB.ref = objA; // Creates a cycle

    // This should not throw
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = _deserializeCommandSendObjectGraph(objA) as any;

    // Verify structure
    expect(result.name).toBe("A");
    expect(result.ref.name).toBe("B");

    // Verify cycle was handled (objB.ref should point back to objA)
    expect(result.ref.ref).toBe(result);
  });

  it("handles cycles in arrays", () => {
    const arr: (number | object)[] = [1, 2];
    arr.push(arr); // Self-reference in array

    const result = _deserializeCommandSendObjectGraph(arr) as (
      | number
      | object
    )[];

    expect(result[0]).toBe(1);
    expect(result[1]).toBe(2);
    expect(result[2]).toBe(result); // Should refer to itself
  });

  it("handles complex nested objects with multiple cycles", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj1: any = { id: 1 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj2: any = { id: 2 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj3: any = { id: 3 };

    obj1.ref = obj2;
    obj2.ref = obj3;
    obj3.ref = obj1; // Cycle back to obj1
    obj3.selfRef = obj3; // Self-reference

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = _deserializeCommandSendObjectGraph(obj1) as any;

    // Verify structure
    expect(result.id).toBe(1);
    expect(result.ref.id).toBe(2);
    expect(result.ref.ref.id).toBe(3);

    // Verify cycles
    expect(result.ref.ref.ref).toBe(result); // Cycle back to obj1
    expect(result.ref.ref.selfRef).toBe(result.ref.ref); // Self-reference
  });

  it("properly converts goto arrays in serialized Commands", () => {
    const params: CommandParams<null> = {
      lg_name: "Command",
      goto: ["nodeA", "nodeB", { node: "nodeC", args: { data: "value" } }],
    };

    const result = _deserializeCommandSendObjectGraph(params) as Command;

    expect(result).toBeInstanceOf(Command);
    expect(Array.isArray(result.goto)).toBe(true);
    const goto = result.goto as (string | Send)[];
    expect(goto.length).toBe(3);
    expect(goto[0]).toBe("nodeA");
    expect(goto[1]).toBe("nodeB");
    expect(goto[2]).toBeInstanceOf(Send);
  });

  it("avoid unfurling Serializable objects", () => {
    const message = new AIMessage("first");
    const send = new Send("map-reduce", { messages: [message] });
    expect(send.args.messages[0]).toBe(message);

    const command = new Command({ goto: [send] });
    expect((command.goto as Send[])[0].args.messages[0]).toBe(message);
  });
});
