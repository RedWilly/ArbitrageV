import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { TOKENS } from "../src/constants";
import { V2Market } from "../src/market/v2-market";
import { V3Market } from "../src/market/v3-market";
import { type V3PoolConfig } from "../src/market/v3-types";
import { type ArbitrageSearchPolicy } from "../src/market-graph/types";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";
import { V3RouteSizer } from "../src/pricing/v3-route-sizer";
import { Q96 } from "../src/pricing/v3-swap-math";
import { type PairInfo } from "../src/market/v2-types";
import { tokenAmount } from "../src/values";

const [tokenA, tokenB, tokenC] = TOKENS.map(({ address }) => address);

const policy: ArbitrageSearchPolicy = {
  topTokens: 1,
  routeMode: "circular",
  allowedProtocols: ["v2", "v3"],
  allowProtocolMixing: true,
  maxRouteEdges: 3,
  beamWidth: 5,
  optimizationIterations: 40,
  maxInputReserveFraction: 100n,
  maxOpportunities: 5,
};

function poolAddress(id: number): Address {
  return `0x${(9_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function pairAddress(id: number): Address {
  return `0x${(8_000_000 + id).toString(16).padStart(40, "0")}` as Address;
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
    name: `v3-strategy-${id}`,
    address: poolAddress(id),
    token0,
    token1,
    fee,
    tickSpacing: 10,
    enabled: true,
  };
}

function addLivePool(
  market: V3Market,
  config: V3PoolConfig,
  sqrtPriceX96 = Q96 * 2n,
  liquidity = 10n ** 24n,
): void {
  market.addPool(config);
  market.updatePoolStates([{
    poolAddress: config.address,
    sqrtPriceX96,
    liquidity,
    tick: 0,
  }]);
}

describe("V3 arbitrage strategy", () => {
  test("marks a route quote incomplete when it runs beyond loaded tick data", () => {
    const market = new V3Market([]);
    const configuredPool = pool(1, tokenA, tokenB);
    addLivePool(market, configuredPool, Q96, 1_000n);
    const sizer = new V3RouteSizer(market, policy);

    const quote = sizer.quote({
      path: [tokenA, tokenB],
      pools: [configuredPool.address],
      directions: ["token0ToToken1"],
    }, 10n ** 30n);

    expect(quote.complete).toBe(false);
  });

  test("finds a complete profitable V3 circular opportunity", () => {
    const v3Market = new V3Market([]);
    const poolAB = pool(1, tokenA, tokenB);
    const poolBC = pool(2, tokenB, tokenC);
    const poolCA = pool(3, tokenC, tokenA);

    addLivePool(v3Market, poolAB);
    addLivePool(v3Market, poolBC);
    addLivePool(v3Market, poolCA);

    const engine = new OpportunityEngine(policy, new V2Market(), v3Market);
    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.paths.length).toBeGreaterThan(0);
    expect(opportunities.routeKinds[0]).toBe("v3");
    expect(opportunities.paths[0]).toEqual([tokenA, tokenB, tokenC, tokenA]);
    expect(opportunities.pairs[0]).toEqual([poolAB.address, poolBC.address, poolCA.address]);
    expect(opportunities.profits[0]).toBeGreaterThan(TOKENS[0].minProfit);
    expect(opportunities.optimalAmounts[0]).toBeGreaterThan(0n);
  });

  test("finds a mixed V2 to V3 to V2 circular opportunity", () => {
    const v2Market = new V2Market();
    const pairAB = pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200"));
    const pairCA = pair(2, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200"));
    v2Market.addPair(pairAB);
    v2Market.addPair(pairCA);

    const v3Market = new V3Market([]);
    const poolBC = pool(1, tokenB, tokenC);
    addLivePool(v3Market, poolBC);

    const engine = new OpportunityEngine(policy, v2Market, v3Market);
    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.paths.length).toBeGreaterThan(0);
    expect(opportunities.routeKinds[0]).toBe("mixed");
    expect(opportunities.paths[0]).toEqual([tokenA, tokenB, tokenC, tokenA]);
    expect(opportunities.pairs[0]).toEqual([pairAB.pairAddress, poolBC.address, pairCA.pairAddress]);
    expect(opportunities.profits[0]).toBeGreaterThan(TOKENS[0].minProfit);
    expect(opportunities.optimalAmounts[0]).toBeGreaterThan(0n);
  });

  test("blocks mixed routes when protocol mixing is disabled", () => {
    const v2Market = new V2Market();
    v2Market.addPair(pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200")));
    v2Market.addPair(pair(2, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")));

    const v3Market = new V3Market([]);
    addLivePool(v3Market, pool(1, tokenB, tokenC));

    const engine = new OpportunityEngine({
      ...policy,
      allowProtocolMixing: false,
    }, v2Market, v3Market);

    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.paths).toEqual([]);
  });

  test("selects the best non-route flash pool across V2 and V3", () => {
    const v2Market = new V2Market();
    const routePair = pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200"));
    const fallbackPair = pair(2, tokenA, tokenC, tokenAmount("10000"), tokenAmount("10000"));
    v2Market.addPair(routePair);
    v2Market.addPair(fallbackPair);

    const v3Market = new V3Market([]);
    const v3FlashPool = pool(3, tokenA, tokenC);
    addLivePool(v3Market, v3FlashPool, Q96, 10n ** 24n);

    const engine = new OpportunityEngine(policy, v2Market, v3Market);
    const flashPool = engine.findBestFlashPoolForToken(tokenA, 1_000n, [routePair.pairAddress]);

    expect(flashPool?.protocol).toBe("v3");
    expect(flashPool?.poolAddress).toBe(v3FlashPool.address);
  });
});
