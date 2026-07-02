import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { TOKENS } from "../src/constants";
import { type PairInfo } from "../src/market/v2-types";
import { type V3PoolConfig } from "../src/market/v3-types";
import { MarketGraph } from "../src/market-graph/market-graph";
import { type ArbitrageSearchPolicy } from "../src/market-graph/types";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";
import { Q96 } from "../src/pricing/v3-swap-math";
import { tokenAmount } from "../src/values";

const [tokenA, tokenB, tokenC] = TOKENS.map(({ address }) => address);

const UNIFIED_V2_DISTRACTORS = Number(15_000);
const UNIFIED_V3_DISTRACTORS = Number(5_000);
const UNIFIED_SEARCH_LIMIT_MS = Number(1_250);

const stressPolicy: ArbitrageSearchPolicy = {
  topTokens: 1,
  routeMode: "circular",
  allowedProtocols: ["v2", "v3"],
  allowProtocolMixing: true,
  maxRouteEdges: 4,
  beamWidth: 8,
  optimizationIterations: 80,
  maxInputReserveFraction: 100n,
  maxOpportunities: 8,
};

function tokenAddress(id: number): Address {
  return `0x${(30_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function pairAddress(id: number): Address {
  return `0x${(40_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function poolAddress(id: number): Address {
  return `0x${(50_000_000 + id).toString(16).padStart(40, "0")}` as Address;
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

function pool(id: number, token0: Address, token1: Address, fee = 500): V3PoolConfig {
  return {
    name: `unified-stress-${id}`,
    address: poolAddress(id),
    token0,
    token1,
    fee,
    tickSpacing: 10,
    enabled: true,
  };
}

function addLivePool(
  engine: OpportunityEngine,
  config: V3PoolConfig,
  sqrtPriceX96 = Q96,
  liquidity = 10n ** 24n,
): void {
  engine.addV3Pool(config);
  engine.updateV3PoolStates([{
    poolAddress: config.address,
    sqrtPriceX96,
    liquidity,
    tick: 0,
  }]);
}

function createUnifiedStressMarket(): {
  engine: OpportunityEngine;
  changedPair: PairInfo;
  mixedPool: V3PoolConfig;
} {
  const engine = new OpportunityEngine(stressPolicy, new MarketGraph(stressPolicy, []));

  for (let i = 0; i < UNIFIED_V2_DISTRACTORS; i++) {
    engine.addPair(pair(
      10_000 + i,
      tokenA,
      tokenAddress(i),
      tokenAmount("1000000"),
      tokenAmount("999000"),
    ));
  }

  for (let i = 0; i < UNIFIED_V3_DISTRACTORS; i++) {
    addLivePool(engine, pool(
      20_000 + i,
      tokenA,
      tokenAddress(UNIFIED_V2_DISTRACTORS + i),
    ), Q96, 10n ** 18n);
  }

  const changedPair = pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200"));
  const closingPair = pair(2, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200"));
  const mixedPool = pool(1, tokenB, tokenC);

  engine.addPair(changedPair);
  engine.addPair(closingPair);
  addLivePool(engine, mixedPool, Q96 * 2n, 10n ** 24n);

  return {
    engine,
    changedPair,
    mixedPool,
  };
}

describe("Unified graph stress", () => {
  test("finds a profitable mixed route with many V2 and V3 distractors", () => {
    const { engine, changedPair, mixedPool } = createUnifiedStressMarket();

    const startedAt = performance.now();
    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
      changedPairs: [changedPair.pairAddress],
    });
    const elapsedMs = performance.now() - startedAt;

    expect(opportunities.paths.length).toBeGreaterThan(0);
    expect(new Set(opportunities.protocols[0]).size).toBeGreaterThan(1);
    expect(opportunities.pairs[0]).toContain(changedPair.pairAddress);
    expect(opportunities.pairs[0]).toContain(mixedPool.address);
    expect(typeof opportunities.profits[0]).toBe("bigint");
    expect(typeof opportunities.optimalAmounts[0]).toBe("bigint");
    expect(elapsedMs).toBeLessThan(UNIFIED_SEARCH_LIMIT_MS);
  });

  test("event-local update scan stays bounded on the unified graph", () => {
    const { engine, changedPair } = createUnifiedStressMarket();

    const startedAt = performance.now();
    engine.updateReserves([{
      pairAddress: changedPair.pairAddress,
      reserve0: tokenAmount("1000"),
      reserve1: tokenAmount("2500"),
    }]);
    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
      changedPairs: [changedPair.pairAddress],
    });
    const elapsedMs = performance.now() - startedAt;

    expect(opportunities.paths.length).toBeGreaterThan(0);
    for (const routePools of opportunities.pairs) {
      expect(routePools).toContain(changedPair.pairAddress);
    }
    expect(elapsedMs).toBeLessThan(UNIFIED_SEARCH_LIMIT_MS);
  });

  test("protocol mixing policy blocks mixed opportunities under load", () => {
    const { changedPair, mixedPool } = createUnifiedStressMarket();
    const engine = new OpportunityEngine({
      ...stressPolicy,
      allowProtocolMixing: false,
    }, new MarketGraph({ ...stressPolicy, allowProtocolMixing: false }, []));
    engine.addPair(changedPair);
    engine.addPair(pair(2, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")));
    addLivePool(engine, mixedPool, Q96 * 2n, 10n ** 24n);

    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
      changedPairs: [changedPair.pairAddress],
    });

    expect(opportunities.paths).toEqual([]);
  });
});
