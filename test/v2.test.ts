import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { V2ArbitrageEngine, type PairInfo } from "../src/arbitrage";
import { TOKENS } from "../src/constants";
import { tokenAmount } from "../src/values";

const [tokenA, tokenB, tokenC] = TOKENS.map(({ address }) => address);

function pairAddress(id: number): Address {
  return `0x${id.toString(16).padStart(40, "0")}` as Address;
}

function pair(
  id: number,
  token0: Address,
  token1: Address,
  reserve0: bigint,
  reserve1: bigint,
  fee = 30,
): PairInfo {
  return {
    pairAddress: pairAddress(id),
    token0,
    token1,
    reserve0,
    reserve1,
    fee,
  };
}

function buildGraph(pairs: PairInfo[]): V2ArbitrageEngine {
  const graph = new V2ArbitrageEngine();
  for (const pool of pairs) {
    graph.addPair(pool);
  }
  return graph;
}

describe("V2 arbitrage graph", () => {
  test("finds a profitable three-pool circular arbitrage route", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200")),
      pair(2, tokenB, tokenC, tokenAmount("1000"), tokenAmount("2200")),
      pair(3, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.paths.length).toBeGreaterThan(0);
    expect(opportunities.paths[0]).toEqual([tokenA, tokenB, tokenC, tokenA]);
    expect(opportunities.pairs[0]).toHaveLength(3);
    expect(new Set(opportunities.pairs[0]).size).toBe(3);
    expect(opportunities.optimalAmounts[0]).toBeGreaterThan(0n);
    expect(opportunities.profits[0]).toBeGreaterThan(TOKENS[0].minProfit);
  });

  test("does not report a route when fees make the cycle unprofitable", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("1000")),
      pair(2, tokenB, tokenC, tokenAmount("1000"), tokenAmount("1000")),
      pair(3, tokenC, tokenA, tokenAmount("1000"), tokenAmount("1000")),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.paths).toEqual([]);
    expect(opportunities.profits).toEqual([]);
    expect(opportunities.optimalAmounts).toEqual([]);
  });

  test("does not reuse the same pair to manufacture a false two-hop cycle", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("5000")),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.paths).toEqual([]);
  });

  test("keeps bigint precision for a tiny but real reserve imbalance", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, tokenAmount("1000000"), tokenAmount("1003000"), 1),
      pair(2, tokenB, tokenC, tokenAmount("1000000"), tokenAmount("1003000"), 1),
      pair(3, tokenC, tokenA, tokenAmount("1000000"), tokenAmount("1003000"), 1),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.paths.length).toBeGreaterThan(0);
    expect(opportunities.profits[0]).toBeGreaterThan(TOKENS[0].minProfit);
  });

  test("event-local search only returns routes touching affected pairs", () => {
    const changedPair = pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200"));
    const graph = buildGraph([
      changedPair,
      pair(2, tokenB, tokenC, tokenAmount("1000"), tokenAmount("2200")),
      pair(3, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")),
      pair(4, tokenA, tokenB, tokenAmount("1000"), tokenAmount("3000")),
      pair(5, tokenB, tokenC, tokenAmount("1000"), tokenAmount("3000")),
      pair(6, tokenC, tokenA, tokenAmount("1000"), tokenAmount("3000")),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
      changedPairs: [changedPair.pairAddress],
    });

    expect(opportunities.paths.length).toBeGreaterThan(0);
    for (const routePairs of opportunities.pairs) {
      expect(routePairs).toContain(changedPair.pairAddress);
    }
  });
});

