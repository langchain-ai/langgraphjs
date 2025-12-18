import { Check, X, Mail, Trash2, FileText, ShieldAlert } from "lucide-react";
import type { ToolCallWithResult } from "@langchain/langgraph-sdk/react";

import type { AgentToolCalls } from "../types";

/**
 * Tool call card component for completed/pending tools
 */
export function ToolCallCard({
  toolCall,
}: {
  toolCall: ToolCallWithResult<AgentToolCalls>;
}) {
  const { call, result, state } = toolCall;
  const isLoading = state === "pending";

  const getIcon = () => {
    switch (call.name) {
      case "send_email":
        return <Mail className="w-4 h-4 text-brand-accent" />;
      case "delete_file":
        return <Trash2 className="w-4 h-4 text-red-400" />;
      case "read_file":
        return <FileText className="w-4 h-4 text-blue-400" />;
      default:
        return <ShieldAlert className="w-4 h-4 text-neutral-400" />;
    }
  };

  const parsedResult = result
    ? typeof result.content === "string"
      ? result.content.startsWith("{")
        ? JSON.parse(result.content as string)
        : (result as { status: string; content: string })
      : { status: "success", content: result.content }
    : { status: "pending", content: "" };

  const getTitle = () => {
    switch (call.name) {
      case "send_email":
        return parsedResult.status === "success"
          ? "Email Sent"
          : "Email Sent Rejected";
      case "delete_file":
        return parsedResult.status === "success"
          ? "File Deleted"
          : "File Deletion Rejected";
      case "read_file":
        return parsedResult.status === "success"
          ? "File Read"
          : "File Read Rejected";
      default:
        throw new Error(`Unknown tool call: ${JSON.stringify(call)}`);
    }
  };

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800 animate-fade-in">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center justify-center">
          {getIcon()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white">{getTitle()}</div>
          <div className="text-xs text-neutral-500">
            {isLoading ? "Processing..." : "Completed"}
          </div>
        </div>
        {parsedResult.status === "success" ? (
          <Check className="w-4 h-4 text-green-400" />
        ) : parsedResult.status === "error" ? (
          <X className="w-4 h-4 text-red-400" />
        ) : null}
      </div>

      {result && (
        <div className="text-sm rounded-lg p-3 bg-black border border-neutral-800 text-neutral-300">
          {parsedResult.content}
        </div>
      )}
    </div>
  );
}
