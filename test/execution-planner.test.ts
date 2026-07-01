import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { ExecutionPlanner } from "../src/execution/execution-planner";
import { TOKENS } from "../src/constants";

const [tokenA, tokenB, tokenC] = TOKENS.map(({ address }) => address);

function address(id: number): Address {
  return `0x${(60_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

describe("ExecutionPlanner", () => {
  test("builds ArbParams for a mixed V2/V3 circular route", () => {
    const flashPool = address(1);
    const v2Pool = address(2);
    const v3Pool = address(3);
    const closingPool = address(4);
    const planner = new ExecutionPlanner();

    const plan = planner.createPlan({
      findBestPairForToken(token, amountIn, excludePairs) {
        expect(token).toBe(tokenA);
        expect(amountIn).toBe(1_000n);
        expect(excludePairs).toEqual([v2Pool, v3Pool, closingPool]);
        return { pairAddress: flashPool, fee: 30 };
      },
    }, {
      path: [tokenA, tokenB, tokenC, tokenA],
      pairs: [v2Pool, v3Pool, closingPool],
      protocols: ["v2", "v3", "v2"],
      fees: [30, 500, 30],
      optimalAmount: 1_000n,
      expectedProfit: 100n,
      routeKind: "mixed",
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

  test("does not create a plan for non-circular routes", () => {
    const planner = new ExecutionPlanner();
    const plan = planner.createPlan({
      findBestPairForToken() {
        throw new Error("flash loan lookup should not run");
      },
    }, {
      path: [tokenA, tokenB, tokenC],
      pairs: [address(10), address(11)],
      protocols: ["v2", "v3"],
      fees: [30, 500],
      optimalAmount: 1_000n,
      expectedProfit: 100n,
      routeKind: "mixed",
    });

    expect(plan).toBeNull();
  });

  test("does not create a plan when route metadata lengths do not match", () => {
    const planner = new ExecutionPlanner();
    const plan = planner.createPlan({
      findBestPairForToken() {
        throw new Error("flash loan lookup should not run");
      },
    }, {
      path: [tokenA, tokenB, tokenA],
      pairs: [address(20), address(21)],
      protocols: ["v2"],
      fees: [30, 30],
      optimalAmount: 1_000n,
      expectedProfit: 100n,
      routeKind: "mixed",
    });

    expect(plan).toBeNull();
  });
});
