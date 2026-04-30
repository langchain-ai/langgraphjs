import type { ContentBlockStartData, UpdatesEvent } from "../types.mjs";
import { isRecord } from "./internal-types.mjs";
import {
  getTupleToolCallArgs,
  getTupleToolCallIdentity,
  normalizeFinalToolCallArgs,
} from "./tool-calls.mjs";

const PROTOCOL_STATE_MESSAGE_TYPES = new Set([
  "human",
  "user",
  "ai",
  "assistant",
  "system",
  "tool",
  "function",
  "remove",
]);

const MIME_TYPE_BY_AUDIO_FORMAT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm16: "audio/wav",
  pcm: "audio/wav",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
};

const PROTOCOL_CONTENT_BLOCK_TYPES = new Set([
  "text",
  "reasoning",
  "tool_call",
  "tool_call_chunk",
  "invalid_tool_call",
  "server_tool_call",
  "server_tool_call_chunk",
  "server_tool_call_result",
  "image",
  "audio",
  "video",
  "file",
  "non_standard",
]);

const normalizeAudioBlockFromAdditionalKwargs = (
  additionalKwargs: Record<string, unknown> | undefined
) => {
  const audio = isRecord(additionalKwargs?.audio)
    ? additionalKwargs.audio
    : undefined;
  if (audio == null) return undefined;

  const data = typeof audio.data === "string" ? audio.data : undefined;
  const url = typeof audio.url === "string" ? audio.url : undefined;
  if (data == null && url == null) return undefined;

  const explicitMimeType =
    typeof audio.mime_type === "string"
      ? audio.mime_type
      : typeof audio.mimeType === "string"
        ? audio.mimeType
        : undefined;

  const format =
    typeof audio.format === "string"
      ? audio.format.toLowerCase()
      : explicitMimeType != null
        ? undefined
        : "wav";

  return {
    type: "audio",
    ...(typeof audio.id === "string" ? { id: audio.id } : {}),
    ...(url != null ? { url } : {}),
    ...(data != null ? { data } : {}),
    ...(explicitMimeType != null
      ? { mime_type: explicitMimeType }
      : format != null && MIME_TYPE_BY_AUDIO_FORMAT[format] != null
        ? { mime_type: MIME_TYPE_BY_AUDIO_FORMAT[format] }
        : {}),
    ...(typeof audio.transcript === "string"
      ? { transcript: audio.transcript }
      : {}),
  } satisfies ContentBlockStartData["content"];
};

const MEDIA_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "image",
  "audio",
  "video",
  "file",
]);

const MIME_TYPE_BY_IMAGE_FORMAT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Extracts OpenAI Responses API `image_generation_call` outputs from
 * `additional_kwargs.tool_outputs` as protocol-shaped image blocks. These
 * outputs carry base64 image payloads that do not appear in
 * `message.content`, so we lift them into standard blocks for downstream
 * consumers (including synthetic subagent emission on the public namespace).
 *
 * @param additionalKwargs - The message's `additional_kwargs` record.
 * @returns An array of image blocks in the order they appear, or `[]`.
 */
const normalizeImageBlocksFromAdditionalKwargs = (
  additionalKwargs: Record<string, unknown> | undefined
): ContentBlockStartData["content"][] => {
  const toolOutputs = additionalKwargs?.tool_outputs;
  if (!Array.isArray(toolOutputs)) return [];

  const blocks: ContentBlockStartData["content"][] = [];
  for (const entry of toolOutputs) {
    if (!isRecord(entry) || entry.type !== "image_generation_call") continue;
    const data = typeof entry.result === "string" ? entry.result : undefined;
    const url = typeof entry.url === "string" ? entry.url : undefined;
    if (data == null && url == null) continue;

    const outputFormat =
      typeof entry.output_format === "string"
        ? entry.output_format.toLowerCase()
        : undefined;
    const mimeType =
      (outputFormat != null
        ? MIME_TYPE_BY_IMAGE_FORMAT[outputFormat]
        : undefined) ?? "image/png";

    blocks.push({
      type: "image",
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      ...(url != null ? { url } : {}),
      ...(data != null ? { data } : {}),
      mime_type: mimeType,
    } satisfies ContentBlockStartData["content"]);
  }
  return blocks;
};

/**
 * Converts common camelCase field names produced by LangChain content blocks
 * (e.g. `mimeType`) into the snake_case shape mandated by the protocol
 * (`mime_type`). This keeps media blocks emitted by providers such as
 * `ChatOpenAI` (Responses API `image_generation` tool) readable by downstream
 * clients without requiring each provider to opt into protocol casing.
 */
const normalizeMediaBlockCasing = (
  block: Record<string, unknown>
): Record<string, unknown> => {
  if (!MEDIA_BLOCK_TYPES.has(block.type as string)) return block;

  const { mimeType, ...rest } = block as {
    mimeType?: unknown;
    [k: string]: unknown;
  };
  if (typeof mimeType !== "string") return block;
  if (typeof rest.mime_type === "string") return rest;
  return { ...rest, mime_type: mimeType };
};

