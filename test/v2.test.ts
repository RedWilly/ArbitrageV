import { describe, expect, test } from "bun:test";
import { parseEther, type Address } from "viem";
import { ArbitrageGraph, type PairInfo } from "../src/graph";
import { ADDRESSES, minProfits } from "../src/constants";

const [tokenA, tokenB, tokenC] = ADDRESSES.map(({ address }) => address);

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

function buildGraph(pairs: PairInfo[]): ArbitrageGraph {
  const graph = new ArbitrageGraph();
  for (const pool of pairs) {
    graph.addPair(pool);
  }
  return graph;
}

describe("V2 arbitrage graph", () => {
  test("finds a profitable three-pool circular arbitrage route", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, parseEther("1000"), parseEther("2200")),
      pair(2, tokenB, tokenC, parseEther("1000"), parseEther("2200")),
      pair(3, tokenC, tokenA, parseEther("1000"), parseEther("2200")),
    ]);

    const opportunities = graph.findMultiTokenArbitrageOpportunities([tokenA], 3);

    expect(opportunities.paths.length).toBeGreaterThan(0);
    expect(opportunities.paths[0]).toEqual([tokenA, tokenB, tokenC, tokenA]);
    expect(opportunities.pairs[0]).toHaveLength(3);
    expect(new Set(opportunities.pairs[0]).size).toBe(3);
    expect(opportunities.optimalAmounts[0]).toBeGreaterThan(0n);
    expect(opportunities.profits[0]).toBeGreaterThan(minProfits[0]);
  });

  test("does not report a route when fees make the cycle unprofitable", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, parseEther("1000"), parseEther("1000")),
      pair(2, tokenB, tokenC, parseEther("1000"), parseEther("1000")),
      pair(3, tokenC, tokenA, parseEther("1000"), parseEther("1000")),
    ]);

    const opportunities = graph.findMultiTokenArbitrageOpportunities([tokenA], 3);

    expect(opportunities.paths).toEqual([]);
    expect(opportunities.profits).toEqual([]);
    expect(opportunities.optimalAmounts).toEqual([]);
  });

  test("does not reuse the same pair to manufacture a false two-hop cycle", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, parseEther("1000"), parseEther("5000")),
    ]);

    const opportunities = graph.findMultiTokenArbitrageOpportunities([tokenA], 2);

    expect(opportunities.paths).toEqual([]);
  });

  test("keeps bigint precision for a tiny but real reserve imbalance", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, parseEther("1000000"), parseEther("1003000"), 1),
      pair(2, tokenB, tokenC, parseEther("1000000"), parseEther("1003000"), 1),
      pair(3, tokenC, tokenA, parseEther("1000000"), parseEther("1003000"), 1),
    ]);

    const opportunities = graph.findMultiTokenArbitrageOpportunities([tokenA], 3);

    expect(opportunities.paths.length).toBeGreaterThan(0);
    expect(opportunities.profits[0]).toBeGreaterThan(minProfits[0]);
  });
});
