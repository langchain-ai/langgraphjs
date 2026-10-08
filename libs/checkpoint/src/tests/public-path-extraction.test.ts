import { describe, it, expect } from "vitest";
import { getTextAtPath, tokenizePath } from "../index.js";

const nestedData = {
  name: "test",
  info: {
    age: 25,
    metadata: { created: "2024-01-01", updated: "2024-01-02" },
  },
  items: [
    { id: 1, value: "first", tags: ["x", "y"] },
    { id: 2, value: "second", tags: ["y", "z"] },
    { id: 3, value: "third", tags: ["z", "w"] },
  ],
  chapters: [
    { title: "one", content: "Chapter one" },
    { title: "two", content: "Chapter two" },
  ],
  numbers: [0, 0.1, "0"],
  emptyList: [],
  emptyDict: {},
};

// The package entry point must expose the same path semantics the store indexes
// with. `IndexConfig.fields` documents "$", "chapters[*].content", "authors[0].name"
// and "array[-1]" directly above the implementation, so a consumer reading text
// the way the store does has to get the same answer through the published API.
describe("public text path extraction", () => {
  it("extracts the whole document for the documented default path", () => {
    expect(getTextAtPath(nestedData, "$")).toEqual([
      JSON.stringify(nestedData, null, 2),
    ]);
  });

  it("extracts every path form IndexConfig.fields documents", () => {
    expect(getTextAtPath(nestedData, "info.metadata.created")).toEqual([
      "2024-01-01",
    ]);
    expect(getTextAtPath(nestedData, "chapters[*].content")).toEqual([
      "Chapter one",
      "Chapter two",
    ]);
    expect(getTextAtPath(nestedData, "items[0].value")).toEqual(["first"]);
    expect(getTextAtPath(nestedData, "items[-1].value")).toEqual(["third"]);
  });

  it("extracts non-string scalars the way the store does", () => {
    expect(getTextAtPath(nestedData, "info.age")).toEqual(["25"]);

    const zeros = getTextAtPath(nestedData, "numbers[*]");
    expect(new Set(zeros)).toEqual(new Set(["0", "0.1"]));
  });

  it("supports wildcard and multi-field selection", () => {
    const values = getTextAtPath(nestedData, "items[*].value");
    expect(new Set(values)).toEqual(new Set(["first", "second", "third"]));

    const nameAndAge = getTextAtPath(nestedData, "{name,info.age}");
    expect(new Set(nameAndAge)).toEqual(new Set(["test", "25"]));

    const allTags = getTextAtPath(nestedData, "items[*].tags[*]");
    expect(new Set(allTags)).toEqual(new Set(["x", "y", "z", "w"]));
  });

  it("tokenizes an index expression the way getTextAtPath consumes it", () => {
    // The entry point used to expose `path.split(".")`, which kept "chapters[*]"
    // whole; the tokenizer the store uses splits the name from the index so an
    // index expression can be matched on its own.
    expect(tokenizePath("metadata.title")).toEqual(["metadata", "title"]);
    expect(tokenizePath("chapters[*].content")).toEqual([
      "chapters",
      "[*]",
      "content",
    ]);
  });
});
