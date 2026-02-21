import type { UseStreamOptions } from "@langchain/langgraph-sdk/ui";

import { useStream } from "../../index.js";

interface Props {
  options: UseStreamOptions<Record<string, unknown>, Record<string, never>>;
}

export function InitialValuesStream({ options }: Props) {
  const { messages, values, submit } = useStream(options);

  return (
    <div>
      <div data-testid="messages">
        {messages.map((msg, i) => (
          <div
            key={msg.id ?? i}
            data-testid={
              msg.id?.includes("cached")
                ? `message-cached-${i}`
                : `message-${i}`
            }
          >
            {typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)}
          </div>
        ))}
      </div>
      <div data-testid="values">{JSON.stringify(values)}</div>
      <button
        data-testid="submit"
        onClick={() =>
          void submit({
            messages: [{ content: "Hello", type: "human" }],
          })
        }
      >
        Submit
      </button>
    </div>
  );
}
