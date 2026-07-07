import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { type CarbonStrategy } from "../src/market/carbon";
import { MarketGraph } from "../src/market-graph/market-graph";
import { type ArbitrageSearchPolicy } from "../src/market-graph/types";

const ONE = 1n << 48n;
const controller = address(1);
const tokenA = address(2);
const tokenB = address(3);

const policy: ArbitrageSearchPolicy = {
  topTokens: 1,
  allowedProtocols: ["carbon"],
  allowProtocolMixing: true,
  maxRouteEdges: 2,
  beamWidth: 8,
  optimizationIterations: 16,
  maxInputReserveFraction: 1n,
  maxOpportunities: 4,
};

describe("Carbon grouped edges", () => {
  test("keeps single strategies and adds a grouped source-to-target edge", () => {
    const graph = new MarketGraph(policy, []);
    graph.setCarbonStrategies([
      strategy(1n, 100n),
      strategy(2n, 100n),
    ]);

    const groupId = `carbon-group:${controller.toLowerCase()}:${tokenA.toLowerCase()}:${tokenB.toLowerCase()}`;
    const quote = graph.quote({
      path: [tokenA, tokenB],
      pools: [controller],
      edgeIds: [groupId],
      protocols: ["carbon"],
    }, 40n);

    expect(quote).toMatchObject({
      amountIn: 40n,
      amountOut: 160n,
      complete: true,
    });

    const tokenIndex = graph.tokenIndexOf(tokenA);
    expect(tokenIndex).toBeNumber();
    const groupEdgeIndex = graph.rankedEdgeIndexes(tokenIndex!, 8)
      .find(edgeIndex => graph.edgeAt(edgeIndex)?.id === groupId);
    expect(groupEdgeIndex).toBeNumber();
    expect(graph.carbonExecution(groupEdgeIndex!, 40n)).toEqual({
      rawFrom: tokenA,
      rawTo: tokenB,
      strategyIds: [1n, 2n],
      amounts: [25n, 15n],
    });
  });
});

function strategy(id: bigint, y: bigint): CarbonStrategy {
  return {
    id,
    owner: address(1000 + Number(id)),
    controller,
    token0: tokenA,
    token1: tokenB,
    feePpm: 0,
    orders: [
      { y: 0n, z: 0n, A: 0n, B: 0n },
      { y, z: 10n, A: 0n, B: encodeExpandedRate(2n * ONE) },
    ],
  };
}

function address(id: number): Address {
  return `0x${(70_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function encodeExpandedRate(value: bigint): bigint {
  let shift = 0n;
  let mantissa = value;
  while (mantissa >= ONE) {
    mantissa >>= 1n;
    shift++;
  }
  return mantissa | (shift << 48n);
}
