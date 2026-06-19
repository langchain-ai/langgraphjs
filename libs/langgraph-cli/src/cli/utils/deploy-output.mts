/**
 * Dual-mode output for the `deploy` command, ported from the Python CLI's
 * `_Emitter`. Either emits JSON-lines (``--json``) or human-readable colored
 * text. The `deploy` command writes directly to stdout (separate from the
 * winston logger) so machine-readable JSON output stays clean.
 */

/** Whether ANSI colors should be suppressed (no TTY or `NO_COLOR` set). */
const NO_COLOR = process.env.NO_COLOR != null || !process.stdout.isTTY;

/** Supported text colors for human-readable output. */
type Color = "cyan" | "green" | "yellow" | "red";

/** ANSI SGR codes for each supported {@link Color}. */
const COLOR_CODES: Record<Color, string> = {
  cyan: "36",
  green: "32",
  yellow: "33",
  red: "31",
};

/**
 * Wrap a string in ANSI color codes, unless color output is disabled.
 *
 * @param message - Text to colorize.
 * @param color - Color to apply.
 * @returns The colorized string, or `message` unchanged when colors are off.
 */
function colorize(message: string, color: Color): string {
  if (NO_COLOR) return message;
  return `\u001b[${COLOR_CODES[color]}m${message}\u001b[0m`;
}

/**
 * Format an elapsed duration as a compact human string.
 *
 * @param seconds - Elapsed time in seconds.
 * @returns A string like `42s` or `3m 05s`.
 */
function formatElapsed(seconds: number): string {
  const total = Math.trunc(seconds);
  const mins = Math.trunc(total / 60);
  const secs = total % 60;
  return mins ? `${mins}m ${String(secs).padStart(2, "0")}s` : `${secs}s`;
}

/** Terminal outcome of a deploy operation. */
export type DeployResultStatus = "succeeded" | "failed" | "timed_out";

/**
 * Dual-mode output sink for the `deploy` command.
 *
 * @remarks
 * In JSON mode every call emits a single JSON-lines event to stdout; otherwise
 * calls render human-readable, optionally colorized text. The two modes share
 * the same call sites so the orchestration code stays mode-agnostic.
 */
export class Emitter {
  /** Whether structured JSON-lines output is enabled. */
  private readonly json: boolean;

  /**
   * @param jsonMode - When `true`, emit JSON-lines instead of text.
   */
  constructor(jsonMode: boolean) {
    this.json = jsonMode;
  }

  /** Whether this emitter is in JSON-lines mode. */
  get jsonMode(): boolean {
    return this.json;
  }

