/**
 * Pure helpers for the `deploy` command, ported from `deploy.py`. Kept free of
 * I/O so they can be unit-tested in isolation.
 */

import path from "node:path";

import type { Secret } from "./host-backend.mjs";

/**
 * Env vars that must never be forwarded as deployment secrets. Mirrors
 * `RESERVED_ENV_VARS` in the Python CLI (LANGCHAIN_RESERVED_ENV_VARS plus
 * ALLOWED_SELF_HOSTED_ENV_VARS).
 */
export const RESERVED_ENV_VARS: ReadonlySet<string> = new Set([
  "LANGCHAIN_TRACING_V2",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_ENDPOINT",
  "LANGCHAIN_PROJECT",
  "LANGSMITH_PROJECT",
  "LANGSMITH_LANGGRAPH_GIT_REPO",
  "LANGGRAPH_GIT_REPO_PATH",
  "LANGCHAIN_API_KEY",
  "LANGGRAPH_HOST_API_KEY",
  "LANGSMITH_CONTROL_PLANE_API_KEY",
  "POSTGRES_URI",
  "POSTGRES_PASSWORD",
  "DATABASE_URI",
  "LANGSMITH_LANGGRAPH_GIT_REF",
  "LANGSMITH_LANGGRAPH_GIT_REF_SHA",
  "LANGGRAPH_AUTH_TYPE",
  "LANGSMITH_AUTH_ENDPOINT",
  "LANGSMITH_TENANT_ID",
  "LANGSMITH_AUTH_VERIFY_TENANT_ID",
  "LANGSMITH_HOST_PROJECT_ID",
  "LANGSMITH_HOST_PROJECT_NAME",
  "LANGSMITH_HOST_REVISION_ID",
  "LOG_JSON",
  "LOG_DICT_TRACEBACKS",
  "REDIS_URI",
  "LANGCHAIN_CALLBACKS_BACKGROUND",
  "DD_TRACE_PSYCOPG_ENABLED",
  "DD_TRACE_REDIS_ENABLED",
  "LANGSMITH_DEPLOYMENT_NAME",
  "LANGGRAPH_CLOUD_LICENSE_KEY",
  "LANGSMITH_API_KEY",
  "LANGSMITH_ENDPOINT",
  "POSTGRES_URI_CUSTOM",
  "REDIS_URI_CUSTOM",
  "PATH",
  "PORT",
  "MOUNT_PREFIX",
  "LSD_ENV",
  "LSD_DD_API_KEY",
  "LSD_DD_ENDPOINT",
  "LSD_DEPLOYMENT_TYPE",
]);

/** Environment variable names checked, in order, when resolving the API key. */
export const API_KEY_ENV_NAMES = [
  "LANGGRAPH_HOST_API_KEY",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
] as const;

/** Env var holding a default deployment name. */
export const DEPLOYMENT_NAME_ENV = "LANGSMITH_DEPLOYMENT_NAME";

/**
 * Whether `child` resolves to a location strictly inside `parent`.
 *
 * @remarks
 * Used to keep configuration-supplied paths (e.g. the `env` file referenced
 * from `langgraph.json`) contained within the project directory, preventing
 * traversal (`../`) or absolute paths from reaching files outside the project.
 * Both arguments are expected to be absolute paths.
 *
 * @param parent - Absolute path to the directory that must contain `child`.
 * @param child - Absolute path to validate.
 * @returns `true` when `child` is strictly inside `parent`.
 */
export function isPathWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Default host backend API URL. */
export const DEFAULT_HOST_URL = "https://api.host.langchain.com";

/** Revision statuses that end status polling (success or failure). */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "DEPLOYED",
  "CREATE_FAILED",
  "BUILD_FAILED",
  "DEPLOY_FAILED",
  "SKIPPED",
]);

/** Characters disallowed in custom install/build commands. */
const DISALLOWED_BUILD_COMMAND_CHARS = [
  '"',
  "`",
  "\\",
  "\n",
  "\r",
  "\0",
  "\t",
  "|",
  ";",
  "$",
  ">",
  "<",
];

// Matches a single "&" that is NOT part of "&&" (blocks background execution
// while allowing `cmd1 && cmd2`).
const SINGLE_AMPERSAND_RE = /(?<!&)&(?:&&)*(?!&)/;

/**
 * Whether a custom install/build command contains disallowed shell content.
 *
 * @remarks
 * Rejects shell metacharacters (see {@link DISALLOWED_BUILD_COMMAND_CHARS}) and
 * a lone `&` (background execution), while still allowing `cmd1 && cmd2`.
 *
 * @param command - The command string to validate.
 * @returns `true` if the command contains disallowed characters or patterns.
 */
export function hasDisallowedBuildCommandContent(command: string): boolean {
  if (DISALLOWED_BUILD_COMMAND_CHARS.some((char) => command.includes(char))) {
    return true;
  }
  return SINGLE_AMPERSAND_RE.test(command);
}

