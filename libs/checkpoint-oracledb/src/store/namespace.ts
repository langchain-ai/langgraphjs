// Copyright (c) 2026, Oracle and/or its affiliates.
import {
  InvalidNamespaceError,
  type MatchCondition,
} from "@langchain/langgraph-checkpoint";

export function validateNamespace(namespace: string[]): void {
  if (namespace.length === 0) {
    throw new InvalidNamespaceError("Namespace cannot be empty.");
  }
  for (const label of namespace) {
    if (typeof label !== "string") {
      throw new InvalidNamespaceError(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels must be strings, but got ${typeof label}.`
      );
    }
    if (label.includes(".")) {
      throw new InvalidNamespaceError(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels cannot contain periods ('.').`
      );
    }
    if (label === "") {
      throw new InvalidNamespaceError(
        `Namespace labels cannot be empty strings. Got ${label} in ${namespace}`
      );
    }
  }
  if (namespace[0] === "langgraph") {
    throw new InvalidNamespaceError(
      `Root label for namespace cannot be "langgraph". Got: ${namespace}`
    );
  }
}

export function namespacePath(namespace: string[]): string {
  return namespace.join(".");
}

export function encodeStoreKey(key: string): string {
  return key;
}

export function decodeStoreKey(key: string): string {
  return key;
}

export function namespacePrefixLikePattern(namespace: string[]): string {
  return `${escapeLike(namespacePath(namespace))}.%`;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function hasNamespacePrefix(
  namespace: string[],
  prefix: string[]
): boolean {
  if (prefix.length > namespace.length) return false;
  return prefix.every((label, index) => namespace[index] === label);
}

export function matchesNamespaceCondition(
  namespace: string[],
  condition: MatchCondition
): boolean {
  const { path, matchType } = condition;
  if (path.length > namespace.length) return false;

  if (matchType === "prefix") {
    return path.every(
      (label, index) => label === "*" || namespace[index] === label
    );
  }

  const offset = namespace.length - path.length;
  return path.every(
    (label, index) => label === "*" || namespace[offset + index] === label
  );
}
