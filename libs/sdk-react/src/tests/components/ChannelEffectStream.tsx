import { useState } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream, useChannelEffect, type Channel } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  channels?: Channel[];
  enabled?: boolean;
}

interface StreamState {
  messages: BaseMessage[];
}

/**
 * Exercises {@link useChannelEffect}: every raw event observed on the
 * requested channels is pushed into component state so the test can
 * assert on the delivered count / order without the hook itself
 * returning a value.
 */
export function ChannelEffectStream({
  apiUrl,
  assistantId = "custom_channel_graph",
  channels = ["custom"],
  enabled = true,
}: Props) {
  const stream = useStream<StreamState>({ assistantId, apiUrl });
  const [count, setCount] = useState(0);
  const [methods, setMethods] = useState<string[]>([]);

  useChannelEffect(stream, channels, {
    enabled,
    replay: false,
    onEvent(event) {
      setCount((value) => value + 1);
      setMethods((value) => [...value, event.method ?? ""]);
    },
  });

  return (
    <div>
      <div data-testid="loading">
        {stream.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="effect-count">{count}</div>
      <div data-testid="effect-methods">{methods.join(",")}</div>
      <button
        data-testid="submit"
        onClick={() =>
          void stream.submit({
            messages: [new HumanMessage("Trigger custom writer")],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