  /**
   * Write a single JSON-lines event to stdout.
   *
   * @param obj - The event object to serialize.
   */
  private write(obj: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  /**
   * Write a plain line of text to stdout.
   *
   * @param message - The line to write (a trailing newline is added).
   */
  private echo(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  /**
   * Emit a numbered, top-level step (e.g. `1. Building image`).
   *
   * @param step - The 1-based step number.
   * @param message - Step description.
   * @param extra - Additional fields merged into the JSON event.
   */
  step(step: number, message: string, extra?: Record<string, unknown>): void {
    if (this.json) {
      this.write({ event: "step", step, message, ...extra });
    } else {
      this.echo(colorize(`${step}. ${message}`, "cyan"));
    }
  }

  /**
   * Emit an informational detail line nested under a step.
   *
   * @param message - The detail message.
   * @param extra - Additional fields merged into the JSON event.
   */
  info(message: string, extra?: Record<string, unknown>): void {
    if (this.json) {
      this.write({ event: "info", message, ...extra });
    } else {
      this.echo(colorize(`   ${message}`, "green"));
    }
  }

  /**
   * Emit a warning nested under a step. Leading whitespace is stripped in JSON
   * mode so the structured `message` stays clean.
   *
   * @param message - The warning message.
   * @param extra - Additional fields merged into the JSON event.
   */
  warn(message: string, extra?: Record<string, unknown>): void {
    if (this.json) {
      this.write({
        event: "warn",
        message: message.replace(/^\s+/, ""),
        ...extra,
      });
    } else {
      this.echo(colorize(`   ${message}`, "yellow"));
    }
  }

  /**
   * Emit a top-level banner (pre-step). Not indented in text mode.
   *
   * @param message - The banner message.
   * @param extra - Additional fields merged into the JSON event.
   */
  note(message: string, extra?: Record<string, unknown>): void {
    if (this.json) {
      this.write({ event: "note", message, ...extra });
    } else {
      this.echo(colorize(message, "yellow"));
    }
  }

  /**
   * Emit an error line nested under a step.
   *
   * @param message - The error message.
   * @param extra - Additional fields merged into the JSON event.
   */
  error(message: string, extra?: Record<string, unknown>): void {
    if (this.json) {
      this.write({ event: "error", message, ...extra });
    } else {
      this.echo(colorize(`   ${message}`, "red"));
    }
  }

  /**
   * Emit a status transition (e.g. when a revision moves to a new phase),
   * annotated with elapsed time.
   *
   * @param status - The new status string.
   * @param elapsedSeconds - Seconds elapsed since polling began.
   */
  statusChange(status: string, elapsedSeconds: number): void {
    const elapsed = formatElapsed(elapsedSeconds);
    if (this.json) {
      this.write({
        event: "status_change",
        status,
        elapsed_seconds: Math.round(elapsedSeconds * 10) / 10,
        message: `${status}... (${elapsed})`,
      });
    } else {
      this.echo(`   ${status}... (${elapsed})`);
    }
  }

  /**
   * Emit a streamed build/log line.
   *
   * @param message - The raw log line.
   */
  log(message: string): void {
    if (this.json) {
      this.write({ event: "log", message });
    } else {
      this.echo(`   | ${message}`);
    }
  }

  /**
   * Emit the LangSmith dashboard URL where deployment status can be viewed.
   *
   * @param url - The dashboard URL.
   */
  statusUrl(url: string): void {
    if (this.json) {
      this.write({ event: "status_url", url });
    } else {
      this.echo(colorize(`   View status: ${url}`, "cyan"));
    }
  }

  /**
   * Emit a periodic heartbeat while a long-running status is unchanged.
   *
   * @remarks
   * Only emitted in JSON mode (text mode relies on the live spinner instead).
   *
   * @param status - The current status string.
   * @param elapsedSeconds - Seconds elapsed since polling began.
   */
  heartbeat(status: string, elapsedSeconds: number): void {
    if (!this.json) return;
    this.write({
      event: "heartbeat",
      status,
      elapsed_seconds: Math.round(elapsedSeconds * 10) / 10,
      message: `${status}... (${formatElapsed(elapsedSeconds)})`,
    });
  }

  /**
   * Emit source-upload progress. In text mode this rewrites the current line
   * in place; in JSON mode it emits a discrete progress event.
   *
   * @param sizeMb - Total upload size in MiB.
   * @param pct - Completion percentage (0–100).
   */
  uploadProgress(sizeMb: number, pct: number): void {
    if (this.json) {
      this.write({
        event: "upload_progress",
        size_mb: Math.round(sizeMb * 10) / 10,
        pct,
      });
    } else {
      process.stdout.write(
        `\r   Uploading (${sizeMb.toFixed(1)} MB)... ${pct}%`
      );
    }
  }

  /**
   * Emit the final deploy result.
   *
   * @param status - Terminal outcome (`succeeded`, `failed`, or `timed_out`).
   * @param args - Result details.
   * @param args.deploymentId - The deployment ID.
   * @param args.url - Public deployment URL, when available.
   * @param args.statusUrl - Dashboard status URL, when available.
   * @param args.fallbackStatusMessage - Text-mode fallback shown on timeout
   * when no `statusUrl` is available.
   */
  result(
    status: DeployResultStatus,
    args: {
      deploymentId: string;
      url?: string | null;
      statusUrl?: string | null;
      fallbackStatusMessage?: string | null;
    }
  ): void {
    if (this.json) {
      const message =
        status === "succeeded"
          ? "Deployment successful!"
          : status === "failed"
            ? "Deployment failed"
            : "Timed out waiting for deployment.";
      const payload: Record<string, unknown> = {
        event: "result",
        status,
        deployment_id: args.deploymentId,
        message,
      };
      if (args.url) payload.url = args.url;
      if (args.statusUrl) payload.status_url = args.statusUrl;
      this.write(payload);
      return;
    }

    if (status === "succeeded") {
      this.echo(colorize("   Deployment successful!", "green"));
      if (args.url) this.echo(colorize(`   URL: ${args.url}`, "green"));
      if (args.statusUrl) {
        this.echo(colorize(`   View status: ${args.statusUrl}`, "green"));
      }
    } else if (status === "failed") {
      this.echo(colorize("   Deployment failed", "red"));
      if (args.statusUrl) {
        this.echo(colorize(`   View status: ${args.statusUrl}`, "red"));
      }
    } else {
      this.echo(colorize("   Timed out waiting for deployment.", "yellow"));
      if (args.statusUrl) {
        this.echo(colorize(`   Check status at: ${args.statusUrl}`, "yellow"));
      } else if (args.fallbackStatusMessage) {
        this.echo(colorize(`   ${args.fallbackStatusMessage}`, "yellow"));
      }
    }
  }
}

/**
 * Minimal spinner used while polling/building. Renders an elapsed-time spinner
 * to stdout when attached to a TTY; otherwise emits each message on its own
 * line to stderr. In JSON mode it is a no-op.
 */
export class Spinner {
  /** Spinner animation frames cycled on each tick. */
  private static readonly FRAMES = ["|", "/", "-", "\\"];

  /** The active animation interval, or `undefined` when stopped. */
  private timer: NodeJS.Timeout | undefined;

  /** Index of the next animation frame to render. */
  private frameIndex = 0;

  /** Current display message (empty hides the spinner). */
  private message: string;

  /** Last non-empty message, used as the base for elapsed-time rendering. */
  private baseMessage: string;

  /** Timestamp (ms) when the spinner was created, for elapsed display. */
  private readonly start = Date.now();

  /** Whether to append an elapsed-time suffix to the message. */
  private readonly showElapsed: boolean;

  /** Whether the spinner is disabled (JSON mode). */
  private readonly jsonMode: boolean;

  /**
   * @param message - Initial message (does not start the spinner; call
   * {@link set} to begin animating).
   * @param options - Spinner options.
   * @param options.elapsed - Append an elapsed-time suffix when `true`.
   * @param options.jsonMode - Disable all output when `true`.
   */
  constructor(
    message: string,
    options: { elapsed?: boolean; jsonMode?: boolean } = {}
  ) {
    this.message = message;
    this.baseMessage = message;
    this.showElapsed = options.elapsed ?? false;
    this.jsonMode = options.jsonMode ?? false;
  }

  /** Render the current frame and message, overwriting the current line. */
  private render(): void {
    const frame = Spinner.FRAMES[this.frameIndex % Spinner.FRAMES.length];
    this.frameIndex += 1;
    let text = this.message;
    if (this.showElapsed && this.baseMessage) {
      const seconds = (Date.now() - this.start) / 1000;
      text = `${this.baseMessage} (${formatElapsed(seconds)})`;
    }
    process.stdout.write(`\r\u001b[K${frame} ${text}`);
  }

  /** Clear the current terminal line. */
  private clearLine(): void {
    process.stdout.write("\r\u001b[K");
  }

  /**
   * Update the spinner message, starting or stopping animation as needed.
   *
   * @remarks
   * Starts the animation when given a non-empty message and stops it when
   * given an empty string. On non-TTY stdout, each non-empty message is
   * written to stderr instead of animating. No-op in JSON mode.
   *
   * @param message - New message, or an empty string to hide the spinner.
   */
  set(message: string): void {
    if (this.jsonMode) return;
    if (!process.stdout.isTTY) {
      if (message) process.stderr.write(`${message}\n`);
      return;
    }
    this.message = message;
    if (message) this.baseMessage = message;
    if (!message) {
      this.clearLine();
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    } else if (!this.timer) {
      this.timer = setInterval(() => this.render(), 100);
    }
  }

  /** Stop the animation and clear the spinner line. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.jsonMode && process.stdout.isTTY) {
      this.clearLine();
    }
  }
}

export { formatElapsed };
