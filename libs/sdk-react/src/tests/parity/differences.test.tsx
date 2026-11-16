/// <reference types="vite/client" />
import { expect, it } from "vitest";

import guide from "../../../docs/v2-migration.md?raw";
import { DIFFERENCES } from "./differences.js";

it.each(Object.entries(DIFFERENCES))(
  "the migration guide tells users about %s",
  (_, difference) => {
    expect(difference.guide, "no line of the guide covers it yet").not.toBeNull();
    expect(guide).toContain(difference.guide);
  }
);
