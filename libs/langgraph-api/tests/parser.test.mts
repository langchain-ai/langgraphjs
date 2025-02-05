import { describe, expect, test } from "vitest";

import { SubgraphExtractor } from "../src/graph/parser/parser.mjs";
import dedent from "dedent";

describe.concurrent("graph factories", () => {
  const common = dedent`
    import { HumanMessage } from "@langchain/core/messages";
    import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

    const builder = new StateGraph(MessagesAnnotation)
      .addNode("parent", () => {
        return { messages: [new HumanMessage("parent")] };
      })
      .addNode("child", async (state) => {
        return { messages: [new HumanMessage("child")] };
      })
      .addEdge("__start__", "parent")
      .addEdge("parent", "child")
      .addEdge("child", "__end__");
  `;

  const MessagesSchema = {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: { $ref: "#/definitions/BaseMessage" },
      },
    },
    definitions: {
      BaseMessage: {
        oneOf: expect.arrayContaining([
          { $ref: "#/definitions/BaseMessageChunk" },
        ]),
      },
    },
    $schema: "http://json-schema.org/draft-07/schema#",
  };

  const ConfigSchema = {
    type: "object",
    $schema: "http://json-schema.org/draft-07/schema#",
  };

  test.concurrent.for([
    ["builder.compile()"], // CompiledGraph
    ["() => builder.compile()"], // () => CompiledGraph
    ["builder"], // Graph
    ["() => builder"], // () => Graph

    ["(async () => builder)()"], // Promise<CompiledGraph>
    ["async () => builder.compile()"], // () => Promise<CompiledGraph>
    ["(async () => builder)()"], // Promise<Graph>
    ["async () => builder"], // () => Promise<Graph>
  ])("%s", ([prop]) => {
    const schemas = SubgraphExtractor.extractSchemas(
      { contents: `${common}\n\nexport const graph = ${prop};` },
      "graph",
    );

    expect(schemas.graph.input).toMatchObject(MessagesSchema);
    expect(schemas.graph.output).toMatchObject(MessagesSchema);
    expect(schemas.graph.state).toMatchObject(MessagesSchema);
    expect(schemas.graph.config).toEqual(ConfigSchema);
  });
});