/**
 * Sanitize a deployment/directory name into a valid LangSmith Deployment name.
 *
 * @remarks
 * Deployment names allow only lowercase `[a-z0-9-]`; invalid characters become
 * hyphens and leading/trailing hyphens are trimmed.
 *
 * @param value - The raw name (e.g. a directory name), may be nullish.
 * @returns A normalized name, or `"app"` when empty/fully invalid.
 */
export function normalizeName(value: string | null | undefined): string {
  if (!value) return "app";
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}

/**
 * Validate a Docker image tag (`[A-Za-z0-9_.-]`), defaulting to `latest`.
 *
 * @param value - The requested tag (empty becomes `latest`).
 * @returns The validated tag.
 * @throws Error if the tag contains characters outside `[A-Za-z0-9_.-]`.
 */
export function normalizeImageTag(value: string): string {
  const tag = value || "latest";
  if (!/^[A-Za-z0-9_.-]+$/.test(tag)) {
    throw new Error(
      "Image tag may only contain characters A-Z, a-z, 0-9, '_', '-', '.'"
    );
  }
  return tag;
}

/**
 * Convert an env dict to a deployment secrets list, dropping reserved and
 * empty-valued variables.
 *
 * @param envVars - Environment variables to convert.
 * @param onSkip - Optional callback invoked with the name of each reserved
 * variable that is skipped.
 * @returns The list of forwardable secrets.
 */
export function secretsFromEnv(
  envVars: Record<string, string>,
  onSkip?: (name: string) => void
): Secret[] {
  const secrets: Secret[] = [];
  for (const [name, value] of Object.entries(envVars)) {
    if (RESERVED_ENV_VARS.has(name)) {
      onSkip?.(name);
      continue;
    }
    if (!value) continue;
    secrets.push({ name, value });
  }
  return secrets;
}

/**
 * Return a copy of env vars without the deployment-name key (so it is not
 * forwarded as a secret).
 *
 * @param envVars - Environment variables to copy.
 * @returns A new object without {@link DEPLOYMENT_NAME_ENV}.
 */
export function envWithoutDeploymentName(
  envVars: Record<string, string>
): Record<string, string> {
  const filtered = { ...envVars };
  delete filtered[DEPLOYMENT_NAME_ENV];
  return filtered;
}

/**
 * Extract a deployment's public URL from its `source_config.custom_url`.
 *
 * @param deployment - The deployment object.
 * @returns The custom URL, or `"-"` when absent.
 */
function extractDeploymentUrl(deployment: Record<string, unknown>): string {
  const sourceConfig = deployment.source_config;
  if (sourceConfig && typeof sourceConfig === "object") {
    const customUrl = (sourceConfig as Record<string, unknown>).custom_url;
    if (typeof customUrl === "string" && customUrl) return customUrl;
  }
  return "-";
}

/**
 * Render a single table row, left-padding each cell to its column width.
 *
 * @param row - Cell values for the row.
 * @param widths - Column widths (parallel to `row`).
 * @returns The formatted, two-space-separated row string.
 */
function formatRow(row: string[], widths: number[]): string {
  return row.map((value, index) => value.padEnd(widths[index])).join("  ");
}

/**
 * Render a fixed-width text table with a header and separator row.
 *
 * @param headers - Column header labels.
 * @param rows - Row data (each parallel to `headers`).
 * @returns The full table as a newline-joined string.
 */
function buildTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );
  const lines = [
    formatRow(headers, widths),
    formatRow(
      widths.map((width) => "-".repeat(width)),
      widths
    ),
  ];
  for (const row of rows) lines.push(formatRow(row, widths));
  return lines.join("\n");
}

/**
 * Render a table of deployments with ID, name, and URL columns.
 *
 * @param deployments - Deployment objects to display.
 * @returns The formatted table string.
 */
export function formatDeploymentsTable(
  deployments: Record<string, unknown>[]
): string {
  const rows = deployments.map((deployment) => [
    String(deployment.id ?? "-") || "-",
    String(deployment.name ?? "-") || "-",
    extractDeploymentUrl(deployment),
  ]);
  return buildTable(
    ["Deployment ID", "Deployment Name", "Deployment URL"],
    rows
  );
}

/**
 * Render a table of revisions with ID, status, and creation time.
 *
 * @remarks
 * Since revisions are listed newest-first, only the first `DEPLOYED` revision
 * keeps that status; subsequent `DEPLOYED` rows are relabeled `REPLACED`.
 *
 * @param revisions - Revision objects to display (newest first).
 * @returns The formatted table string.
 */
