import { createLogger, format, transports } from "winston";
import { logger as honoLogger } from "hono/logger";
import { consoleFormat } from "winston-console-format";
import type { MiddlewareHandler } from "hono";
import { parse as stacktraceParser } from "stacktrace-parser";
import { readFileSync } from "fs";
import { codeFrameColumns } from "@babel/code-frame";
import path from "node:path";

const LOG_JSON = process.env.LOG_JSON === "true";
const LOG_LEVEL = process.env.LOG_LEVEL || "debug";

export const logger = createLogger({
  level: LOG_LEVEL,
  format: format.combine(
    format.errors({ stack: true }),
    format.timestamp(),
    format.json(),
    ...(!LOG_JSON
      ? [
          format.colorize({ all: true }),
          format.padLevels(),
          consoleFormat({
            showMeta: true,
            metaStrip: ["timestamp"],
            inspectOptions: {
              depth: Infinity,
              colors: true,
              maxArrayLength: Infinity,
              breakLength: 120,
              compact: Infinity,
            },
          }),
        ]
      : [
          format.printf((info) => {
            const { timestamp, level, message, ...rest } = info;

            let event;
            if (typeof message === "string") {
              event = message;
            } else {
              event = JSON.stringify(message);
            }

            if (rest.stack) {
              rest.message = event;
              event = rest.stack;
            }

            return JSON.stringify({ timestamp, level, event, ...rest });
          }),
        ]),
  ),
  transports: [new transports.Console()],
});

const formatStack = (stack: string | undefined | null) => {
  if (!stack) return stack;

  const [firstFile] = stacktraceParser(stack).filter(
    (item) =>
      !item.file?.split(path.sep).includes("node_modules") &&
      !item.file?.startsWith("node:"),
  );

  if (firstFile?.file && firstFile?.lineNumber) {
    try {
      const filePath = firstFile.file;
      const line = firstFile.lineNumber;
      const column = firstFile.column ?? 0;

      const messageLines = stack.split("\n");
      const spliceIndex = messageLines.findIndex((i) => i.includes(filePath));

      const padding = " ".repeat(
        Math.max(0, messageLines[spliceIndex].indexOf("at")),
      );

      const highlightCode = process.stdout.isTTY;

      let codeFrame = codeFrameColumns(
        readFileSync(filePath, "utf-8"),
        { start: { line, column } },
        { highlightCode },
      );

      codeFrame = codeFrame
        .split("\n")
        .map((i) => padding + i + "\x1b[0m")
        .join("\n");

      if (highlightCode) {
        codeFrame = "\x1b[36m" + codeFrame + "\x1b[31m";
      }

      // insert codeframe after the line but dont lose the stack
      return [
        ...messageLines.slice(0, spliceIndex + 1),
        codeFrame,
        ...messageLines.slice(spliceIndex + 1),
      ].join("\n");
    } catch {
      // pass
    }
  }

  return stack;
};

export const logError = (
  error: unknown,
  options?: {
    context?: Record<string, unknown>;
    prefix?: string;
  },
) => {
  let message;
  let context = options?.context;

  if (error instanceof Error) {
    message = formatStack(error.stack) || error.message;
  } else {
    message = String(error);
    context = { ...context, error };
  }

  if (options?.prefix != null) message = `${options.prefix}:\n${message}`;
  logger.error(message, ...(context != null ? [context] : []));
};

process.on("uncaughtException", (error) => logError(error));
process.on("unhandledRejection", (error) => logError(error));

export const requestLogger = (): MiddlewareHandler =>
  honoLogger((message, ...rest) => {
    logger.info(message, ...rest);
  });
