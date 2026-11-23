import { describe, it, expect } from "vitest";
import { getTextAtPath } from "../store/utils.js";

describe("Text Path Extraction", () => {
  it("should resolve array paths inside multi-field selections", () => {
    const data = {
      title: "Book",
      chapters: [{ text: "first" }, { text: "last" }],
    };
    expect(getTextAtPath(data, "{title,chapters[0].text}")).toEqual([
      "Book",
      "first",
    ]);
    expect(getTextAtPath(data, "{chapters[-1].text,title}")).toEqual([
      "last",
      "Book",
    ]);
    expect(getTextAtPath(data, "{title,chapters[*].text}")).toEqual([
      "Book",
      "first",
      "last",
    ]);
  });

  it("should preserve scalar and null multi-field selection output", () => {
    expect(
      getTextAtPath({ zero: 0, flag: false, empty: null }, "{zero,flag,empty}")
    ).toEqual(["0", "false", "null"]);
    expect(getTextAtPath({ empty: null }, "empty")).toEqual([]);
  });

  it("should treat dollar fields inside selections as literal keys", () => {
    expect(getTextAtPath({ title: "Book" }, "{$,title}")).toEqual(["Book"]);
    expect(getTextAtPath({ $: "literal", title: "Book" }, "{$,title}")).toEqual(
      ["literal", "Book"]
    );
  });

  it("should continue extracting after multi-field selections", () => {
    const data = {
      primary: { text: "first", other: "unselected" },
      secondary: { text: "second", other: "unselected" },
    };
    expect(getTextAtPath(data, "{primary,secondary}.text")).toEqual([
      "first",
      "second",
    ]);
    expect(getTextAtPath(data, "{missing,primary}.text")).toEqual(["first"]);
  });

  it("should extract text from nested data", () => {
    const nestedData = {
      name: "test",
      info: {
        age: 25,
        tags: ["a", "b", "c"],
        metadata: { created: "2024-01-01", updated: "2024-01-02" },
      },
      items: [
        { id: 1, value: "first", tags: ["x", "y"] },
        { id: 2, value: "second", tags: ["y", "z"] },
        { id: 3, value: "third", tags: ["z", "w"] },
      ],
      empty: null,
      numbers: [0, 0.1, "0"],
      emptyList: [],
      emptyDict: {},
    };

    expect(getTextAtPath(nestedData, "$")).toEqual([
      JSON.stringify(nestedData, null, 2),
    ]);

    expect(getTextAtPath(nestedData, "name")).toEqual(["test"]);
    expect(getTextAtPath(nestedData, "info.age")).toEqual(["25"]);

    expect(getTextAtPath(nestedData, "info.metadata.created")).toEqual([
      "2024-01-01",
    ]);

    expect(getTextAtPath(nestedData, "items[0].value")).toEqual(["first"]);
    expect(getTextAtPath(nestedData, "items[-1].value")).toEqual(["third"]);
    expect(getTextAtPath(nestedData, "items[1].tags[0]")).toEqual(["y"]);

    const values = getTextAtPath(nestedData, "items[*].value");
    expect(new Set(values)).toEqual(new Set(["first", "second", "third"]));

    const metadataDates = getTextAtPath(nestedData, "info.metadata.*");
    expect(new Set(metadataDates)).toEqual(
      new Set(["2024-01-01", "2024-01-02"])
    );

    const nameAndAge = getTextAtPath(nestedData, "{name,info.age}");
    expect(new Set(nameAndAge)).toEqual(new Set(["test", "25"]));

    const itemFields = getTextAtPath(nestedData, "items[*].{id,value}");
    expect(new Set(itemFields)).toEqual(
      new Set(["1", "2", "3", "first", "second", "third"])
    );

    const allTags = getTextAtPath(nestedData, "items[*].tags[*]");
    expect(new Set(allTags)).toEqual(new Set(["x", "y", "z", "w"]));

    expect(getTextAtPath(null, "any.path")).toEqual([]);
    expect(getTextAtPath({}, "any.path")).toEqual([]);
    expect(getTextAtPath(nestedData, "")).toEqual([
      JSON.stringify(nestedData, null, 2),
    ]);
    expect(getTextAtPath(nestedData, "nonexistent")).toEqual([]);
    expect(getTextAtPath(nestedData, "items[99].value")).toEqual([]);
    expect(getTextAtPath(nestedData, "items[*].nonexistent")).toEqual([]);

    expect(getTextAtPath(nestedData, "empty")).toEqual([]);
    expect(getTextAtPath(nestedData, "emptyList")).toEqual(["[]"]);
    expect(getTextAtPath(nestedData, "emptyDict")).toEqual(["{}"]);

    const zeros = getTextAtPath(nestedData, "numbers[*]");
    expect(new Set(zeros)).toEqual(new Set(["0", "0.1"]));

    expect(getTextAtPath(nestedData, "items[].value")).toEqual([]);
    expect(getTextAtPath(nestedData, "items[abc].value")).toEqual([]);
    expect(getTextAtPath(nestedData, "{unclosed")).toEqual([]);
    expect(getTextAtPath(nestedData, "nested[{invalid}]")).toEqual([]);
  });
});
