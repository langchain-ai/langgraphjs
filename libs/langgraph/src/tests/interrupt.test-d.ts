import { expectTypeOf, it } from "vitest";
import {
  InferInterruptResumeType,
  interrupt,
  type InferInterruptInputType,
} from "../interrupt.js";

function all<T>(value: T): {
  InputType: InferInterruptInputType<T>;
  OutputType: InferInterruptResumeType<T>;
} {
  return {
    InputType: value as InferInterruptInputType<T>,
    OutputType: value as InferInterruptResumeType<T>,
  };
}

it("interrupt single", () => {
  const actual = all(interrupt<"input:single", "output:single">);
  expectTypeOf(actual).toEqualTypeOf<{
    InputType: "input:single";
    OutputType: "output:single";
  }>();
});

it("interrupt only invoke", () => {
  const actual = all(interrupt<"input:single">);
  expectTypeOf(actual).toEqualTypeOf<{
    InputType: "input:single";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    OutputType: any;
  }>();
});

it("interrupt map", () => {
  const actual = all({
    one: interrupt<"input:one", "output:one">,
    two: interrupt<"input:two">,
    three: interrupt<"input:three", "output:three">,
  });

  expectTypeOf(actual).toEqualTypeOf<{
    InputType: "input:one" | "input:two" | "input:three";
    OutputType: "output:one" | "output:three";
  }>();
});

it("interrupt with complex types", () => {
  interface ComplexInput {
    id: string;
    data: { value: number; nested: { flag: boolean } };
  }

  interface ComplexOutput {
    result: string;
    metadata: { processed: boolean };
  }

  const actual = all(interrupt<ComplexInput, ComplexOutput>);
  expectTypeOf(actual).toEqualTypeOf<{
    InputType: ComplexInput;
    OutputType: ComplexOutput;
  }>();
});

it("interrupt with union types", () => {
  type InputUnion =
    | { type: "A"; valueA: string }
    | { type: "B"; valueB: number };
  type OutputUnion =
    | { success: true; data: string }
    | { success: false; error: string };

  const actual = all(interrupt<InputUnion, OutputUnion>);
  expectTypeOf(actual).toEqualTypeOf<{
    InputType: InputUnion;
    OutputType: OutputUnion;
  }>();
});

it("interrupt with null and undefined", () => {
  const nullInterrupt = all(interrupt<null, string>);
  expectTypeOf(nullInterrupt).toEqualTypeOf<{
    InputType: null;
    OutputType: string;
  }>();

  const undefinedInterrupt = all(interrupt<undefined, number>);
  expectTypeOf(undefinedInterrupt).toEqualTypeOf<{
    InputType: undefined;
    OutputType: number;
  }>();

  const voidInterrupt = all(interrupt<void, boolean>);
  expectTypeOf(voidInterrupt).toEqualTypeOf<{
    InputType: void;
    OutputType: boolean;
  }>();
});

it("interrupt with never type", () => {
  const actual = all(interrupt<never, string>);
  expectTypeOf(actual).toEqualTypeOf<{
    InputType: never;
    OutputType: string;
  }>();
});

it("interrupt mixed map types", () => {
  const actual = all({
    stringInterrupt: interrupt<string, number>,
    objectInterrupt: interrupt<{ id: string }, { result: boolean }>,
    arrayInterrupt: interrupt<string[], number[]>,
    primitiveInterrupt: interrupt<boolean>,
  });

  expectTypeOf(actual).toEqualTypeOf<{
    InputType: string | { id: string } | string[] | boolean;
    OutputType: number | { result: boolean } | number[];
  }>();
});

it("interrupt with optional types", () => {
  const actual = all(
    interrupt<{ required: string; optional?: number }, string>
  );
  expectTypeOf(actual).toEqualTypeOf<{
    InputType: { required: string; optional?: number };
    OutputType: string;
  }>();
});

it("interrupt with readonly types", () => {
  const actual = all(interrupt<readonly string[], Readonly<{ value: number }>>);
  expectTypeOf(actual).toEqualTypeOf<{
    InputType: readonly string[];
    OutputType: Readonly<{ value: number }>;
  }>();
});

it("interrupt with tuple types", () => {
  const actual = all(interrupt<[string, number, boolean], [number, string]>);
  expectTypeOf(actual).toEqualTypeOf<{
    InputType: [string, number, boolean];
    OutputType: [number, string];
  }>();
});

it("interrupt empty map", () => {
  const actual = all({});
  expectTypeOf(actual).toEqualTypeOf<{ InputType: never; OutputType: never }>();
});

it("interrupt unknown", () => {
  const actual = all({} as unknown);
  expectTypeOf(actual).toEqualTypeOf<{
    InputType: unknown;
    OutputType: unknown;
  }>();
});
