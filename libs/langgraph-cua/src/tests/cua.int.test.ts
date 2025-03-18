import { test, expect } from "@jest/globals";
import { ChatOpenAI } from "@langchain/openai";
import { graph } from "../index.js";

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
      streamMode: ["custom", "updates"],
    }
  );

  for await (const update of stream) {
    if (Array.isArray(update)) {
      if (update[0] === "custom") {
        console.log("\n---CUSTOM---\n");
        console.log(update[1]);
      } else {
        console.log("\n---UPDATE---\n");
        if ("callModel" in update[1]) {
          const messages = update[1].callModel?.messages;
          console.dir(
            {
              additional_kwargs: messages?.additional_kwargs,
              content: messages?.content,
            },
            { depth: Infinity }
          );
        } else if ("takeComputerAction" in update[1]) {
          const computerCallOutput =
            update[1].takeComputerAction?.computerCallOutput;
          console.dir(
            {
              computerCallOutput: {
                ...computerCallOutput,
                output: {
                  ...computerCallOutput?.output,
                  image_url: computerCallOutput?.output?.image_url?.slice(
                    0,
                    100
                  ),
                },
              },
            },
            { depth: Infinity }
          );
        } else {
          console.dir(update[1], { depth: Infinity });
        }
      }
    } else {
      console.log("\n---UPDATE (not array)---\n");
      console.dir(update, { depth: Infinity });
    }
  }
});
