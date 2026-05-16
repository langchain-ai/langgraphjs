import type { ToolCallWithResult } from "@langchain/react";

import { LocationToolResult, readLocationResult } from "./LocationToolResult";
import {
  getToolInputPreview,
  getToolResultPreview,
  getToolTagValues,
  getToolTheme,
  getToolTitle,
} from "./toolCardUtils";
import type { MessageFeedToolCall } from "./toolCalls";

export function ToolCallCard({
  toolCall,
}: {
  toolCall: ToolCallWithResult<MessageFeedToolCall>;
}) {
  const inputPreview = getToolInputPreview(toolCall.call.name, toolCall.call.args);
  const resultPreview = getToolResultPreview(toolCall.call.name, toolCall.result);
  const locationResult =
    toolCall.call.name === "geolocation_get"
      ? readLocationResult(toolCall.result?.content)
      : undefined;
  const tags = getToolTagValues(
    toolCall.call.name,
    toolCall.call.args,
    toolCall.result?.content
  );

  return (
    <section className={`tool-card tool-card-${getToolTheme(toolCall.call.name)}`}>
      <div className="tool-card-header">
        <div>
          <div className="tool-card-title">{getToolTitle(toolCall.call.name)}</div>
          <div className="tool-card-name">{toolCall.call.name}</div>
        </div>
        <span className={`status-pill status-${toolCall.state}`}>
          {toolCall.state}
        </span>
      </div>

      {tags.length > 0 ? (
        <div className="tool-card-tags">
          {tags.map((tag) => (
            <span key={tag} className="tool-card-tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {inputPreview != null ? (
        <div className="tool-card-section">
          <div className="tool-card-section-label">{inputPreview.label}</div>
          {inputPreview.isCode ? (
            <pre className="tool-card-code">{inputPreview.value}</pre>
          ) : (
            <div className="tool-card-copy">{inputPreview.value}</div>
          )}
        </div>
      ) : null}

      {locationResult != null ? (
        <div className="tool-card-section">
          <div className="tool-card-section-label">Map Result</div>
          <LocationToolResult result={locationResult} />
        </div>
      ) : resultPreview != null ? (
        <div className="tool-card-section">
          <div className="tool-card-section-label">{resultPreview.label}</div>
          <div className="tool-card-copy">{resultPreview.value}</div>
        </div>
      ) : null}
    </section>
  );
}
