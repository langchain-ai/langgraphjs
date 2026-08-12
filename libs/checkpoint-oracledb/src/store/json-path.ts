// Copyright (c) 2026, Oracle and/or its affiliates.
import { pythonJsonDumps } from "./index-config.js";

/**
 * Render a value the way Python's `get_text_at_path` does.
 *
 * LangGraph's two implementations disagree here: Python uses
 * `json.dumps(obj, sort_keys=True, ensure_ascii=False)` while
 * `@langchain/langgraph-checkpoint` uses `JSON.stringify(obj, null, 2)`.
 * Since this store shares its vector tables with the Python package, the
 * embedded text has to be the Python form or the same document produces
 * different vectors in each language.
 */
function pythonText(value: unknown): string {
  return pythonJsonDumps(value, { ensureAscii: false });
}

/** Python's `str()` for the scalars `get_text_at_path` passes through. */
function pythonScalar(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function tokenizePath(path: string): string[] {
  if (!path) return [];

  const tokens: string[] = [];
  let current = "";
  let i = 0;
  while (i < path.length) {
    const char = path[i];
    if (char === ".") {
      if (current) {
        tokens.push(current);
      }
      current = "";
      i += 1;
      continue;
    }

    if (char === "[" || char === "{") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      const close = char === "[" ? "]" : "}";
      let depth = 1;
      let token = char;
      i += 1;
      while (i < path.length && depth > 0) {
        if (path[i] === char) depth += 1;
        if (path[i] === close) depth -= 1;
        token += path[i];
        i += 1;
      }
      tokens.push(token);
      continue;
    }

    current += char;
    i += 1;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function getTextAtPath(value: unknown, path: string): string[] {
  if (!path || path === "$") return [pythonText(value)];
  const tokens = tokenizePath(path);

  const extract = (current: unknown, position: number): string[] => {
    if (position >= tokens.length) {
      if (
        typeof current === "string" ||
        typeof current === "number" ||
        typeof current === "boolean"
      ) {
        return [pythonScalar(current)];
      }
      if (current === null || current === undefined) return [];
      if (Array.isArray(current) || typeof current === "object") {
        return [pythonText(current)];
      }
      return [];
    }

    const token = tokens[position];
    if (token.startsWith("[") && token.endsWith("]")) {
      if (!Array.isArray(current)) return [];
      const rawIndex = token.slice(1, -1);
      if (rawIndex === "*") {
        return current.flatMap((item) => extract(item, position + 1));
      }
      if (!/^-?\d+$/.test(rawIndex)) return [];
      const parsed = Number(rawIndex);
      if (!Number.isSafeInteger(parsed)) return [];
      const index = parsed < 0 ? current.length + parsed : parsed;
      return index >= 0 && index < current.length
        ? extract(current[index], position + 1)
        : [];
    }

    if (token.startsWith("{") && token.endsWith("}")) {
      if (typeof current !== "object" || current === null) return [];
      return token
        .slice(1, -1)
        .split(",")
        .flatMap((field) => getTextAtPath(current, field.trim()));
    }

    if (token === "*") {
      if (Array.isArray(current)) {
        return current.flatMap((item) => extract(item, position + 1));
      }
      if (typeof current === "object" && current !== null) {
        return Object.values(current).flatMap((item) =>
          extract(item, position + 1)
        );
      }
      return [];
    }

    if (typeof current !== "object" || current === null) return [];
    return extract((current as Record<string, unknown>)[token], position + 1);
  };

  return extract(value, 0);
}

export function jsonPath(field: string): string | undefined {
  const parts = field.split(".");
  if (
    parts.length === 0 ||
    !parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
  ) {
    return undefined;
  }
  return `'$${parts.map((part) => `."${part}"`).join("")}'`;
}

export function jsonValueExpression(
  field: string,
  kind: "string" | "number" = "string",
  column = "item_value"
): string | undefined {
  const path = jsonPath(field);
  if (!path) return undefined;
  const returning =
    kind === "number" ? "NUMBER NULL ON ERROR" : "VARCHAR2(4000) NULL ON ERROR";
  return `JSON_VALUE(${column}, ${path} RETURNING ${returning})`;
}
