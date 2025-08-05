import { describe, expect, it, vi } from "vitest";
import { PregelRunner } from "./runner.js";
import { PregelLoop } from "./loop.js";

describe("PregelRunner", () => {
  // Basic structure test
  describe("constructor", () => {
    it("should initialize without errors", () => {
      const mockLoop = {} as PregelLoop;
      const runner = new PregelRunner({ loop: mockLoop });
      expect(runner).toBeInstanceOf(PregelRunner);
    });
  });

  // Simple behavior test with limited mocking
  describe("timeout option", () => {
    it("should pass timeout option to AbortSignal.timeout", async () => {
      const mockLoop = {
        config: {
          configurable: {
            thread_id: "1",
          },
        },
        tasks: {},
        step: 1,
        isNested: false,
      } as unknown as PregelLoop;

      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const runner = new PregelRunner({ loop: mockLoop });

      try {
        await runner.tick({ timeout: 5000 });
      } catch (e) {
        // Ignore errors
      }

      expect(timeoutSpy).toHaveBeenCalledWith(5000);
      timeoutSpy.mockRestore();
    });
  });

  // Testing the onStepWrite callback behavior
  describe("onStepWrite callback", () => {
    it("should call onStepWrite with the step number and writes", async () => {
      // Create a minimal implementation
      const mockOnStepWrite = vi.fn();
      const mockLoop = {
        config: {
          configurable: {
            thread_id: "1",
          },
        },
        tasks: {},
        step: 42, // Use a unique value to verify it's passed correctly
        isNested: false,
      } as unknown as PregelLoop;

      const runner = new PregelRunner({ loop: mockLoop });

      try {
        await runner.tick({ onStepWrite: mockOnStepWrite });
      } catch (e) {
        // Ignore any errors from other parts of the code
      }

      // Verify the callback was called with the correct step number (42)
      expect(mockOnStepWrite).toHaveBeenCalledWith(42, expect.any(Array));
    });
  });
});
