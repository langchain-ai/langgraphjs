import { expect, it, describe } from "vitest";
import { isXXH3, XXH3 } from "../hash.js";

describe("XXH3_128", () => {
  it("should hash empty string", () => {
    expect(XXH3("")).toBe("99aa06d3014798d86001c324468d497f");
  });

  it("1-3 bytes", () => {
    const hashes = {
      a: "a96faf705af16834e6c632b61e964e1f",
      ab: "89c65ebc828eebaca873719c24d5735c",
      abc: "06b05ab6733a618578af5f94892f3950",
    };

    for (const [input, hash] of Object.entries(hashes)) {
      expect(XXH3(input), input).toBe(hash);
    }
  });

  it("4-8 bytes", () => {
    const hashes = {
      abcd: "8d6b60383dfa90c21be79eecd1b1353d",
      abcde: "3043c78169f25c3f97d5a48ef320eec2",
      abcdef: "389197a55db2b2e4da35a6714d34f8a2",
      abcdefg: "2aafd83869a59c313fe798c0edaa6dc6",
      abcdefgh: "dac23237af37353342b702b313880f12",
    };

    for (const [input, hash] of Object.entries(hashes)) {
      expect(XXH3(input), input).toBe(hash);
    }
  });

  it("9-16 bytes", () => {
    const hashes = {
      abcdefghi: "b43ff5bc5ff2e0adc0646b2d7986db98",
      abcdefghij: "9e814df2752571c7b0a8c058e69ff5a7",
      abcdefghijk: "f63802ddeb8a84810c30617e220bd2c5",
      abcdefghijkl: "d5c1c71e1ef3a2b6ca41a0e8a26ef9e2",
      abcdefghijklm: "b3f3c61b89a9d1224c633bfeef25de5b",
      abcdefghijklmn: "4d15f6daa22c156bcb0743e0c58a8d23",
      abcdefghijklmno: "5e190a0fa5ad0836d35dc9eaab32b9a0",
      abcdefghijklmnop: "1f58fc809b1b8c4b3e8e153ff12f6330",
    };

    for (const [input, hash] of Object.entries(hashes)) {
      expect(XXH3(input), input).toBe(hash);
    }
  });

  it("17-128 bytes", () => {
    const hashes = {
      abcdefghijklmnopq: "11078c38a5ca3a8dc3acc9940596efab",
      abcdefghijklmnopqrstuvwxyz123456: "668b14f3933edd9f52625e96b6d3b0f3",
      abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz123456:
        "2d794cf93e1a067211e9b7a76062d8d6",
      abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz123456:
        "8d2ec8e569ae8fa6d7cc4c23a95f14d9",
    };

    for (const [input, hash] of Object.entries(hashes)) {
      expect(XXH3(input), input).toBe(hash);
    }
  });

  it("129-240 bytes", () => {
    const hashes = {
      abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz123456a:
        "b2ea1620c3bb852c2012ecacf727c481",
      abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890:
        "c800bd4157366fc23720f1739930fb8a",
      abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890:
        "bc971ffa336b4d9c484aaf4bea72ea4c",
    };

    for (const [input, hash] of Object.entries(hashes)) {
      expect(XXH3(input), input).toBe(hash);
    }
  });

  it("129-160 bytes", () => {
    const hashes = {
      abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890:
        "c800bd4157366fc23720f1739930fb8a",
      abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890:
        "bc971ffa336b4d9c484aaf4bea72ea4c",
    };

    for (const [input, hash] of Object.entries(hashes)) {
      expect(XXH3(input), input).toBe(hash);
    }
  });

  it("241+ bytes (long input)", () => {
    const hashes = {
      abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890a:
        "6ac1192bda13b7b0ccc2d9ba4de6130f",
      ["a".repeat(512)]: "9718dbab650037cd4659a548a9cc8db1",
      ["b".repeat(1024)]: "fd5ea522e67427228507db63d38fc496",
      ["c".repeat(4096)]: "b1fc3898cb4ccfb9bc50ac89ff26de23",
    };

    for (const [input, hash] of Object.entries(hashes)) {
      expect(XXH3(input), input).toBe(hash);
    }
  });

  it("Uint8Array input", () => {
    const hashes = [
      [new TextEncoder().encode("hello"), "b5e9c1ad071b3e7fc779cfaa5e523818"],
      [new Uint8Array(0), "99aa06d3014798d86001c324468d497f"],
      [new Uint8Array([97]), "a96faf705af16834e6c632b61e964e1f"],
    ];

    for (const [input, hash] of hashes) {
      expect(XXH3(input)).toBe(hash);
    }
  });

  it("seed parameter", () => {
    expect(XXH3("hello", 0n)).toBe("b5e9c1ad071b3e7fc779cfaa5e523818");
    expect(XXH3("hello", 1n)).toBe("4a93b99b880550ca7edc2e874953d36d");
    expect(XXH3("hello", 123456789n)).toBe("f3dd985a017416ec2e47f80041087a9f");
    expect(XXH3("", 42n)).toBe("16c20acd33f7af2f3c1d09e9fe249164");
  });

  it("edge cases", () => {
    const hashes = {
      hello世界: "136ef66cd12de20cef7671666c482f52",
      "!@#$%^&*()": "ecce31aa3ba802e484741d278c4654b0",
      "hello\nworld": "9b32ed3fe4b0707222962e00f9cd6b5a",
      "hello\tworld": "234bacfb02656dc40604b57b6fc10016",
    };

    for (const [input, hash] of Object.entries(hashes)) {
      expect(XXH3(input), input).toBe(hash);
    }
  });

  it("boundary conditions", () => {
    let input = "1234567890123456";
    expect(input.length).toBe(16);
    expect(XXH3(input)).toBe("f57143299804fb6a2e61ad3f8cc8fed5");

    input = "a".repeat(128);
    expect(input.length).toBe(128);
    expect(XXH3(input)).toBe("134e2a91815f3105ef354c1b9e35d99d");

    input = "b".repeat(240);
    expect(input.length).toBe(240);
    expect(XXH3(input)).toBe("5bb7a7da5e4ff82c807fb4b4352efc95");

    input = "c".repeat(241);
    expect(input.length).toBe(241);
    expect(XXH3(input)).toBe("b90b3e70eb1fd4a05d911035549cfeaf");
  });

  it("is xxh3", () => {
    const hashes = [
      "32492f4bab4024f66da6c4ff3e821c65",
      "f2d76ea0c369b4533fa9aa9a35a8977a",
      "f9ba21d816b67aa8ec87181f23014542",
      "4a48370063a9d5590bb01dba7d4aadaa",
      "04a913522053b6d1de18c51b98821e54",
    ];

    for (const hash of hashes) {
      expect(isXXH3(hash), hash).toBe(true);
    }
  });
});
