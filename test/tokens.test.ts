import { describe, expect, test } from "bun:test";
import { graphToken, NATIVE_SEI, WSEI } from "../src/tokens";

describe("token aliases", () => {
  test("treats Carbon native SEI as WSEI in the graph", () => {
    expect(graphToken(NATIVE_SEI)).toBe(WSEI);
    expect(graphToken(WSEI)).toBe(WSEI);
  });
});