describe.concurrent("subgraphs", () => {
  test.concurrent.for([
    ["subgraph"],
    ["(state) => subgraph.invoke(state)"],
    ["async (state) => await subgraph.invoke(state)"],
  ])(`basic: %s`, ([nodeDef]) => {
    const schemas = SubgraphExtractor.extractSchemas(
      {
        contents: dedent`
          import { HumanMessage } from "@langchain/core/messages";
          import {
            Annotation,
            MessagesAnnotation,
            StateGraph,
          } from "@langchain/langgraph";
      
          const ParentSchema = MessagesAnnotation;
      
          const SubgraphSchema = Annotation.Root({
            ...MessagesAnnotation.spec,
            kind: Annotation<"weather" | "other">,
          });
      
          const subgraph = new StateGraph(SubgraphSchema)
            .addNode("child", () => {
              return { messages: [new HumanMessage("Hello from child")] };
            })
            .addEdge("__start__", "child")
            .compile();

          export const graph = new StateGraph(ParentSchema)
            .addNode("parent", () => {
              return { messages: [new HumanMessage("Hello from child")] };
            })
            .addNode("child", ${nodeDef})
            .addEdge("__start__", "parent")
            .addEdge("parent", "child")
            .addEdge("child", "__end__")
            .compile();
          `,
      },
      "graph",
    );
    expect(schemas["graph|child"].input).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].output).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].state).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].config).toMatchObject({
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  test.concurrent("nested subgraphs", () => {
    const schemas = SubgraphExtractor.extractSchemas(
      {
        contents: dedent`
          import { HumanMessage } from "@langchain/core/messages";
          import {
            Annotation,
            MessagesAnnotation,
            StateGraph,
          } from "@langchain/langgraph";
      
          const ParentSchema = MessagesAnnotation;
      
          const ChildSchema = Annotation.Root({
            ...MessagesAnnotation.spec,
            child: Annotation<"alpha" | "beta">,
          });

          const SubchildSchema = Annotation.Root({
            ...MessagesAnnotation.spec,
            subchild: Annotation<"one" | "two">,
          });

          const subchild = new StateGraph(SubchildSchema)
            .addNode("subchild_one", () => ({ messages: [new HumanMessage("subchild_one")] }))
            .addNode("subchild_two", () => ({ messages: [new HumanMessage("subchild_two")] }))
            .addEdge("__start__", "subchild_one")
            .addEdge("subchild_one", "subchild_two")
            .compile();
      
          const child = new StateGraph(ChildSchema)
            .addNode("child_one", () => ({ messages: [new HumanMessage("child_one")] }))
            .addNode("child_two", subchild)
            .addEdge("__start__", "child_one")
            .addEdge("child_one", "child_two")
            .compile();
      
          export const parent = new StateGraph(ParentSchema)
            .addNode("parent_one", () => ({ messages: [new HumanMessage("parent_one")] }))
            .addNode("parent_two", child)
            .addEdge("__start__", "parent_one")
            .addEdge("parent_one", "parent_two")
            .compile();
        `,
      },
      "parent",
    );

    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        "parent",
        "parent|parent_two",
        "parent|parent_two|child_two",
      ]),
    );

    expect(schemas.parent.state).toMatchObject({
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["parent|parent_two"].state).toMatchObject({
      type: "object",
      properties: {
        child: {
          type: "string",
          enum: expect.arrayContaining(["alpha", "beta"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["parent|parent_two|child_two"].state).toMatchObject({
      type: "object",
      properties: {
        subchild: {
          type: "string",
          enum: expect.arrayContaining(["one", "two"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  test.concurrent("multiple subgraphs within a single node", () => {
    expect(() => {
      SubgraphExtractor.extractSchemas(
        {
          contents: dedent`
          import { HumanMessage } from "@langchain/core/messages";
          import {
            Annotation,
            MessagesAnnotation,
            StateGraph,
          } from "@langchain/langgraph";
      
          const ParentSchema = MessagesAnnotation;
      
          const ChildSchema = Annotation.Root({
            ...MessagesAnnotation.spec,
            child: Annotation<"alpha" | "beta">,
          });
  
          const SubchildSchema = Annotation.Root({
            ...MessagesAnnotation.spec,
            subchild: Annotation<"one" | "two">,
          });
  
          const subchild = new StateGraph(SubchildSchema)
            .addNode("subchild_one", () => ({ messages: [new HumanMessage("subchild_one")] }))
            .addNode("subchild_two", () => ({ messages: [new HumanMessage("subchild_two")] }))
            .addEdge("__start__", "subchild_one")
            .addEdge("subchild_one", "subchild_two")
            .compile();
      
          const child = new StateGraph(ChildSchema)
            .addNode("child_one", () => ({ messages: [new HumanMessage("child_one")] }))
            .addNode("child_two", () => ({ messages: [new HumanMessage("child_two")] }))
            .addEdge("__start__", "child_one")
            .addEdge("child_one", "child_two")
            .compile();
      
          export const parent = new StateGraph(ParentSchema)
            .addNode("parent_one", async (schema) => {
              const messages = []
              messages.concat((await child.invoke(schema)).messages)
              messages.concat((await subchild.invoke(schema)).messages)
              return { messages }
            })
            .addNode("parent_two", child)
            .addEdge("__start__", "parent_one")
            .addEdge("parent_one", "parent_two")
            .compile();
        `,
        },
        "parent",
        { strict: true },
      );
    }).toThrowError(
      `Multiple unique subgraph invocations found for "parent|parent_one"`,
    );
  });

  test.concurrent("imported subgraphs", () => {
    const schemas = SubgraphExtractor.extractSchemas(
      {
        contents: dedent`
          import { HumanMessage } from "@langchain/core/messages";
          import { subgraph } from "./subgraph.mts";
          import {
            Annotation,
            MessagesAnnotation,
            StateGraph,
          } from "@langchain/langgraph";
      
          const ParentSchema = MessagesAnnotation;
      
          const SubgraphSchema = Annotation.Root({
            ...MessagesAnnotation.spec,
            kind: Annotation<"weather" | "other">,
          });
      
          export const graph = new StateGraph(ParentSchema)
            .addNode("parent", () => {
              return { messages: [new HumanMessage("Hello from child")] };
            })
            .addNode("child", subgraph)
            .addEdge("__start__", "parent")
            .addEdge("parent", "child")
            .addEdge("child", "__end__")
            .compile();
          `,
        files: [
          [
            "./subgraph.mts",
            dedent`
              import { HumanMessage } from "@langchain/core/messages";
              import {
                Annotation,
                MessagesAnnotation,
                StateGraph,
              } from "@langchain/langgraph";
          
              const SubgraphSchema = Annotation.Root({
                ...MessagesAnnotation.spec,
                kind: Annotation<"weather" | "other">,
              });
          
              export const subgraph = new StateGraph(SubgraphSchema)
                .addNode("child", () => {
                  return { messages: [new HumanMessage("Hello from child")] };
                })
                .addEdge("__start__", "child")
                .compile();
            `,
          ],
        ],
      },
      "graph",
    );

    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(["graph", "graph|child"]),
    );

    expect(schemas["graph|child"].input).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].output).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].state).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].config).toMatchObject({
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  test.concurrent("imported uncompiled subgraphs", () => {
    const schemas = SubgraphExtractor.extractSchemas(
      {
        contents: dedent`
          import { HumanMessage } from "@langchain/core/messages";
          import { subgraph } from "./subgraph.mts";
          import {
            Annotation,
            MessagesAnnotation,
            StateGraph,
          } from "@langchain/langgraph";
      
          const ParentSchema = MessagesAnnotation;
      
          const SubgraphSchema = Annotation.Root({
            ...MessagesAnnotation.spec,
            kind: Annotation<"weather" | "other">,
          });
      
          export const graph = new StateGraph(ParentSchema)
            .addNode("parent", () => {
              return { messages: [new HumanMessage("Hello from child")] };
            })
            .addNode("child", subgraph.compile())
            .addEdge("__start__", "parent")
            .addEdge("parent", "child")
            .addEdge("child", "__end__")
            .compile();
          `,
        files: [
          [
            "./subgraph.mts",
            dedent`
              import { HumanMessage } from "@langchain/core/messages";
              import {
                Annotation,
                MessagesAnnotation,
                StateGraph,
              } from "@langchain/langgraph";
          
              const SubgraphSchema = Annotation.Root({
                ...MessagesAnnotation.spec,
                kind: Annotation<"weather" | "other">,
              });
          
              export const subgraph = new StateGraph(SubgraphSchema)
                .addNode("child", () => {
                  return { messages: [new HumanMessage("Hello from child")] };
                })
                .addEdge("__start__", "child")
            `,
          ],
        ],
      },
      "graph",
    );

    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(["graph", "graph|child"]),
    );

    expect(schemas["graph|child"].input).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].output).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].state).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].config).toMatchObject({
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  test.concurrent("indirect", () => {
    const schemas = SubgraphExtractor.extractSchemas(
      {
        contents: dedent`
          import { HumanMessage } from "@langchain/core/messages";
          import {
            Annotation,
            MessagesAnnotation,
            StateGraph,
          } from "@langchain/langgraph";
      
          const ParentSchema = MessagesAnnotation;
      
          const SubgraphSchema = Annotation.Root({
            ...MessagesAnnotation.spec,
            kind: Annotation<"weather" | "other">,
          });
      
          const subgraph = new StateGraph(SubgraphSchema)
            .addNode("child", () => {
              return { messages: [new HumanMessage("Hello from child")] };
            })
            .addEdge("__start__", "child")
            .compile();
      
          const parent = new StateGraph(ParentSchema)
            .addNode("parent", () => {
              return { messages: [new HumanMessage("Hello from child")] };
            })
            .addNode("child", subgraph)
            .addEdge("__start__", "parent")
            .addEdge("parent", "child")
            .addEdge("child", "__end__");

          const indirect1 = parent
          const indirect2 = (() => indirect1)()
          export const graph = parent.compile() 
        `,
      },
      "graph",
    );
    expect(schemas["graph|child"].input).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].output).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].state).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: expect.arrayContaining([
            { $ref: "#/definitions/BaseMessageChunk" },
          ]),
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas["graph|child"].config).toMatchObject({
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });
});

test.concurrent("weather", () => {
  const schemas = SubgraphExtractor.extractSchemas(
    {
      contents: dedent`
        import { Annotation, StateGraph, END, START } from "@langchain/langgraph";
        import { MessagesAnnotation } from "@langchain/langgraph";
        import { AIMessage } from "@langchain/core/messages";

        const state = MessagesAnnotation;

        const weatherState = Annotation.Root({
          ...state.spec,
          city: Annotation<string>,
        });

        const routerState = Annotation.Root({
          ...state.spec,
          route: Annotation<"weather" | "other">,
        });

        const weather = new StateGraph(weatherState)
          .addNode("model_node", (state) => {
            const llm = new AIMessage({
              content: "",
              tool_calls: [
                {
                  id: "tool_call123",
                  name: "get_weather",
                  args: { city: "San Francisco" },
                },
              ],
            });

            return { city: llm.tool_calls![0].args.city };
          })
          .addNode("weather_node", async (state) => {
            const result = \`It's sunny in $\{state.city}!\`;
            return { messages: [new AIMessage({ content: result })] };
          })
          .addEdge(START, "model_node")
          .addEdge("model_node", "weather_node")
          .addEdge("weather_node", END)
          .compile({ interruptBefore: ["weather_node"] });

        const router = new StateGraph(routerState)
          .addNode("router_node", async () => ({ route: "weather" }))
          .addNode("normal_llm_node", () => ({ messages: [new AIMessage("Hello")] }))
          .addNode("weather_graph", weather)
          .addEdge(START, "router_node")
          .addConditionalEdges(
            "router_node",
            ({ route }) => {
              if (route === "weather") return "weather_graph";
              return "normal_llm_node";
            },
            ["weather_graph", "normal_llm_node"]
          )
          .addEdge("weather_graph", END)
          .addEdge("normal_llm_node", END);

        export const graph = router.compile();
      `,
    },
    "graph",
  );

  expect(Object.keys(schemas)).toEqual(
    expect.arrayContaining(["graph", "graph|weather_graph"]),
  );
});

test.concurrent("nested", () => {
  const schemas = SubgraphExtractor.extractSchemas(
    {
      contents: dedent`
        import { Annotation, StateGraph, END, START } from "@langchain/langgraph";

        const child = new StateGraph(
          Annotation.Root({
            messages: Annotation<string[]>({
              reducer: (a, b) => a.concat(b),
            }),
            child: Annotation<"child_one" | "child_two">,
          })
        )
          .addNode("c_one", () => ({ messages: ["Entered c_one node"] }))
          .addNode("c_two", () => ({ messages: ["Entered c_two node"] }))
          .addEdge(START, "c_one")
          .addEdge("c_one", "c_two")
          .addEdge("c_two", END);

        const parent = new StateGraph(
          Annotation.Root({
            messages: Annotation<string[]>({
              reducer: (a, b) => a.concat(b),
            }),
            parent: Annotation<"parent_one" | "parent_two">,
          })
        )
          .addNode("p_one", () => ({ messages: ["Entered p_one node"] }))
          .addNode("p_two", child.compile())
          .addEdge(START, "p_one")
          .addEdge("p_one", "p_two")
          .addEdge("p_two", END);

        const grandParent = new StateGraph(
          Annotation.Root({
            messages: Annotation<string[]>({
              reducer: (a, b) => a.concat(b),
            }),
          })
        )
          .addNode("gp_one", () => ({ messages: ["Entered gp_one node"] }))
          .addNode("gp_two", parent.compile())
          .addEdge(START, "gp_one")
          .addEdge("gp_one", "gp_two")
          .addEdge("gp_two", END);

        export const graph = grandParent.compile();
      `,
    },
    "graph",
  );

  expect(Object.keys(schemas)).toEqual(
    expect.arrayContaining(["graph", "graph|gp_two", "graph|gp_two|p_two"]),
  );
});
