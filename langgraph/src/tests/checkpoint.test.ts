import { describe, it, expect } from "@jest/globals";
import {
  deepCopy
} from "../checkpoint/base.js";

describe("Base", () => {
    it("should deep copy a simple object", () => {
      const obj = { a: 1, b: { c: 2 } };
      const copiedObj = deepCopy(obj);
  
      // Check if the copied object is equal to the original object
      expect(copiedObj).toEqual(obj);
  
      // Check if the copied object is not the same object reference as the original object
      expect(copiedObj).not.toBe(obj);
  
      // Check if the nested object is also deep copied
      expect(copiedObj.b).toEqual(obj.b);
      expect(copiedObj.b).not.toBe(obj.b);
    });
  
    it("should deep copy an array", () => {
      const arr = [1, 2, 3];
      const copiedArr = deepCopy(arr);
  
      // Check if the copied array is equal to the original array
      expect(copiedArr).toEqual(arr);
    });
  
    it("should deep copy an array of objects", () => {
      const arr = [{ a: 1 }, { b: 2 }];
      const copiedArr = deepCopy(arr);
  
      // Check if the copied array is equal to the original array
      expect(copiedArr).toEqual(arr);
  
      // Check if the copied array is not the same array reference as the original array
      expect(copiedArr).not.toBe(arr);
  
      // Check if the nested objects in the array are also deep copied
      expect(copiedArr[0]).toEqual(arr[0]);
      expect(copiedArr[0]).not.toBe(arr[0]);
    });
  });