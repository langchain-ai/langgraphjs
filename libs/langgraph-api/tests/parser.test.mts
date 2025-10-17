import { describe, expect, test } from "vitest";

import { SubgraphExtractor } from "../src/graph/parser/parser.mjs";
import dedent from "dedent";

test.concurrent("graph factories", { timeout: 30_000 }, () => {
  const MessagesSchema = {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: {
          $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
        },
      },
    },
    definitions: {
      "BaseMessage<MessageStructure,MessageType>": { type: "object" },
    },
    $schema: "http://json-schema.org/draft-07/schema#",
  };

  const ConfigSchema = {
    type: "object",
    $schema: "http://json-schema.org/draft-07/schema#",
  };

  const testCases = [
    "builder.compile()", // CompiledGraph,
    "() => builder.compile()", // () => CompiledGraph,
    "builder", // Graph,
    "() => builder", // () => Graph,

    "(async () => builder)()", // Promise<CompiledGraph>,
    "async () => builder.compile()", // () => Promise<CompiledGraph>,
    "(async () => builder)()", // Promise<Graph>,
    "async () => builder", // () => Promise<Graph>,
  ];

  const schemas = SubgraphExtractor.extractSchemas(
    testCases.map((prop, idx) => ({
      sourceFile: [
        {
          path: `graph_${idx}.mts`,
          main: true,
          contents: dedent`
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

            export const graph = ${prop};
          `,
        },
      ],
      exportSymbol: "graph",
    }))
  );

  for (const schema of schemas) {
    expect.soft(schema.graph.input).toMatchObject(MessagesSchema);
    expect.soft(schema.graph.output).toMatchObject(MessagesSchema);
    expect.soft(schema.graph.state).toMatchObject(MessagesSchema);
    expect.soft(schema.graph.config).toEqual(ConfigSchema);
  }
});

