const CR = "\r".charCodeAt(0);
const LF = "\n".charCodeAt(0);
const NULL = "\0".charCodeAt(0);
const COLON = ":".charCodeAt(0);
const SPACE = " ".charCodeAt(0);

export function BytesLineDecoder() {
  let buffer: Uint8Array[] = [];
  let skipLeadingLf = false;

  return new TransformStream<Uint8Array, Uint8Array>({
    start() {
      buffer = [];
      skipLeadingLf = false;
    },

    transform(chunk, controller) {
      if (!chunk.length) return;

      let start = 0;
      if (skipLeadingLf && chunk[0] === LF) start = 1;
      skipLeadingLf = false;

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

        // A CR ends its line at once; an LF right after it, even at the
        // start of the next chunk, completes the same CRLF line break.
        if (chunk[i] === CR) {
          if (i === chunk.length - 1) skipLeadingLf = true;
          else if (chunk[i + 1] === LF) i += 1;
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
  let lastEventId: string | undefined;
  let idChanged = false;
  let retry: number | null = null;
  let firstLine = true;

  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

  return new TransformStream<Uint8Array, StreamPart>({
    transform(chunk, controller) {
      if (firstLine) {
        firstLine = false;
        if (chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
          chunk = chunk.subarray(3);
        }
      }

      // Handle empty line case
      if (!chunk.length) {
        if (!event && !data.length && !idChanged && retry == null) return;

        const sse = {
          id: lastEventId,
          event,
          data: data.length ? decodeArraysToJson(decoder, data) : null,
        };

        // NOTE: as per the SSE spec, do not reset lastEventId
        event = "";
        data = [];
        idChanged = false;
        retry = null;

        controller.enqueue(sse);
        return;
      }

      // Ignore comments
      if (chunk[0] === COLON) return;

      const sepIdx = chunk.indexOf(COLON);
      const fieldName = decoder.decode(
        sepIdx === -1 ? chunk : chunk.subarray(0, sepIdx)
      );
      let value = sepIdx === -1 ? new Uint8Array() : chunk.subarray(sepIdx + 1);
      if (value[0] === SPACE) value = value.subarray(1);

      if (fieldName === "event") {
        event = decoder.decode(value);
      } else if (fieldName === "data") {
        data.push(value);
      } else if (fieldName === "id") {
        if (value.indexOf(NULL) === -1) {
          lastEventId = decoder.decode(value);
          idChanged = true;
        }
      } else if (fieldName === "retry") {
        const retryValue = decoder.decode(value);
        if (/^[0-9]+$/.test(retryValue))
          retry = Number.parseInt(retryValue, 10);
      }
    },

    flush(controller) {
      if (event) {
        controller.enqueue({
          id: lastEventId,
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

function decodeArraysToJson(decoder: TextDecoder, data: Uint8Array[]) {
  return JSON.parse(data.map((line) => decoder.decode(line)).join("\n"));
}
