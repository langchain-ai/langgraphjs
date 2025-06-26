import { expect, it, describe } from "vitest";
import { XXH3_128 as XHH3_128_OLD } from "../hash.old.js";
import { XXH3 } from "../hash.js";

describe("XXH3_128", () => {
  describe("empty string (0 bytes)", () => {
    it("should hash empty string", () => {
      expect(XXH3("")).toBe(XHH3_128_OLD(""));
    });
  });

  describe("1-3 bytes", () => {
    it("should hash 1 byte", () => {
      expect(XXH3("a")).toBe(XHH3_128_OLD("a"));
    });

    it("should hash 2 bytes", () => {
      expect(XXH3("ab")).toBe(XHH3_128_OLD("ab"));
    });

    it("should hash 3 bytes", () => {
      expect(XXH3("abc")).toBe(XHH3_128_OLD("abc"));
    });
  });

  describe("4-8 bytes", () => {
    it("should hash 4 bytes", () => {
      expect(XXH3("abcd")).toBe(XHH3_128_OLD("abcd"));
    });

    it("should hash 5 bytes", () => {
      expect(XXH3("abcde")).toBe(XHH3_128_OLD("abcde"));
    });

    it("should hash 6 bytes", () => {
      expect(XXH3("abcdef")).toBe(XHH3_128_OLD("abcdef"));
    });

    it("should hash 7 bytes", () => {
      expect(XXH3("abcdefg")).toBe(XHH3_128_OLD("abcdefg"));
    });

    it("should hash 8 bytes", () => {
      expect(XXH3("abcdefgh")).toBe(XHH3_128_OLD("abcdefgh"));
    });
  });

  describe("9-16 bytes", () => {
    it("should hash 9 bytes", () => {
      expect(XXH3("abcdefghi")).toBe(XHH3_128_OLD("abcdefghi"));
    });

    it("should hash 10 bytes", () => {
      expect(XXH3("abcdefghij")).toBe(XHH3_128_OLD("abcdefghij"));
    });

    it("should hash 11 bytes", () => {
      expect(XXH3("abcdefghijk")).toBe(XHH3_128_OLD("abcdefghijk"));
    });

    it("should hash 12 bytes", () => {
      expect(XXH3("abcdefghijkl")).toBe(XHH3_128_OLD("abcdefghijkl"));
    });

    it("should hash 13 bytes", () => {
      expect(XXH3("abcdefghijklm")).toBe(XHH3_128_OLD("abcdefghijklm"));
    });

    it("should hash 14 bytes", () => {
      expect(XXH3("abcdefghijklmn")).toBe(XHH3_128_OLD("abcdefghijklmn"));
    });

    it("should hash 15 bytes", () => {
      expect(XXH3("abcdefghijklmno")).toBe(XHH3_128_OLD("abcdefghijklmno"));
    });

    it("should hash 16 bytes", () => {
      expect(XXH3("abcdefghijklmnop")).toBe(
        XHH3_128_OLD("abcdefghijklmnop")
      );
    });
  });

  describe("17-128 bytes", () => {
    it("should hash 17 bytes", () => {
      const input = "abcdefghijklmnopq";
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash 32 bytes", () => {
      const input = "abcdefghijklmnopqrstuvwxyz123456";
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash 64 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz123456";
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash 128 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz123456";
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });
  });

  describe("129-240 bytes", () => {
    it("should hash 129 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz123456a";
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash 160 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890";
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash 240 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890";
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });
  });

  describe("241+ bytes (long input)", () => {
    it("should hash 241 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890a";
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash 512 bytes", () => {
      const input = "a".repeat(512);
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash 1024 bytes", () => {
      const input = "b".repeat(1024);
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash 4096 bytes", () => {
      const input = "c".repeat(4096);
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });
  });

  describe("Uint8Array input", () => {
    it("should hash Uint8Array", () => {
      const input = new TextEncoder().encode("hello");
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash empty Uint8Array", () => {
      const input = new Uint8Array(0);
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash single byte Uint8Array", () => {
      const input = new Uint8Array([97]); // 'a'
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });
  });

  describe("seed parameter", () => {
    it("should hash with seed 0", () => {
      expect(XXH3("hello", 0n)).toBe(XHH3_128_OLD("hello", 0n));
    });

    it("should hash with seed 1", () => {
      expect(XXH3("hello", 1n)).toBe(XHH3_128_OLD("hello", 1n));
    });

    it("should hash with large seed", () => {
      expect(XXH3("hello", 123456789n)).toBe(
        XHH3_128_OLD("hello", 123456789n)
      );
    });

    it("should hash empty string with seed", () => {
      expect(XXH3("", 42n)).toBe(XHH3_128_OLD("", 42n));
    });
  });

  describe("edge cases", () => {
    it("should handle unicode characters", () => {
      expect(XXH3("hello世界")).toBe(XHH3_128_OLD("hello世界"));
    });

    it("should handle special characters", () => {
      expect(XXH3("!@#$%^&*()")).toBe(XHH3_128_OLD("!@#$%^&*()"));
    });

    it("should handle newlines", () => {
      expect(XXH3("hello\nworld")).toBe(XHH3_128_OLD("hello\nworld"));
    });

    it("should handle tabs", () => {
      expect(XXH3("hello\tworld")).toBe(XHH3_128_OLD("hello\tworld"));
    });
  });

  describe("boundary conditions", () => {
    it("should hash exactly 16 bytes", () => {
      const input = "1234567890123456";
      expect(input.length).toBe(16);
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash exactly 128 bytes", () => {
      const input = "a".repeat(128);
      expect(input.length).toBe(128);
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash exactly 240 bytes", () => {
      const input = "b".repeat(240);
      expect(input.length).toBe(240);
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });

    it("should hash exactly 241 bytes", () => {
      const input = "c".repeat(241);
      expect(input.length).toBe(241);
      expect(XXH3(input)).toBe(XHH3_128_OLD(input));
    });
  });
});