export const normalizeProtocolContentBlock = (
  value: unknown
): ContentBlockStartData["content"] | undefined => {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;

  if (PROTOCOL_CONTENT_BLOCK_TYPES.has(value.type)) {
    return normalizeMediaBlockCasing(value) as ContentBlockStartData["content"];
  }

  if (value.type === "image_url") {
    const rawImage = value.image_url;
    if (typeof rawImage === "string") {
      return { type: "image", url: rawImage };
    }
    if (isRecord(rawImage) && typeof rawImage.url === "string") {
      return {
        type: "image",
        url: rawImage.url,
      };
    }
    return undefined;
  }

  if (value.type === "input_audio") {
    const rawAudio = isRecord(value.input_audio)
      ? value.input_audio
      : undefined;
    if (rawAudio == null) return undefined;
    return {
      type: "audio",
      ...(typeof rawAudio.data === "string" ? { data: rawAudio.data } : {}),
      ...(typeof rawAudio.mimeType === "string"
        ? { mimeType: rawAudio.mimeType }
        : {}),
    };
  }

  return {
    type: "non_standard",
    value: { ...value },
  };
};

export const normalizeProtocolMessageContent = (
  content: unknown,
  options?: { additionalKwargs?: Record<string, unknown> }
) => {
  const additionalKwargs = options?.additionalKwargs;
  const extractExtras = () => {
    const audioBlock =
      normalizeAudioBlockFromAdditionalKwargs(additionalKwargs);
    const imageBlocks =
      normalizeImageBlocksFromAdditionalKwargs(additionalKwargs);
    return { audioBlock, imageBlocks };
  };

  if (typeof content === "string") {
    const { audioBlock, imageBlocks } = extractExtras();
    if (audioBlock == null && imageBlocks.length === 0) return content;

    const blocks: ContentBlockStartData["content"][] = [];
    if (content.length > 0) {
      blocks.push({ type: "text", text: content });
    }
    blocks.push(...imageBlocks);
    if (audioBlock != null) blocks.push(audioBlock);
    return blocks;
  }

  if (!Array.isArray(content)) {
    const { audioBlock, imageBlocks } = extractExtras();
    if (audioBlock == null && imageBlocks.length === 0) return content;
    const blocks: ContentBlockStartData["content"][] = [...imageBlocks];
    if (audioBlock != null) blocks.push(audioBlock);
    return blocks;
  }

  const blocks: ContentBlockStartData["content"][] = [];
  for (const entry of content) {
    if (typeof entry === "string") {
      blocks.push({ type: "text", text: entry });
      continue;
    }
    const normalized = normalizeProtocolContentBlock(entry);
    if (normalized != null) {
      blocks.push(normalized);
    }
  }

  const { audioBlock, imageBlocks } = extractExtras();
  for (const imageBlock of imageBlocks) {
    const imageId = (imageBlock as { id?: string }).id;
    const hasMatchingImage = blocks.some(
      (block) =>
        block.type === "image" &&
        (block as { id?: string }).id === imageId &&
        imageId != null
    );
    if (!hasMatchingImage) blocks.push(imageBlock);
  }
  if (audioBlock != null && !blocks.some((block) => block.type === "audio")) {
    blocks.push(audioBlock);
  }

  return blocks.length > 0 ? blocks : content;
};

/**
 * Normalizes protocol message type aliases into LangChain core message types.
 *
 * @param value - Raw message type.
 * @returns The normalized message type, if recognized.
 */
export const normalizeProtocolStateMessageType = (value: unknown) => {
  switch (value) {
    case "assistant":
      return "ai";
    case "user":
      return "human";
    default:
      return typeof value === "string" ? value : undefined;
  }
};

/**
 * Checks whether a value matches the message shape used in state payloads.
 *
 * @param value - Raw state value.
 * @returns Whether the value is a protocol-state message object.
 */
export const isProtocolStateMessage = (
  value: unknown
): value is Record<string, unknown> =>
  isRecord(value) &&
  PROTOCOL_STATE_MESSAGE_TYPES.has(
    normalizeProtocolStateMessageType(value.type) ?? ""
  );

/**
 * Normalizes invalid tool calls embedded in serialized AI messages.
 *
 * @param value - Raw invalid tool call list.
 * @returns Normalized invalid tool calls.
 */
export const normalizeProtocolStateInvalidToolCalls = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  const invalidToolCalls: Record<string, unknown>[] = [];
  for (const rawInvalidToolCall of value) {
    if (!isRecord(rawInvalidToolCall)) continue;

    const identity = getTupleToolCallIdentity(rawInvalidToolCall);
    invalidToolCalls.push({
      ...(identity.id != null ? { id: identity.id } : {}),
      ...(identity.name != null ? { name: identity.name } : {}),
      ...(typeof rawInvalidToolCall.args === "string"
        ? { args: rawInvalidToolCall.args }
        : {}),
      error:
        typeof rawInvalidToolCall.error === "string"
          ? rawInvalidToolCall.error
          : "Malformed args.",
      type: "invalid_tool_call",
    });
  }

  return invalidToolCalls;
};

