import { describe, expect, it } from "vitest";
import { QueryBuilder } from "./query-builder.js";

describe("empty membership filters", () => {
  it("keeps following parameters aligned without binding an empty list", () => {
    const params: unknown[] = ["namespace"];
    const result = QueryBuilder.buildFilterConditions(
      { difficulty: { $in: [] }, category: "programming" },
      params,
      2
    );

    expect(result.conditions).toEqual(["FALSE", "value ->> $2 = $3"]);
    expect(result.newParamIndex).toBe(4);
    expect(params).toEqual(["namespace", "category", "programming"]);
  });

  it("retains other comparisons in the same operator object", () => {
    const params: unknown[] = [];
    const result = QueryBuilder.buildFilterConditions(
      { difficulty: { $eq: "beginner", $in: [] } },
      params,
      1
    );

    expect(result.conditions).toEqual(["value ->> $1 = $2", "FALSE"]);
    expect(result.newParamIndex).toBe(3);
    expect(params).toEqual(["difficulty", "beginner"]);
  });
});
