import type { CSSProperties } from "react";

import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";

import { safeStringify } from "../utils";

const jsonViewTheme = {
  ...darkTheme,
  backgroundColor: "transparent",
  fontSize: "0.84rem",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
} satisfies CSSProperties;

interface JsonPanelProps {
  title: string;
  value: unknown;
}

export function JsonPanel({ title, value }: JsonPanelProps) {
  const isTreeValue = typeof value === "object" && value !== null;

  return (
    <section className="panel-card">
      <div className="panel-card-header">
        <h3>{title}</h3>
      </div>
      {value == null ? (
        <div className="empty-panel">No data yet.</div>
      ) : isTreeValue ? (
        <div className="json-panel">
          <JsonView
            collapsed={2}
            displayDataTypes={false}
            displayObjectSize={false}
            enableClipboard={false}
            shortenTextAfterLength={80}
            style={jsonViewTheme}
            value={value}
          />
        </div>
      ) : (
        <pre className="json-panel">{safeStringify(value)}</pre>
      )}
    </section>
  );
}
