import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  onStopMutate: (prev: Record<string, unknown>) => Record<string, unknown>;
}

export function StopFunctionalStream({
  apiUrl,
  assistantId = "agent",
  onStopMutate,
}: Props) {
  const { values, isLoading, submit, stop } = useStream({
    assistantId,
    apiUrl,
    initialValues: {
      counter: 5,
      items: ["item1", "item2"],
    },
    onStop: ({ mutate }) => {
      mutate(onStopMutate);
    },
  });

  return (
    <div>
      <div data-testid="loading">
        {isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="counter">{(values).counter}</div>
      <div data-testid="items">{(values).items?.join(", ")}</div>
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
