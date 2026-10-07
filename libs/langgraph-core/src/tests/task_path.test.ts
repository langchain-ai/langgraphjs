import { describe, expect, it } from "vitest";
import {
  compareWritesSortKeys,
  writesSortKey,
} from "@langchain/langgraph-checkpoint";
import { PULL, PUSH } from "../constants.js";
import { taskPathStr } from "../pregel/algo.js";

/**
 * Fixtures for `taskPathStr`, verified byte for byte against Python's
 * `task_path_str` (langgraph `libs/langgraph/langgraph/pregel/_algo.py`):
 * the string stored with a task's writes — and therefore its sort position
 * under `writesSortKey` — is identical across the two runtimes.
 */
describe("taskPathStr", () => {
  it("serializes paths exactly like Python's task_path_str", () => {
    expect(taskPathStr(undefined)).toBe("~"); // Python: task_path_str(())
    expect(taskPathStr([])).toBe("~");
    expect(taskPathStr([PULL, "a"])).toBe("~__pregel_pull, a");
    // Send tasks (aligned shape): trailing `false` formats as an int, because
    // Python's isinstance(x, int) is true for bool.
    expect(taskPathStr([PUSH, 0, false])).toBe(
      "~__pregel_push, 0000000000, 0000000000"
    );
    // Call tasks: trailing `true`.
    expect(taskPathStr([PUSH, 2, true])).toBe(
      "~__pregel_push, 0000000002, 0000000001"
    );
    // Nested parent path (functional call under a PULL task).
    expect(taskPathStr([PUSH, [PULL, "a"], 1, true])).toBe(
      "~__pregel_push, ~__pregel_pull, a, 0000000001, 0000000001"
    );
    // Error handler of a failed PULL task (aligned shape).
    expect(taskPathStr([PULL, "a", "node_error_handler", false])).toBe(
      "~__pregel_pull, a, node_error_handler, 0000000000"
    );
    // Error handler of a failed Send (aligned shape).
    expect(taskPathStr([PUSH, 3, false, "node_error_handler", false])).toBe(
      "~__pregel_push, 0000000003, 0000000000, node_error_handler, 0000000000"
    );
    // Ints are zero-padded to 10 digits, sign-aware.
    expect(taskPathStr([PULL, -1])).toBe("~__pregel_pull, -000000001");
    expect(taskPathStr([PUSH, 10])).toBe("~__pregel_push, 0000000010");
    // Node names pass through as-is, BMP or astral.
    expect(taskPathStr([PULL, "⛰️"])).toBe("~__pregel_pull, ⛰️");
    expect(taskPathStr([PULL, "𝐀"])).toBe("~__pregel_pull, 𝐀");
  });

  it("orders serialized paths like Python str ordering", () => {
    // Verified against sorted() of the same fixtures in Python.
    const paths = [
      taskPathStr([]),
      taskPathStr([PULL, -1]),
      taskPathStr([PULL, "a"]),
      taskPathStr([PULL, "a", "node_error_handler", false]),
      taskPathStr([PULL, "⛰️"]),
      taskPathStr([PULL, "𝐀"]),
      taskPathStr([PUSH, 0, false]),
      taskPathStr([PUSH, 2]),
      taskPathStr([PUSH, 2, true]),
      taskPathStr([PUSH, 3, false, "node_error_handler", false]),
      taskPathStr([PUSH, 10]),
      taskPathStr([PUSH, [PULL, "a"], 1, true]),
    ];
    const sorted = paths
      .slice()
      .sort((a, b) => compareWritesSortKeys(writesSortKey(a), writesSortKey(b)));
    expect(sorted).toEqual([
      "~",
      "~__pregel_pull, -000000001",
      "~__pregel_pull, a",
      "~__pregel_pull, a, node_error_handler, 0000000000",
      "~__pregel_pull, ⛰️",
      "~__pregel_pull, 𝐀",
      "~__pregel_push, 0000000000, 0000000000",
      "~__pregel_push, 0000000002",
      "~__pregel_push, 0000000002, 0000000001",
      "~__pregel_push, 0000000003, 0000000000, node_error_handler, 0000000000",
      "~__pregel_push, 0000000010",
      "~__pregel_push, ~__pregel_pull, a, 0000000001, 0000000001",
    ]);
  });

  it("compares strings by code point, not UTF-16 code unit", () => {
    // U+10000 (𝐀, an astral character) is a greater code point than U+E000
    // (a private-use BMP character), but its UTF-16 lead surrogate (0xD800)
    // sorts below 0xE000. Python str order — and `compareWritesSortKeys` —
    // put U+E000 first.
    const astral = "𝐀";
    const bmp = "\uE000";
    expect(astral < bmp).toBe(true); // UTF-16 code-unit order disagrees
    expect(
      compareWritesSortKeys(writesSortKey(astral), writesSortKey(bmp))
    ).toBe(1);
    expect(
      compareWritesSortKeys(writesSortKey(bmp), writesSortKey(astral))
    ).toBe(-1);
  });

  it("treats unpaired surrogates as their own values", () => {
    // A lone surrogate is not an astral character: it compares as its own
    // value, below U+E000 — matching Python str ordering of the same code
    // points. The old code-unit comparator got this case wrong too: it
    // treated any high surrogate as astral and returned +1.
    expect(
      compareWritesSortKeys(writesSortKey("\ud800"), writesSortKey("\ue000"))
    ).toBe(-1);
    // A well-formed surrogate pair (U+10000) against a lone surrogate
    // (0xD801): the astral code point is the greater one. Python agrees for
    // strings decoded from JSON — which is how node names actually reach the
    // savers — since JSON combines valid surrogate pairs into one code point
    // the way JS strings do.
    expect(
      compareWritesSortKeys(
        writesSortKey("\ud800\udc00"),
        writesSortKey("\ud801")
      )
    ).toBe(1);
  });

  it("breaks ties on task id then numeric idx", () => {
    expect(
      compareWritesSortKeys(
        writesSortKey("~pull, a", "b", 2),
        writesSortKey("~pull, a", "b", 10)
      )
    ).toBe(-1); // idx compared numerically, not lexically
    expect(
      compareWritesSortKeys(
        writesSortKey("~pull, a", "b", 0),
        writesSortKey("~pull, a", "c", 0)
      )
    ).toBe(-1);
    // The empty path sorts first — where live execution applies input.
    expect(
      compareWritesSortKeys(
        writesSortKey("", "zzz", 0),
        writesSortKey("~pull, a", "aaa", 0)
      )
    ).toBe(-1);
  });
});
