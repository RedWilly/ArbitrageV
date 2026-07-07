import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Address } from "viem";
import { ARBITRAGE_SEARCH_POLICY, TOKENS } from "../src/constants";
import { EventMonitor } from "../src/event";
import { type V3PoolConfig } from "../src/market/v3-types";
import { MarketGraph } from "../src/market-graph/market-graph";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";
import { Q96 } from "../src/pricing/v3-swap-math";
import { V2_SYNC_EVENT_ABI } from "../src/runtime/v2-events";
import { V3_POOL_EVENT_ABI } from "../src/runtime/v3-events";

const [token0, token1] = TOKENS.map(token => token.address);
const poolAddress = "0x0000000000000000000000000000000000000a11" as Address;
const owner = "0x0000000000000000000000000000000000000b01" as Address;

type V3MonitorInternals = {
  pairAddressMap: Map<string, Address>;
  v3PoolAddressMap: Map<string, Address>;
  handleSyncEvents(logs: any[]): Promise<void>;
  handleV3PoolEvents(logs: any[]): Promise<void>;
};

const pool: V3PoolConfig = {
  name: "test-v3",
  address: poolAddress,
  token0,
  token1,
  fee: 3000,
  tickSpacing: 60,
  enabled: true,
};

describe("EventMonitor V3 pool events", () => {
  test("keeps the latest V2 Sync by chain log order", async () => {
    const graph = new OpportunityEngine(
      ARBITRAGE_SEARCH_POLICY,
      new MarketGraph(ARBITRAGE_SEARCH_POLICY, [])
    );
    const pairAddress = "0x0000000000000000000000000000000000000a22" as Address;
    const monitor = new EventMonitor(graph, {
      account: { address: owner },
      client: { getTransactionCount: async () => 0 },
    }, {
      v2Pools: [{
        pairAddress,
        token0,
        token1,
        fee: 30,
      }],
    }) as unknown as V3MonitorInternals;
    monitor.pairAddressMap = new Map([[pairAddress.toLowerCase(), pairAddress]]);

    await monitor.handleSyncEvents([
      syncLog(pairAddress, 2, 200n, 201n),
      syncLog(pairAddress, 1, 100n, 101n),
    ]);

    expect(graph.getAllPairs()[0]).toMatchObject({
      pairAddress,
      reserve0: 200n,
      reserve1: 201n,
    });
  });

  test("applies mixed V3 logs in chain order before checking arbitrage", async () => {
    const graph = new OpportunityEngine(
      ARBITRAGE_SEARCH_POLICY,
      new MarketGraph(ARBITRAGE_SEARCH_POLICY, [pool])
    );
    graph.updateV3PoolStates([{
      poolAddress,
      sqrtPriceX96: Q96,
      liquidity: 1_000n,
      tick: 120,
    }]);

    const monitor = new EventMonitor(graph, {
      account: { address: owner },
      client: { getTransactionCount: async () => 0 },
    }, { v3Pools: [poolAddress] }) as unknown as V3MonitorInternals;
    monitor.v3PoolAddressMap = new Map([[poolAddress.toLowerCase(), poolAddress]]);

    await monitor.handleV3PoolEvents([
      swapLog(2, 1_600n),
      mintLog(1, 60, 180, 500n),
    ]);

    const live = graph.getV3Pools()[0].state;
    const ticks = graph.getV3InitializedTicks(poolAddress);

    expect(live?.liquidity).toBe(1_600n);
    expect(ticks).toEqual([
      { index: 60, liquidityGross: 500n, liquidityNet: 500n },
      { index: 180, liquidityGross: 500n, liquidityNet: -500n },
    ]);
  });
});

function syncLog(pairAddress: Address, logIndex: number, reserve0: bigint, reserve1: bigint): any {
  return {
    address: pairAddress,
    blockNumber: 1n,
    transactionIndex: 0,
    logIndex,
    topics: encodeEventTopics({
      abi: [V2_SYNC_EVENT_ABI[1]],
      eventName: "Sync",
    }),
    data: encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
      ],
      [reserve0, reserve1]
    ),
  };
}

function mintLog(logIndex: number, tickLower: number, tickUpper: number, amount: bigint): any {
  return {
    address: poolAddress,
    blockNumber: 1n,
    transactionIndex: 0,
    logIndex,
    topics: encodeEventTopics({
      abi: V3_POOL_EVENT_ABI,
      eventName: "Mint",
      args: { owner, tickLower, tickUpper },
    }),
    data: encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint128" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [owner, amount, 0n, 0n]
    ),
  };
}

function swapLog(logIndex: number, liquidity: bigint): any {
  return {
    address: poolAddress,
    blockNumber: 1n,
    transactionIndex: 0,
    logIndex,
    topics: encodeEventTopics({
      abi: V3_POOL_EVENT_ABI,
      eventName: "Swap",
      args: { sender: owner, recipient: owner },
    }),
    data: encodeAbiParameters(
      [
        { type: "int256" },
        { type: "int256" },
        { type: "uint160" },
        { type: "uint128" },
        { type: "int24" },
      ],
      [1n, -1n, Q96 + 1n, liquidity, 120]
    ),
  };
}
