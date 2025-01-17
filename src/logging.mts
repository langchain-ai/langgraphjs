import { createLogger, format, transports } from "winston";
import { logger as honoLogger } from "hono/logger";
import { consoleFormat } from "winston-console-format";
import type { MiddlewareHandler } from "hono";

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
        ])
  ),
  transports: [new transports.Console()],
});

export const logError = (error: unknown) => {
  if (error instanceof Error) {
    logger.error(error.stack || error.message);
  } else {
    logger.error(String(error), { error });
  }
};

process.on("uncaughtException", (error) => logError(error));
process.on("unhandledRejection", (error) => logError(error));

export const requestLogger = (): MiddlewareHandler =>
  honoLogger((message, ...rest) => {
    logger.info(message, ...rest);
  });
