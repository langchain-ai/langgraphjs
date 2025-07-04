import { Transform } from "node:stream";

const CR = "\r".charCodeAt(0);
const LF = "\n".charCodeAt(0);
const TRAILING_NEWLINE = [CR, LF];

function joinArrays(data: ArrayLike<number>[]) {
  const totalLength = data.reduce((acc, curr) => acc + curr.length, 0);
  let merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of data) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

export class BytesLineDecoder extends TransformStream<Uint8Array, Uint8Array> {
  constructor() {
    let buffer: Uint8Array[] = [];
    let trailingCr = false;

    super({
      start() {
        buffer = [];
        trailingCr = false;
      },

      transform(chunk, controller) {
        // See https://docs.python.org/3/glossary.html#term-universal-newlines
        let text = chunk;

        // Handle trailing CR from previous chunk
        if (trailingCr) {
          text = joinArrays([[CR], text]);
          trailingCr = false;
        }

        // Check for trailing CR in current chunk
        if (text.length > 0 && text.at(-1) === CR) {
          trailingCr = true;
          text = text.subarray(0, -1);
        }

        if (!text.length) return;
        const trailingNewline = TRAILING_NEWLINE.includes(text.at(-1)!);

        const lastIdx = text.length - 1;
        const { lines } = text.reduce<{ lines: Uint8Array[]; from: number }>(
          (acc, cur, idx) => {
            if (acc.from > idx) return acc;

            if (cur === CR || cur === LF) {
              acc.lines.push(text.subarray(acc.from, idx));
              if (cur === CR && text[idx + 1] === LF) {
                acc.from = idx + 2;
              } else {
                acc.from = idx + 1;
              }
            }

            if (idx === lastIdx && acc.from <= lastIdx) {
              acc.lines.push(text.subarray(acc.from));
            }

            return acc;
          },
          { lines: [], from: 0 }
        );

        if (lines.length === 1 && !trailingNewline) {
          buffer.push(lines[0]);
          return;
        }

        if (buffer.length) {
          // Include existing buffer in first line
          buffer.push(lines[0]);
          lines[0] = joinArrays(buffer);
          buffer = [];
        }

        if (!trailingNewline) {
          // If the last segment is not newline terminated,
          // buffer it for the next chunk
          if (lines.length) buffer = [lines.pop()!];
        }

        // Enqueue complete lines
        for (const line of lines) {
          controller.enqueue(line);
        }
      },

      flush(controller) {
        if (buffer.length) {
          controller.enqueue(joinArrays(buffer));
        }
      },
    });
  }

  fromWeb() {
    // @ts-expect-error invalid types for response.body
    return Transform.fromWeb(this);
  }
}
