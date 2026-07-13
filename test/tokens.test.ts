import { describe, expect, test } from "bun:test";
import { TOKENS } from "../src/constants";
import { graphToken, NATIVE_SEI, WSEI } from "../src/tokens";
import { tokenAmount } from "../src/values";

describe("token aliases", () => {
  test("treats Carbon native SEI as WSEI in the graph", () => {
    expect(graphToken(NATIVE_SEI)).toBe(WSEI);
    expect(graphToken(WSEI)).toBe(WSEI);
  });

  test("stores configured amounts in each token's native decimals", () => {
    const usdc = TOKENS.find(token => token.name === "USDC")!;
    const wbtc = TOKENS.find(token => token.name === "WBTC")!;

    expect(usdc.minProfit).toBe(tokenAmount("0.09", 6));
    expect(wbtc.liquidityAmount).toBe(tokenAmount("0.0003324", 8));
  });
});
