import { test, expect } from "@jest/globals";
import { ChatOpenAI } from "@langchain/openai";
import { graph } from "../index.js";
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
  try {
    const stream = await graph.stream(
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
        console.log("----CREATE VM INSTANCE----\n", {
          VMInstance: {
            instanceId: update.createVMInstance.instanceId,
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
              content: message.content.slice(0, 50) + "...",
            },
          });
        }
      }

      if (update.callModel) {
        if (update.callModel?.messages) {
          const message = update.callModel.messages;
          const toolOutputs = message.additional_kwargs?.tool_outputs?.[0];
          if (toolOutputs) {
            console.log("----CALL MODEL----\n", {
              ComputerCall: {
                ...toolOutputs.action,
                call_id: toolOutputs.call_id,
              },
            });
            continue;
          }
          console.log("----CALL MODEL----\n", {
            AIMessage: {
              content: message.content,
              ...(toolOutputs && {
                tool_outputs: {
                  type: toolOutputs.type,
                  action: JSON.stringify(toolOutputs.action, null, 2),
                  call_id: toolOutputs.call_id,
                },
              }),
            },
          });
        }
      }
    }
  } finally {
    if (instanceId) {
      console.log("Stopping instance with ID", instanceId);
      // await stopInstance(instanceId)
    }
  }
});
