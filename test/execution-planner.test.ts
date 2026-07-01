import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { createExecutionPlan } from "../src/execution/execution-planner";
import { TOKENS } from "../src/constants";

const [tokenA, tokenB, tokenC] = TOKENS.map(({ address }) => address);

function address(id: number): Address {
  return `0x${(60_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

describe("createExecutionPlan", () => {
  test("builds ArbParams for a mixed V2/V3 circular route", () => {
    const flashPool = address(1);
    const v2Pool = address(2);
    const v3Pool = address(3);
    const closingPool = address(4);

    const plan = createExecutionPlan({
      findBestFlashPoolForToken(token, amountIn, excludePools) {
        expect(token).toBe(tokenA);
        expect(amountIn).toBe(1_000n);
        expect(excludePools).toEqual([v2Pool, v3Pool, closingPool]);
        return { protocol: "v2", poolAddress: flashPool, fee: 30, liquidity: 10_000n };
      },
    }, {
      path: [tokenA, tokenB, tokenC, tokenA],
      pairs: [v2Pool, v3Pool, closingPool],
      protocols: ["v2", "v3", "v2"],
      fees: [30, 500, 30],
      optimalAmount: 1_000n,
      expectedProfit: 100n,
    });

    expect(plan?.params).toEqual({
      flashProtocol: 0,
      flashPool,
      borrowToken: tokenA,
      borrowAmount: 1_000n,
      v2RepayFee: 30n,
      pools: [v2Pool, v3Pool, closingPool],
      protocols: [0, 1, 0],
      fees: [30n, 500n, 30n],
    });
  });

  test("builds ArbParams with a V3 flash pool when it is the best flash source", () => {
    const flashPool = address(30);
    const routePool = address(31);

    const plan = createExecutionPlan({
      findBestFlashPoolForToken() {
        return { protocol: "v3", poolAddress: flashPool, fee: 500, liquidity: 10_000n };
      },
    }, {
      path: [tokenA, tokenB, tokenA],
      pairs: [routePool, address(32)],
      protocols: ["v2", "v3"],
      fees: [30, 500],
      optimalAmount: 1_000n,
      expectedProfit: 100n,
    });

    expect(plan?.params.flashProtocol).toBe(1);
    expect(plan?.params.flashPool).toBe(flashPool);
    expect(plan?.params.v2RepayFee).toBe(0n);
  });

  test("does not create a plan for non-circular routes", () => {
    const plan = createExecutionPlan({
      findBestFlashPoolForToken() {
        throw new Error("flash loan lookup should not run");
      },
    }, {
      path: [tokenA, tokenB, tokenC],
      pairs: [address(10), address(11)],
      protocols: ["v2", "v3"],
      fees: [30, 500],
      optimalAmount: 1_000n,
      expectedProfit: 100n,
    });

    expect(plan).toBeNull();
  });

  test("does not create a plan when route metadata lengths do not match", () => {
    const plan = createExecutionPlan({
      findBestFlashPoolForToken() {
        throw new Error("flash loan lookup should not run");
      },
    }, {
      path: [tokenA, tokenB, tokenA],
      pairs: [address(20), address(21)],
      protocols: ["v2"],
      fees: [30, 30],
      optimalAmount: 1_000n,
      expectedProfit: 100n,
    });

    expect(plan).toBeNull();
  });
});
