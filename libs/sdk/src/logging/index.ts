/* eslint-disable @typescript-eslint/no-explicit-any */
interface LeveledLogMethod {
  (message: string, ...meta: any[]): Logger;
  (message: any): Logger;
  (infoObject: object): Logger;
}

interface Logger {
  error: LeveledLogMethod;
  warn: LeveledLogMethod;
  help: LeveledLogMethod;
  data: LeveledLogMethod;
  info: LeveledLogMethod;
  debug: LeveledLogMethod;
  prompt: LeveledLogMethod;
  http: LeveledLogMethod;
  verbose: LeveledLogMethod;
  input: LeveledLogMethod;
  silly: LeveledLogMethod;
}

const GLOBAL_LOGGER = Symbol.for("langgraph.api.sdk-logger");
type GLOBAL_LOGGER = typeof GLOBAL_LOGGER;

/**
 * Retrieves the global logger instance for LangGraph Platform.
 *
 * The logger provides structured logging capabilities with
 * various log levels (error, warn, info, debug, etc.) and extra metadata such as node name etc.
 *
 * @returns {Logger} The global logger instance with leveled logging methods
 *
 * @throws {Error} When the logger is not available in the current environment
 *
 * @example
 * ```typescript
 * // Safe usage with fallback
 * const logger = getLogger();
 * logger.info("This will only work in LangGraph Platform environment");
 * ```
 *
 * @remarks
 * This method is designed to work specifically within the LangGraph Platform
 * environment where a global logger is automatically registered. If you're
 * developing locally or in an environment where LangGraph Platform is not
 * available, this function will throw an error.
 */
export const getLogger = (): Logger => {
  const maybeGlobal = globalThis as unknown as { [GLOBAL_LOGGER]: Logger };
  if (GLOBAL_LOGGER in maybeGlobal) return maybeGlobal[GLOBAL_LOGGER];

  throw new Error(
    "Logger not available in current environment. " +
      "This method requires LangGraph Platform environment where a global logger is automatically registered. " +
      "If you're developing locally, consider using `console.log` or a local logging library instead."
  );
};
