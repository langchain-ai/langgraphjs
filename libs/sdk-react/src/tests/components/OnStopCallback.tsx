import { useState } from "react";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
}

export function OnStopCallback({ apiUrl, assistantId = "agent" }: Props) {
  const [onStopCalled, setOnStopCalled] = useState(false);
  const [hasMutate, setHasMutate] = useState(false);

  const { submit, stop } = useStream({
    assistantId,
    apiUrl,
    onStop: (arg) => {
      setOnStopCalled(true);
      setHasMutate(typeof arg.mutate === "function");
    },
  });

  return (
    <div>
      <div data-testid="onstop-called">{onStopCalled ? "Yes" : "No"}</div>
      <div data-testid="has-mutate">{hasMutate ? "Yes" : "No"}</div>
      <button
        data-testid="submit"
        onClick={() => void submit({})}
      >
        Send
      </button>
      <button data-testid="stop" onClick={() => void stop()}>
        Stop
      </button>
    </div>
  );
}