export function formatRevisionsTable(
  revisions: Record<string, unknown>[]
): string {
  let latestDeployedSeen = false;
  const rows = revisions.map((revision) => {
    let status = String(revision.status ?? "-") || "-";
    if (status === "DEPLOYED") {
      if (latestDeployedSeen) {
        status = "REPLACED";
      } else {
        latestDeployedSeen = true;
      }
    }
    return [
      String(revision.id ?? "-") || "-",
      status,
      String(revision.created_at ?? "-") || "-",
    ];
  });
  return buildTable(["Revision ID", "Status", "Created At"], rows);
}

/**
 * Convert a timestamp to a readable UTC string (`YYYY-MM-DD HH:MM:SS`).
 *
 * @param ts - Epoch milliseconds (number) or a pre-formatted value.
 * @returns The formatted timestamp, or an empty string for falsy input.
 */
export function formatTimestamp(ts: unknown): string {
  if (typeof ts === "number") {
    const date = new Date(ts);
    return date.toISOString().slice(0, 19).replace("T", " ");
  }
  return ts ? String(ts) : "";
}

/**
 * Format a single log entry as `[timestamp] [level] message`, omitting any
 * missing parts.
 *
 * @param entry - A log entry with optional `timestamp`, `level`, `message`.
 * @returns The formatted log line.
 */
export function formatLogEntry(entry: Record<string, unknown>): string {
  const ts = formatTimestamp(entry.timestamp ?? "");
  const level = entry.level ?? "";
  const message = entry.message ?? "";
  if (ts && level) return `[${ts}] [${level}] ${message}`;
  if (ts) return `[${ts}] ${message}`;
  return String(message);
}

/** Color to apply to a log line, or `undefined` for the default color. */
export type LogColor = "red" | "yellow" | undefined;

/**
 * Map a log level to a display color.
 *
 * @param level - The log level (case-insensitive).
 * @returns `"red"` for errors, `"yellow"` for warnings, otherwise `undefined`.
 */
export function levelColor(level: unknown): LogColor {
  const upper = typeof level === "string" ? level.toUpperCase() : "";
  if (upper === "ERROR" || upper === "CRITICAL") return "red";
  if (upper === "WARNING") return "yellow";
  return undefined;
}

/**
 * Derive the LangSmith dashboard base URL from the API host URL.
 *
 * @remarks
 * Maps the prod host to `smith.langchain.com`, regional hosts (e.g.
 * `eu.api.host.langchain.com`) to their regional dashboard, passes through
 * localhost, and defaults to the prod dashboard for anything unrecognized.
 *
 * @param hostUrl - The host backend API URL, may be nullish.
 * @returns The dashboard base URL (no trailing slash).
 */
export function smithDashboardBaseUrl(
  hostUrl: string | null | undefined
): string {
  if (!hostUrl) return "https://smith.langchain.com";
  let parsed: URL;
  try {
    parsed = new URL(hostUrl);
  } catch {
    return "https://smith.langchain.com";
  }
  const hostname = parsed.hostname || "";
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return hostUrl.replace(/\/+$/, "");
  }
  const apiHostSuffix = "api.host.langchain.com";
  if (hostname === apiHostSuffix) return "https://smith.langchain.com";
  if (hostname.endsWith(`.${apiHostSuffix}`)) {
    const prefix = hostname.slice(0, -(apiHostSuffix.length + 1));
    return `https://${prefix}.smith.langchain.com`;
  }
  return "https://smith.langchain.com";
}

/**
 * Compute the LangSmith dashboard URL for a deployment, if possible.
 *
 * @param updated - A deployment object that may carry a `tenant_id`.
 * @param deploymentId - The deployment ID.
 * @param hostUrl - The host backend API URL, used to derive the dashboard host.
 * @returns The dashboard URL, or `null` when no tenant ID is available.
 */
export function getDeploymentStatusUrl(
  updated: unknown,
  deploymentId: string,
  hostUrl?: string | null
): string | null {
  const tenantId =
    updated && typeof updated === "object"
      ? (updated as Record<string, unknown>).tenant_id
      : undefined;
  if (!tenantId) return null;
  const base = smithDashboardBaseUrl(hostUrl);
  return `${base}/o/${tenantId}/host/deployments/${deploymentId}`;
}

/**
 * Find a deployment ID by exact name match within a list response.
 *
 * @param response - A list-deployments response with a `resources` array.
 * @param name - The exact deployment name to match, may be nullish.
 * @returns The matching deployment ID, or `null` when not found.
 */
export function findDeploymentIdByName(
  response: unknown,
  name: string | null | undefined
): string | null {
  if (!name) return null;
  if (response && typeof response === "object") {
    const resources = (response as Record<string, unknown>).resources;
    if (Array.isArray(resources)) {
      for (const dep of resources) {
        if (
          dep &&
          typeof dep === "object" &&
          (dep as Record<string, unknown>).name === name
        ) {
          const id = (dep as Record<string, unknown>).id;
          if (id) return String(id);
        }
      }
    }
  }
  return null;
}
