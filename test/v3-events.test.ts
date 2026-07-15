import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Address } from "viem";
import { ARBITRAGE_SEARCH_POLICY, CONTRACTS, TOKENS } from "../src/constants";
import { EventMonitor } from "../src/runtime/event-monitor";
import { type V3PoolConfig } from "../src/protocols/v3/types";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";
import { Q96 } from "../src/protocols/v3/quote";
import { V2_SYNC_EVENT_ABI } from "../src/protocols/v2/events";
import { V3_POOL_EVENT_ABI } from "../src/protocols/v3/events";
import { V2EventAdapter } from "../src/protocols/v2/runtime";
import { V3EventAdapter } from "../src/protocols/v3/runtime";

const [token0, token1] = TOKENS.map(token => token.address);
const poolAddress = "0x0000000000000000000000000000000000000a11" as Address;
const owner = "0x0000000000000000000000000000000000000b01" as Address;

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
  test("uses one feed for startup buffering and rejects stale live logs", async () => {
    const graph = new OpportunityEngine(ARBITRAGE_SEARCH_POLICY, []);
    const pairAddress = "0x0000000000000000000000000000000000000a22" as Address;
    const feed = fakeEventClient([[200n, 201n, BigInt(Math.floor(Date.now() / 1000))]]);
    const monitor = new EventMonitor({ client: feed.client }, [
      new V2EventAdapter(feed.client, graph, [{
        pairAddress, token0, token1, fee: 30, factory: '',
        variant: 'uniswap-v2', scale0: 1n, scale1: 1n,
      }], async () => {}),
    ]);

    await monitor.startBuffering();
    await feed.emit([syncLog(pairAddress, 1, 200n, 201n, 2n)]);
    expect(graph.getAllPairs()).toHaveLength(0);

    await monitor.activate();
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 200n, reserve1: 201n });

    await feed.emit([syncLog(pairAddress, 9, 100n, 101n, 1n)]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 200n, reserve1: 201n });

    await feed.emit([syncLog(pairAddress, 0, 300n, 301n, 3n)]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 300n, reserve1: 301n });
    await monitor.stop();
  });

  test("keeps the latest V2 Sync by chain log order", async () => {
    const graph = new OpportunityEngine(
      ARBITRAGE_SEARCH_POLICY,
      []
    );
    const pairAddress = "0x0000000000000000000000000000000000000a22" as Address;
    const feed = fakeEventClient();
    const monitor = new EventMonitor({ client: feed.client }, [
      new V2EventAdapter(feed.client, graph, [{
        pairAddress,
        token0,
        token1,
        fee: 30,
        factory: '',
        variant: 'uniswap-v2',
        scale0: 1n,
        scale1: 1n,
      }], async () => {}),
    ]);
    await monitor.start();

    await feed.emit([
      syncLog(pairAddress, 2, 200n, 201n),
      syncLog(pairAddress, 1, 100n, 101n),
    ]);

    expect(graph.getAllPairs()[0]).toMatchObject({
      pairAddress,
      reserve0: 200n,
      reserve1: 201n,
    });
    await monitor.stop();
  });

  test("rejects logs older than the hydration floor", async () => {
    const graph = new OpportunityEngine(ARBITRAGE_SEARCH_POLICY, []);
    const pairAddress = "0x0000000000000000000000000000000000000a22" as Address;
    const feed = fakeEventClient();
    graph.addPair({
      pairAddress, token0, token1, reserve0: 200n, reserve1: 201n, fee: 30,
      variant: "uniswap-v2", scale0: 1n, scale1: 1n,
    });
    const monitor = new EventMonitor({ client: feed.client }, [
      new V2EventAdapter(feed.client, graph, [{
        pairAddress, token0, token1, fee: 30, factory: "",
        variant: "uniswap-v2", scale0: 1n, scale1: 1n,
      }], async () => {}),
    ]);

    await monitor.startBuffering();
    await monitor.activate(2n);
    await feed.emit([syncLog(pairAddress, 0, 100n, 101n, 1n)]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 200n, reserve1: 201n });

    await feed.emit([syncLog(pairAddress, 0, 300n, 301n, 3n)]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 300n, reserve1: 301n });
    await monitor.stop();
  });

  test("reconciles selected markets and versions them at the current head", async () => {
    const graph = new OpportunityEngine(ARBITRAGE_SEARCH_POLICY, []);
    const pairAddress = "0x0000000000000000000000000000000000000a22" as Address;
    const feed = fakeEventClient([[300n, 301n, 1n]], 10n);
    graph.addPair({
      pairAddress, token0, token1, reserve0: 100n, reserve1: 101n, fee: 30,
      variant: "uniswap-v2", scale0: 1n, scale1: 1n,
    });
    const monitor = new EventMonitor({ client: feed.client }, [
      new V2EventAdapter(feed.client, graph, [{
        pairAddress, token0, token1, fee: 30, factory: "",
        variant: "uniswap-v2", scale0: 1n, scale1: 1n,
      }], async () => {}),
    ]);

    await monitor.start();
    await monitor.reconcileMarkets([pairAddress]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 300n, reserve1: 301n });

    await feed.emit([syncLog(pairAddress, 0, 200n, 201n, 10n)]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 300n, reserve1: 301n });
    await monitor.stop();
  });

  test("applies mixed V3 logs in chain order before checking arbitrage", async () => {
    const graph = new OpportunityEngine(
      ARBITRAGE_SEARCH_POLICY,
      [pool]
    );
    graph.updateV3PoolStates([{
      poolAddress,
      sqrtPriceX96: Q96,
      liquidity: 1_000n,
      tick: 120,
    }]);

    const feed = fakeEventClient([[
      [poolAddress, Q96 + 1n, 120, 1_600n],
      [[0, 1n]],
      [[60, 500n, 500n, true], [180, 500n, -500n, true]],
    ]]);
    const monitor = new EventMonitor({ client: feed.client }, [
      new V3EventAdapter(feed.client, graph, [pool], async () => {}),
    ]);
    await monitor.start();

    await feed.emit([
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
    await monitor.stop();
  });

  test("refreshes a V3 pool touched by startup liquidity instead of replaying its delta", async () => {
    const previousFlashQuery = CONTRACTS.flashQuery;
    (CONTRACTS as any).flashQuery = "0x0000000000000000000000000000000000000999";
    const graph = new OpportunityEngine(ARBITRAGE_SEARCH_POLICY, [pool]);
    const feed = fakeEventClient([[
      [poolAddress, Q96 + 2n, 120, 2_000n],
      [[0, 1n]],
      [[60, 700n, 700n, true], [180, 700n, -700n, true]],
    ]]);
    const monitor = new EventMonitor({ client: feed.client }, [
      new V3EventAdapter(feed.client, graph, [pool], async () => {}),
    ]);

    try {
      await monitor.startBuffering();
      await feed.emit([mintLog(1, 60, 180, 500n)]);
      await monitor.activate();

      expect(graph.getV3Pools()[0].state).toEqual({
        sqrtPriceX96: Q96 + 2n,
        liquidity: 2_000n,
        tick: 120,
      });
      expect(graph.getV3InitializedTicks(poolAddress)).toEqual([
        { index: 60, liquidityGross: 700n, liquidityNet: 700n },
        { index: 180, liquidityGross: 700n, liquidityNet: -700n },
      ]);
    } finally {
      await monitor.stop();
      (CONTRACTS as any).flashQuery = previousFlashQuery;
    }
  });
});

function fakeEventClient(readResult?: unknown, blockNumber = 1n): { client: any; emit(logs: any[]): Promise<void> } {
  let onLogs: ((logs: any[]) => void | Promise<void>) | undefined;
  return {
    client: {
      watchContractEvent: async (options: { onLogs: typeof onLogs }) => {
        onLogs = options.onLogs;
        return () => {};
      },
      readContract: async () => readResult,
      getBlockNumber: async () => blockNumber,
    },
    async emit(logs) {
      if (!onLogs) throw new Error('event monitor is not started');
      await onLogs(logs);
    },
  };
}

function syncLog(
  pairAddress: Address,
  logIndex: number,
  reserve0: bigint,
  reserve1: bigint,
  blockNumber = 1n
): any {
  return {
    address: pairAddress,
    blockNumber,
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