describe.concurrent("subgraphs", { timeout: 30_000 }, () => {
  test.concurrent(`basic`, () => {
    const testCases = [
      "subgraph",
      "(state) => subgraph.invoke(state)",
      "async (state) => await subgraph.invoke(state)",
    ];

    const schemasList = SubgraphExtractor.extractSchemas(
      testCases.map((nodeDef) => ({
        exportSymbol: "graph",
        sourceFile: [
          {
            main: true,
            path: "graph.mts",
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
        ],
      }))
    );

    for (const schemas of schemasList) {
      expect(schemas["graph|child"].input).toMatchObject({
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: expect.arrayContaining(["weather", "other"]),
          },
          messages: {
            type: "array",
            items: {
              $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
            },
          },
        },
        definitions: {
          "BaseMessage<MessageStructure,MessageType>": { type: "object" },
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
            items: {
              $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
            },
          },
        },
        definitions: {
          "BaseMessage<MessageStructure,MessageType>": {
            type: "object",
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
            items: {
              $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
            },
          },
        },
        definitions: {
          "BaseMessage<MessageStructure,MessageType>": {
            type: "object",
          },
        },
        $schema: "http://json-schema.org/draft-07/schema#",
      });

      expect(schemas["graph|child"].config).toMatchObject({
        type: "object",
        $schema: "http://json-schema.org/draft-07/schema#",
      });
    }
  });

  test.concurrent("nested subgraphs", () => {
    const schemas = SubgraphExtractor.extractSchemas([
      {
        sourceFile: [
          {
            path: "graph.mts",
            main: true,
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
                .addNode("subchild-one", () => ({ messages: [new HumanMessage("subchild-one")] }))
                .addNode("subchild-two", () => ({ messages: [new HumanMessage("subchild-two")] }))
                .addEdge("__start__", "subchild-one")
                .addEdge("subchild-one", "subchild-two")
                .compile();
          
              const child = new StateGraph(ChildSchema)
                .addNode("child-one", () => ({ messages: [new HumanMessage("child-one")] }))
                .addNode("child-two", subchild)
                .addEdge("__start__", "child-one")
                .addEdge("child-one", "child-two")
                .compile();
          
              export const parent = new StateGraph(ParentSchema)
                .addNode("parent-one", () => ({ messages: [new HumanMessage("parent-one")] }))
                .addNode("parent-two", child)
                .addEdge("__start__", "parent-one")
                .addEdge("parent-one", "parent-two")
                .compile();
            `,
          },
        ],
        exportSymbol: "parent",
      },
    ]);

    const schema = schemas[0];
    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining([
        "parent",
        "parent|parent-two",
        "parent|parent-two|child-two",
      ])
    );

    expect(schema["parent"].state).toMatchObject({
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": {
          type: "object",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schema["parent|parent-two"].state).toMatchObject({
      type: "object",
      properties: {
        child: {
          type: "string",
          enum: expect.arrayContaining(["alpha", "beta"]),
        },
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": { type: "object" },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schema["parent|parent-two|child-two"].state).toMatchObject({
      type: "object",
      properties: {
        subchild: {
          type: "string",
          enum: expect.arrayContaining(["one", "two"]),
        },
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": {
          type: "object",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  test.concurrent("multiple subgraphs within a single node", () => {
    expect(() => {
      SubgraphExtractor.extractSchemas(
        [
          {
            sourceFile: [
              {
                path: "graph.mts",
                main: true,
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
            ],
            exportSymbol: "parent",
          },
        ],
        { strict: true }
      );
    }).toThrowError(
      `Multiple unique subgraph invocations found for "parent|parent_one"`
    );
  });

  test.concurrent("imported subgraphs", () => {
    const schemas = SubgraphExtractor.extractSchemas([
      {
        sourceFile: [
          {
            path: "graph.mts",
            main: true,
            contents: dedent`
              import { HumanMessage } from "@langchain/core/messages";
              import { subgraph } from "./subgraph.mjs";
              import {
                MessagesAnnotation,
                StateGraph,
              } from "@langchain/langgraph";

              const ParentSchema = MessagesAnnotation;
              
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
          },
          {
            path: "./subgraph.mts",
            contents: dedent`
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
          },
        ],
        exportSymbol: "graph",
      },
    ]);

    const schema = schemas[0];
    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining(["graph", "graph|child"])
    );

    expect(schema["graph|child"].input).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": {
          type: "object",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schema["graph|child"].output).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": {
          type: "object",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schema["graph|child"].state).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": {
          type: "object",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schema["graph|child"].config).toMatchObject({
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  test.concurrent("imported uncompiled subgraphs", () => {
    const schemas = SubgraphExtractor.extractSchemas([
      {
        sourceFile: [
          {
            path: "graph.mts",
            main: true,
            contents: dedent`
              import { HumanMessage } from "@langchain/core/messages";
              import { subgraph } from "./subgraph.mjs";
              import {
                MessagesAnnotation,
                StateGraph,
              } from "@langchain/langgraph";
        
              const ParentSchema = MessagesAnnotation;
        
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
          },
          {
            path: "./subgraph.mts",
            contents: dedent`
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
          },
        ],
        exportSymbol: "graph",
      },
    ]);

    const schema = schemas[0];
    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining(["graph", "graph|child"])
    );

    expect(schema["graph|child"].input).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": {
          type: "object",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schema["graph|child"].output).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": {
          type: "object",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schema["graph|child"].state).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": {
          type: "object",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schema["graph|child"].config).toMatchObject({
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  test.concurrent("indirect", () => {
    const schemas = SubgraphExtractor.extractSchemas([
      {
        sourceFile: [
          {
            path: "graph.mts",
            main: true,
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

            // @ts-ignore
            const indirect2 = (() => indirect1)()
            export const graph = parent.compile() 
          `,
          },
        ],
        exportSymbol: "graph",
      },
    ]);
    const schema = schemas[0];
    expect(schema["graph|child"].input).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": {
          type: "object",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schema["graph|child"].output).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": {
          type: "object",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schema["graph|child"].state).toMatchObject({
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: expect.arrayContaining(["weather", "other"]),
        },
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
      },
      definitions: {
        "BaseMessage<MessageStructure,MessageType>": {
          type: "object",
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schema["graph|child"].config).toMatchObject({
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });
});

