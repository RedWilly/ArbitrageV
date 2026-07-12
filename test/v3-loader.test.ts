import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { CONTRACTS } from "../src/constants";
import {
  applyV3StartupStates,
  buildV3StartupRequests,
  loadConfiguredV3StartupState,
  normalizeV3StartupStates,
  toV3BitmapWordUpdates,
  toV3PoolUpdates,
  toV3TickUpdates,
} from "../src/protocols/v3/runtime";
import { type V3PoolConfig } from "../src/protocols/v3/types";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";

function address(id: number): Address {
  return `0x${id.toString(16).padStart(40, "0")}` as Address;
}

function pool(id: number): V3PoolConfig {
  return {
    name: `pool-${id}`,
    address: address(id),
    token0: address(100 + id),
    token1: address(200 + id),
    fee: 3000,
    tickSpacing: 60,
    enabled: true,
  };
}

describe("V3 startup loader", () => {
  test("normalizes tuple-shaped startup state from the flash query contract", () => {
    const raw = [[
      [address(1), 2n ** 96n, -120, 1_000_000n],
      [
        [-1, 123n],
        [0, 456n],
      ],
      [
        [-120, 1_000n, 1_000n, true],
        [120, 1_000n, -1_000n, true],
        [180, 0n, 0n, false],
      ],
    ]];

    const [state] = normalizeV3StartupStates(raw);

    expect(state.poolAddress).toBe(address(1));
    expect(state.sqrtPriceX96).toBe(2n ** 96n);
    expect(state.tick).toBe(-120);
    expect(state.liquidity).toBe(1_000_000n);
    expect(state.bitmapWords).toEqual([
      { wordPosition: -1, bitmap: 123n },
      { wordPosition: 0, bitmap: 456n },
    ]);
    expect(state.ticks).toEqual([
      { index: -120, liquidityGross: 1_000n, liquidityNet: 1_000n, initialized: true },
      { index: 120, liquidityGross: 1_000n, liquidityNet: -1_000n, initialized: true },
      { index: 180, liquidityGross: 0n, liquidityNet: 0n, initialized: false },
    ]);
  });

  test("converts startup states into market updates", () => {
    const [state] = normalizeV3StartupStates([[
      [address(1), 2n ** 96n, 0, 1_000_000n],
      [[0, 456n]],
      [
        [-120, 1_000n, 1_000n, true],
        [180, 0n, 0n, false],
      ],
    ]]);

    expect(toV3PoolUpdates([state])).toEqual([{
      poolAddress: address(1),
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1_000_000n,
      tick: 0,
    }]);
    expect(toV3BitmapWordUpdates([state])).toEqual([{
      poolAddress: address(1),
      words: [{ wordPosition: 0, bitmap: 456n }],
    }]);
    expect(toV3TickUpdates([state])).toEqual([{
      poolAddress: address(1),
      ticks: [{ index: -120, liquidityGross: 1_000n, liquidityNet: 1_000n }],
    }]);
  });

  test("applies startup state into the engine V3 market", () => {
    const configuredPool = pool(1);
    const engine = new OpportunityEngine();
    engine.addV3Pool(configuredPool);

    const [state] = normalizeV3StartupStates([[
      [configuredPool.address, 2n ** 96n, 0, 1_000_000n],
      [[0, 456n]],
      [[-120, 1_000n, 1_000n, true]],
    ]]);

    applyV3StartupStates(engine, [state]);

    const storedPool = engine.getV3Pools().find(pool => pool.address === configuredPool.address);
    expect(storedPool).toBeDefined();
    expect(storedPool!.state).toEqual({
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1_000_000n,
      tick: 0,
    });
    expect(engine.getV3BitmapWords(configuredPool.address)).toEqual([
      { wordPosition: 0, bitmap: 456n },
    ]);
    expect(engine.getV3InitializedTicks(configuredPool.address)).toEqual([
      { index: -120, liquidityGross: 1_000n, liquidityNet: 1_000n },
    ]);
  });

  test("builds batched startup requests from configured pools", () => {
    const requests = buildV3StartupRequests([pool(1), pool(2), pool(3)], {
      batchSize: 2,
    });

    expect(requests).toEqual([
      {
        poolAddresses: [address(1), address(2)],
        tickSpacings: [60, 60],
      },
      {
        poolAddresses: [address(3)],
        tickSpacings: [60],
      },
    ]);
  });

  test("loads configured pools through the deep startup query in batches", async () => {
    (CONTRACTS as any).flashQuery = address(999);

    const calls: any[] = [];
    const client = {
      async readContract(parameters: any): Promise<unknown> {
        calls.push(parameters);
        return parameters.args[0].map((poolAddress: Address) => [
          [poolAddress, 2n ** 96n, 0, 1_000_000n],
          [[0, 456n]],
          [[-120, 1_000n, 1_000n, true]],
        ]);
      },
    };
    const engine = new OpportunityEngine();

    const result = await loadConfiguredV3StartupState(client, engine, [pool(1), pool(2), pool(3)], {
      batchSize: 2,
    });

    expect(calls.map(call => call.functionName)).toEqual([
      "getV3StartupStatesAroundCurrentTick",
      "getV3StartupStatesAroundCurrentTick",
    ]);
    expect(calls[0].args).toEqual([
      [address(1), address(2)],
      [60, 60],
    ]);
    expect(calls[1].args).toEqual([
      [address(3)],
      [60],
    ]);
    expect(result).toEqual({
      configuredPools: 3,
      loadedPools: 3,
      loadedBitmapWords: 3,
      loadedTicks: 3,
    });
  });
});
