import { expect, it, describe } from "vitest";
import { XXH3_128 } from "../hash.js";

describe("XXH3_128", () => {
  describe("empty string (0 bytes)", () => {
    it("should hash empty string", () => {
      expect(XXH3_128("")).toBe("99aa06d3014798d86001c324468d497f");
    });
  });

  describe("1-3 bytes", () => {
    it("should hash 1 byte", () => {
      expect(XXH3_128("a")).toBe("a96faf705af16834e6c632b61e964e1f");
    });

    it("should hash 2 bytes", () => {
      expect(XXH3_128("ab")).toBe("89c65ebc828eebaca873719c24d5735c");
    });

    it("should hash 3 bytes", () => {
      expect(XXH3_128("abc")).toBe("6b05ab6733a618578af5f94892f3950");
    });
  });

  describe("4-8 bytes", () => {
    it("should hash 4 bytes", () => {
      expect(XXH3_128("abcd")).toBe("8d6b60383dfa90c21be79eecd1b1353d");
    });

    it("should hash 5 bytes", () => {
      expect(XXH3_128("abcde")).toBe("3043c78169f25c3f97d5a48ef320eec2");
    });

    it("should hash 6 bytes", () => {
      expect(XXH3_128("abcdef")).toBe("389197a55db2b2e4da35a6714d34f8a2");
    });

    it("should hash 7 bytes", () => {
      expect(XXH3_128("abcdefg")).toBe("2aafd83869a59c313fe798c0edaa6dc6");
    });

    it("should hash 8 bytes", () => {
      expect(XXH3_128("abcdefgh")).toBe("dac23237af37353342b702b313880f12");
    });
  });

  describe("9-16 bytes", () => {
    it("should hash 9 bytes", () => {
      expect(XXH3_128("abcdefghi")).toBe("b43ff5bc5ff2e0adc0646b2d7986db98");
    });

    it("should hash 10 bytes", () => {
      expect(XXH3_128("abcdefghij")).toBe("9e814df2752571c7b0a8c058e69ff5a7");
    });

    it("should hash 11 bytes", () => {
      expect(XXH3_128("abcdefghijk")).toBe("f63802ddeb8a84810c30617e220bd2c5");
    });

    it("should hash 12 bytes", () => {
      expect(XXH3_128("abcdefghijkl")).toBe("d5c1c71e1ef3a2b6ca41a0e8a26ef9e2");
    });

    it("should hash 13 bytes", () => {
      expect(XXH3_128("abcdefghijklm")).toBe(
        "b3f3c61b89a9d1224c633bfeef25de5b"
      );
    });

    it("should hash 14 bytes", () => {
      expect(XXH3_128("abcdefghijklmn")).toBe(
        "4d15f6daa22c156bcb0743e0c58a8d23"
      );
    });

    it("should hash 15 bytes", () => {
      expect(XXH3_128("abcdefghijklmno")).toBe(
        "5e190a0fa5ad0836d35dc9eaab32b9a0"
      );
    });

    it("should hash 16 bytes", () => {
      expect(XXH3_128("abcdefghijklmnop")).toBe(
        "1f58fc809b1b8c4b3e8e153ff12f6330"
      );
    });
  });

  describe("17-128 bytes", () => {
    it("should hash 17 bytes", () => {
      const input = "abcdefghijklmnopq";
      expect(XXH3_128(input)).toBe("11078c38a5ca3a8dc3acc9940596efab");
    });

    it("should hash 32 bytes", () => {
      const input = "abcdefghijklmnopqrstuvwxyz123456";
      expect(XXH3_128(input)).toBe("668b14f3933edd9f52625e96b6d3b0f3");
    });

    it("should hash 64 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz123456";
      expect(XXH3_128(input)).toBe("2d794cf93e1a067211e9b7a76062d8d6");
    });

    it("should hash 128 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz123456";
      expect(XXH3_128(input)).toBe("8d2ec8e569ae8fa6d7cc4c23a95f14d9");
    });
  });

  describe("129-240 bytes", () => {
    it("should hash 129 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz123456a";
      expect(XXH3_128(input)).toBe("b2ea1620c3bb852c2012ecacf727c481");
    });

    it("should hash 160 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890";
      expect(XXH3_128(input)).toBe("c800bd4157366fc23720f1739930fb8a");
    });

    it("should hash 240 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890";
      expect(XXH3_128(input)).toBe("bc971ffa336b4d9c484aaf4bea72ea4c");
    });
  });

  describe("241+ bytes (long input)", () => {
    it("should hash 241 bytes", () => {
      const input =
        "abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890a";
      expect(XXH3_128(input)).toBe("6ac1192bda13b7b0ccc2d9ba4de6130f");
    });

    it("should hash 512 bytes", () => {
      const input = "a".repeat(512);
      expect(XXH3_128(input)).toBe("9718dbab650037cd4659a548a9cc8db1");
    });

    it("should hash 1024 bytes", () => {
      const input = "b".repeat(1024);
      expect(XXH3_128(input)).toBe("fd5ea522e67427228507db63d38fc496");
    });

    it("should hash 4096 bytes", () => {
      const input = "c".repeat(4096);
      expect(XXH3_128(input)).toBe("b1fc3898cb4ccfb9bc50ac89ff26de23");
    });
  });

  describe("Uint8Array input", () => {
    it("should hash Uint8Array", () => {
      const input = new TextEncoder().encode("hello");
      expect(XXH3_128(input)).toBe("b5e9c1ad071b3e7fc779cfaa5e523818");
    });

    it("should hash empty Uint8Array", () => {
      const input = new Uint8Array(0);
      expect(XXH3_128(input)).toBe("99aa06d3014798d86001c324468d497f");
    });

    it("should hash single byte Uint8Array", () => {
      const input = new Uint8Array([97]); // 'a'
      expect(XXH3_128(input)).toBe("a96faf705af16834e6c632b61e964e1f");
    });
  });

  describe("seed parameter", () => {
    it("should hash with seed 0", () => {
      expect(XXH3_128("hello", 0n)).toBe("b5e9c1ad071b3e7fc779cfaa5e523818");
    });

    it("should hash with seed 1", () => {
      expect(XXH3_128("hello", 1n)).toBe("4a93b99b880550ca7edc2e874953d36d");
    });

    it("should hash with large seed", () => {
      expect(XXH3_128("hello", 123456789n)).toBe(
        "f3dd985a017416ec2e47f80041087a9f"
      );
    });

    it("should hash empty string with seed", () => {
      expect(XXH3_128("", 42n)).toBe("16c20acd33f7af2f3c1d09e9fe249164");
    });
  });

  describe("edge cases", () => {
    it("should handle unicode characters", () => {
      expect(XXH3_128("hello世界")).toBe("136ef66cd12de20cef7671666c482f52");
    });

    it("should handle special characters", () => {
      expect(XXH3_128("!@#$%^&*()")).toBe("ecce31aa3ba802e484741d278c4654b0");
    });

    it("should handle newlines", () => {
      expect(XXH3_128("hello\nworld")).toBe("9b32ed3fe4b0707222962e00f9cd6b5a");
    });

    it("should handle tabs", () => {
      expect(XXH3_128("hello\tworld")).toBe("234bacfb02656dc40604b57b6fc10016");
    });
  });

  describe("boundary conditions", () => {
    it("should hash exactly 16 bytes", () => {
      const input = "1234567890123456";
      expect(input.length).toBe(16);
      expect(XXH3_128(input)).toBe("f57143299804fb6a2e61ad3f8cc8fed5");
    });

    it("should hash exactly 128 bytes", () => {
      const input = "a".repeat(128);
      expect(input.length).toBe(128);
      expect(XXH3_128(input)).toBe("134e2a91815f3105ef354c1b9e35d99d");
    });

    it("should hash exactly 240 bytes", () => {
      const input = "b".repeat(240);
      expect(input.length).toBe(240);
      expect(XXH3_128(input)).toBe("5bb7a7da5e4ff82c807fb4b4352efc95");
    });

    it("should hash exactly 241 bytes", () => {
      const input = "c".repeat(241);
      expect(input.length).toBe(241);
      expect(XXH3_128(input)).toBe("b90b3e70eb1fd4a05d911035549cfeaf");
    });
  });
});