test.concurrent("weather", { timeout: 30_000 }, () => {
  const schemas = SubgraphExtractor.extractSchemas([
    {
      sourceFile: [
        {
          path: "graph.mts",
          main: true,
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

                return { city: llm.tool_calls![0].args.city as string };
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
      ],
      exportSymbol: "graph",
    },
  ]);

  const schema = schemas[0];
  expect(Object.keys(schema)).toEqual(
    expect.arrayContaining(["graph", "graph|weather_graph"])
  );
});

test.concurrent("nested", { timeout: 30_000 }, () => {
  const schemas = SubgraphExtractor.extractSchemas([
    {
      sourceFile: [
        {
          path: "graph.mts",
          main: true,
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
      ],
      exportSymbol: "graph",
    },
  ]);

  const schema = schemas[0];
  expect(Object.keys(schema)).toEqual(
    expect.arrayContaining(["graph", "graph|gp_two", "graph|gp_two|p_two"])
  );
});

test.concurrent(
  "overlapping parallel schema inference",
  { timeout: 30_000 },
  () => {
    const schemas = SubgraphExtractor.extractSchemas([
      {
        exportSymbol: "graph",
        sourceFile: [
          {
            path: "graph1/graph.mts",
            main: true,
            contents: dedent`
            import { Annotation, StateGraph, END, START } from "@langchain/langgraph";
            export const graph = new StateGraph(
              Annotation.Root({ messages: Annotation<string[]>({ reducer: (a, b) => a.concat(b) }) }),
              Annotation.Root({ graph1: Annotation<string> })
            )
              .addNode("child", (state) => state)
              .addEdge(START, "child")
              .addEdge("child", END)
              .compile();
          `,
          },
        ],
      },
      {
        exportSymbol: "graph",
        sourceFile: [
          {
            path: "graph2/graph.mts",
            main: true,
            contents: dedent`
            import { Annotation, StateGraph, END, START } from "@langchain/langgraph";
            export const graph = new StateGraph(
              Annotation.Root({ random: Annotation<string[]>({ reducer: (a, b) => a.concat(b) }) }),
              Annotation.Root({ graph2: Annotation<string> })
            )
              .addNode("child", (state) => state)
              .addEdge(START, "child")
              .addEdge("child", END)
              .compile();
          `,
          },
        ],
      },
    ]);

    expect(schemas).toMatchObject([
      {
        graph: {
          config: {
            type: "object",
            $schema: "http://json-schema.org/draft-07/schema#",
            properties: { graph1: { type: "string" } },
          },
        },
      },
      {
        graph: {
          config: {
            type: "object",
            $schema: "http://json-schema.org/draft-07/schema#",
            properties: { graph2: { type: "string" } },
          },
        },
      },
    ]);
  }
);

test.concurrent("`strictFunctionTypes: false`", { timeout: 30_000 }, () => {
  const schemas = SubgraphExtractor.extractSchemas(
    [
      {
        sourceFile: [
          {
            path: "graph.mts",
            main: true,
            contents: dedent`
              import { StateGraph, MessagesAnnotation, Annotation, START, END } from "@langchain/langgraph";

              export const graph = new StateGraph(Annotation.Root({
                messages: MessagesAnnotation.spec.messages,
                state: Annotation<string>,
              }))
                .addNode("node", () => ({}))
                .addEdge(START, "node")
                .addEdge("node", END)
                .compile();
            `,
          },
        ],
        exportSymbol: "graph",
      },
    ],
    { tsConfigOptions: { strictFunctionTypes: false } }
  );

  const schema = schemas[0];
  expect(schema.graph).toMatchObject({
    state: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            $ref: "#/definitions/BaseMessage<MessageStructure,MessageType>",
          },
        },
        state: { type: "string" },
      },
    },
  });
});