/**
 * Normalizes tool calls embedded in serialized AI messages.
 *
 * @param value - Raw tool call list.
 * @returns Normalized valid and invalid tool call arrays.
 */
export const normalizeProtocolStateToolCalls = (value: unknown) => {
  if (!Array.isArray(value)) {
    return {
      toolCalls: [] as Record<string, unknown>[],
      invalidToolCalls: [] as Record<string, unknown>[],
    };
  }

  const toolCalls: Record<string, unknown>[] = [];
  const invalidToolCalls: Record<string, unknown>[] = [];

  for (const rawToolCall of value) {
    if (!isRecord(rawToolCall)) continue;

    const identity = getTupleToolCallIdentity(rawToolCall);
    const rawArgs = getTupleToolCallArgs(rawToolCall);
    const normalizedArgs = normalizeFinalToolCallArgs(rawArgs);

    if (identity.name == null) {
      invalidToolCalls.push({
        ...(identity.id != null ? { id: identity.id } : {}),
        ...(typeof rawArgs === "string" ? { args: rawArgs } : {}),
        error: "Incomplete tool call.",
        type: "invalid_tool_call",
      });
      continue;
    }

    if (!normalizedArgs.valid) {
      invalidToolCalls.push({
        ...(identity.id != null ? { id: identity.id } : {}),
        name: identity.name,
        ...(typeof normalizedArgs.args === "string"
          ? { args: normalizedArgs.args }
          : {}),
        error: "Malformed args.",
        type: "invalid_tool_call",
      });
      continue;
    }

    toolCalls.push({
      ...(identity.id != null ? { id: identity.id } : {}),
      name: identity.name,
      args: normalizedArgs.args,
      type: "tool_call",
    });
  }

  return { toolCalls, invalidToolCalls };
};

/**
 * Normalizes a single message embedded in protocol state payloads.
 *
 * @param value - Raw message object.
 * @returns The normalized message shape.
 */
export const normalizeProtocolStateMessage = (
  value: Record<string, unknown>
) => {
  const type = normalizeProtocolStateMessageType(value.type);
  if (type == null) return value;

  const additionalKwargs = isRecord(value.additional_kwargs)
    ? value.additional_kwargs
    : undefined;

  const message: Record<string, unknown> = {
    type,
    content: normalizeProtocolMessageContent(
      "content" in value ? value.content : "",
      {
        additionalKwargs: type === "ai" ? additionalKwargs : undefined,
      }
    ),
  };

  if (typeof value.id === "string") {
    message.id = value.id;
  }
  if (typeof value.name === "string") {
    message.name = value.name;
  }
  if (
    (type === "ai" || type === "human") &&
    typeof value.example === "boolean"
  ) {
    message.example = value.example;
  }

  if (type === "tool") {
    if (typeof value.tool_call_id === "string") {
      message.tool_call_id = value.tool_call_id;
    }
    if (value.status === "success" || value.status === "error") {
      message.status = value.status;
    }
    if ("artifact" in value) {
      message.artifact = value.artifact;
    }
  }

  if (type === "ai") {
    const rawToolCalls =
      Array.isArray(value.tool_calls) && value.tool_calls.length > 0
        ? value.tool_calls
        : Array.isArray(additionalKwargs?.tool_calls)
          ? additionalKwargs.tool_calls
          : undefined;
    const normalizedToolCalls = normalizeProtocolStateToolCalls(rawToolCalls);
    const normalizedInvalidToolCalls =
      Array.isArray(value.invalid_tool_calls) &&
      value.invalid_tool_calls.length > 0
        ? normalizeProtocolStateInvalidToolCalls(value.invalid_tool_calls)
        : normalizedToolCalls.invalidToolCalls;

    if (normalizedToolCalls.toolCalls.length > 0) {
      message.tool_calls = normalizedToolCalls.toolCalls;
    }
    if (normalizedInvalidToolCalls.length > 0) {
      message.invalid_tool_calls = normalizedInvalidToolCalls;
    }
  }

  return message;
};

/**
 * Recursively normalizes protocol state payloads before they are emitted.
 *
 * @param value - Raw state payload.
 * @returns The normalized state payload.
 */
export const normalizeProtocolStatePayload = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) =>
      isProtocolStateMessage(item)
        ? normalizeProtocolStateMessage(item)
        : normalizeProtocolStatePayload(item)
    );
  }
  if (!isRecord(value)) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__interrupt__") {
      continue;
    }

    if (key === "messages" && Array.isArray(entry)) {
      normalized[key] = entry.map((item) =>
        isProtocolStateMessage(item)
          ? normalizeProtocolStateMessage(item)
          : item
      );
      continue;
    }

    normalized[key] = normalizeProtocolStatePayload(entry);
  }

  return normalized;
};

/**
 * Coerces arbitrary update payloads into the protocol values shape.
 *
 * @param value - Raw update payload.
 * @returns A valid updates values payload.
 */
export const asUpdateValues = (
  value: unknown
): UpdatesEvent["params"]["data"]["values"] =>
  isRecord(value) ? value : { value };
