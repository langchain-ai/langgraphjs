import type { Message } from "@langchain/langgraph-sdk";

export interface TraceEntry {
  id: string;
  kind: string;
  label: string;
  detail: string;
  timestamp: string;
  raw: unknown;
}

export interface SubagentCardData {
  id: string;
  title: string;
  status: string;
  messageCount: number;
  preview?: string;
}

export interface ProtocolPlaygroundProps {
  title: string;
  description: string;
  assistantId: string;
  apiUrl: string;
  threadId: string | null;
  protocolLabel: string;
  placeholder: string;
  suggestions: string[];
  messages: Message[];
  isLoading: boolean;
  error?: unknown;
  values?: unknown;
  metadata?: unknown;
  eventLog: TraceEntry[];
  subagents?: SubagentCardData[];
  onSubmit: (content: string) => void;
  getMessageMetadata?: (message: Message) => unknown;
}
