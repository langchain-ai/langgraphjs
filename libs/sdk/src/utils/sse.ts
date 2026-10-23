const CR = "\r".charCodeAt(0);
const LF = "\n".charCodeAt(0);
const NULL = "\0".charCodeAt(0);
const COLON = ":".charCodeAt(0);
const SPACE = " ".charCodeAt(0);

export function BytesLineDecoder() {
  let buffer: Uint8Array[] = [];
  let discardLeadingLf = false;

  return new TransformStream<Uint8Array, Uint8Array>({
    start() {
      buffer = [];
      discardLeadingLf = false;
    },

    transform(chunk, controller) {
      if (!chunk.length) return;
      let start = 0;
      if (discardLeadingLf) {
        if (chunk[0] === LF) start = 1;
        discardLeadingLf = false;
      }

      for (let i = start; i < chunk.length; i += 1) {
        if (chunk[i] !== CR && chunk[i] !== LF) continue;

        const line = chunk.subarray(start, i);
        if (buffer.length) {
          buffer.push(line);
          controller.enqueue(joinArrays(buffer));
          buffer = [];
        } else {
          controller.enqueue(line);
        }

        // A CR terminates the line immediately. Only a following LF needs
        // to be skipped, even when it arrives in a later chunk.
        if (chunk[i] === CR) {
          if (chunk[i + 1] === LF) i += 1;
          else discardLeadingLf = i === chunk.length - 1;
        }
        start = i + 1;
      }

      if (start < chunk.length) buffer.push(chunk.subarray(start));
    },

    flush(controller) {
      if (buffer.length) {
        controller.enqueue(joinArrays(buffer));
      }
    },
  });
}

export interface StreamPart {
  id: string | undefined;
  event: string;
  data: unknown;
}

export function SSEDecoder() {
  let event = "";
  let data: Uint8Array[] = [];
  let lastEventId = "";
  let retry: number | null = null;

  const decoder = new TextDecoder();

  return new TransformStream<Uint8Array, StreamPart>({
    transform(chunk, controller) {
      // Handle empty line case
      if (!chunk.length) {
        if (!event && !data.length && !lastEventId && retry == null) return;

        const sse = {
          id: lastEventId || undefined,
          event,
          data: data.length ? decodeArraysToJson(decoder, data) : null,
        };

        // NOTE: as per the SSE spec, do not reset lastEventId
        event = "";
        data = [];
        retry = null;

        controller.enqueue(sse);
        return;
      }

      // Ignore comments
      if (chunk[0] === COLON) return;

      const sepIdx = chunk.indexOf(COLON);
      if (sepIdx === -1) return;

      const fieldName = decoder.decode(chunk.subarray(0, sepIdx));
      let value = chunk.subarray(sepIdx + 1);
      if (value[0] === SPACE) value = value.subarray(1);

      if (fieldName === "event") {
        event = decoder.decode(value);
      } else if (fieldName === "data") {
        data.push(value);
      } else if (fieldName === "id") {
        if (value.indexOf(NULL) === -1) lastEventId = decoder.decode(value);
      } else if (fieldName === "retry") {
        const retryNum = Number.parseInt(decoder.decode(value), 10);
        if (!Number.isNaN(retryNum)) retry = retryNum;
      }
    },

    flush(controller) {
      if (event) {
        controller.enqueue({
          id: lastEventId || undefined,
          event,
          data: data.length ? decodeArraysToJson(decoder, data) : null,
        });
      }
    },
  });
}

function joinArrays(data: ArrayLike<number>[]) {
  const totalLength = data.reduce((acc, curr) => acc + curr.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of data) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

function decodeArraysToJson(decoder: TextDecoder, data: ArrayLike<number>[]) {
  return JSON.parse(decoder.decode(joinArrays(data)));
}
