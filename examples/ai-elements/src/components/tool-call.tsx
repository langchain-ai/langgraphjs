import type { ToolUIPart } from "ai";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "./ai-elements/tool";

interface ToolCallProps {
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  isStreaming?: boolean;
}

export function ToolCall({
  toolName,
  input,
  output,
  error,
  isStreaming,
}: ToolCallProps) {
  const state: ToolUIPart["state"] = error
    ? "output-error"
    : output !== undefined
      ? "output-available"
      : isStreaming
        ? "input-streaming"
        : "input-available";

  const hasResult = state === "output-available" || state === "output-error";

  return (
    <Tool defaultOpen={hasResult}>
      <ToolHeader
        type={`tool-${toolName}` as ToolUIPart["type"]}
        state={state}
      />
      <ToolContent>
        <ToolInput input={input} />
        {hasResult && <ToolOutput output={output} errorText={error} />}
      </ToolContent>
    </Tool>
  );
}
