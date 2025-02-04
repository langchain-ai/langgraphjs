import {
  PromptTemplate,
  AIMessagePromptTemplate,
  ChatMessagePromptTemplate,
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  MessagesPlaceholder,
  SystemMessagePromptTemplate,
  ImagePromptTemplate,
  PipelinePromptTemplate,
} from "@langchain/core/prompts";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  BaseMessageChunk,
  ChatMessage,
  ChatMessageChunk,
  FunctionMessage,
  FunctionMessageChunk,
  HumanMessage,
  HumanMessageChunk,
  SystemMessage,
  SystemMessageChunk,
  ToolMessage,
  ToolMessageChunk,
} from "@langchain/core/messages";
import { StringPromptValue } from "@langchain/core/prompt_values";

export const prompts__prompt = {
  PromptTemplate,
};

export const schema__messages = {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  BaseMessageChunk,
  ChatMessage,
  ChatMessageChunk,
  FunctionMessage,
  FunctionMessageChunk,
  HumanMessage,
  HumanMessageChunk,
  SystemMessage,
  SystemMessageChunk,
  ToolMessage,
  ToolMessageChunk,
};

export const schema = {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  BaseMessageChunk,
  ChatMessage,
  ChatMessageChunk,
  FunctionMessage,
  FunctionMessageChunk,
  HumanMessage,
  HumanMessageChunk,
  SystemMessage,
  SystemMessageChunk,
  ToolMessage,
  ToolMessageChunk,
};

export const prompts__chat = {
  AIMessagePromptTemplate,
  ChatMessagePromptTemplate,
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  MessagesPlaceholder,
  SystemMessagePromptTemplate,
};
export const prompts__image = {
  ImagePromptTemplate,
};
export const prompts__pipeline = {
  PipelinePromptTemplate,
};

export const prompts__base = {
  StringPromptValue,
};
