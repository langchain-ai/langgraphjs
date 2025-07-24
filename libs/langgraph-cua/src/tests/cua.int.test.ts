import { test, expect } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { createCua } from "../index.js";
import { stopInstance } from "../utils.js";

test.skip("Can invoke the computer preview model", async () => {
  const model = new ChatOpenAI({
    model: "computer-use-preview",
    useResponsesApi: true,
  })
    .bindTools([
      {
        type: "computer-preview",
        display_width: 768,
        display_height: 1024,
        environment: "browser",
      },
    ])
    .bind({
      truncation: "auto",
    });

  const response = await model.invoke([
    {
      role: "system",
      content:
        "You're an advanced AI computer use assistant. The browser you are using is already initialized, and visiting google.com.",
    },
    {
      role: "user",
      content:
        "I'm looking for a new camera. Help me find the best one. It should be 4k resolution, by Cannon, and under $1000. I want a digital camera, and I'll be using it mainly for photography.",
    },
  ]);

  console.dir(response, { depth: Infinity });

  expect(response).toBeDefined();
});

test("It can use the agent to interact with the browser", async () => {
  let instanceId: string | undefined;
  const cuaGraph = createCua();
  try {
    const stream = await cuaGraph.stream(
      {
        messages: [
          {
            role: "system",
            content:
              "You're an advanced AI computer use assistant. The browser you are using is already initialized, and visiting google.com.",
          },
          {
            role: "user",
            content:
              "I'm looking for a new camera. Help me find the best one. It should be 4k resolution, by Cannon, and under $1000. I want a digital camera, and I'll be using it mainly for photography.",
          },
        ],
      },
      {
        streamMode: "updates",
      }
    );

    for await (const update of stream) {
      if (update.createVMInstance) {
        instanceId = update.createVMInstance.instanceId;
        console.log("----CREATE VM INSTANCE----\n", {
          VMInstance: {
            instanceId,
            streamUrl: update.createVMInstance.streamUrl,
          },
        });
      }

      if (update.takeComputerAction) {
        if (update.takeComputerAction?.messages?.[0]) {
          const message = update.takeComputerAction.messages[0];
          console.log("----TAKE COMPUTER ACTION----\n", {
            ToolMessage: {
              type: message.additional_kwargs?.type,
              tool_call_id: message.tool_call_id,
              content: `${message.content.slice(0, 50)}...`,
            },
          });
        }
      }

      if (update.callModel) {
        if (update.callModel?.messages) {
          const message = update.callModel.messages;
          const allOutputs = message.additional_kwargs?.tool_outputs;
          if (allOutputs?.length) {
            const output = allOutputs[allOutputs.length - 1];
            console.log("----CALL MODEL----\n", {
              ComputerCall: {
                ...output.action,
                call_id: output.call_id,
              },
            });
            continue;
          }
          console.log("----CALL MODEL----\n", {
            AIMessage: {
              content: message.content,
            },
          });
        }
      }
    }
  } finally {
    if (instanceId) {
      console.log("Stopping instance with ID", instanceId);
      await stopInstance(instanceId);
    }
  }
});
