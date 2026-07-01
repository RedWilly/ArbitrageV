import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { type ReserveUpdate } from "../src/market/v2-types";
import { type V3PoolUpdate } from "../src/market/v3-types";
import { createReserveUpdateScheduler, createV3PoolUpdateScheduler } from "../src/runtime/event-scheduler";

function pairAddress(id: number): Address {
  return `0x${id.toString(16).padStart(40, "0")}` as Address;
}

function update(id: number, reserve: bigint): ReserveUpdate {
  return {
    pairAddress: pairAddress(id),
    reserve0: reserve,
    reserve1: reserve + 1n,
  };
}

function v3Update(id: number, sqrtPriceX96: bigint): V3PoolUpdate {
  return {
    poolAddress: pairAddress(id),
    sqrtPriceX96,
    liquidity: sqrtPriceX96 + 100n,
    tick: Number(sqrtPriceX96),
  };
}

describe("LatestUpdateScheduler", () => {
  test("serializes processing and keeps only the latest update per pair", async () => {
    const batches: ReserveUpdate[][] = [];
    let scheduler!: ReturnType<typeof createReserveUpdateScheduler>;
    let submittedDuringProcessing = false;

    scheduler = createReserveUpdateScheduler(async batch => {
      batches.push(batch);

      if (!submittedDuringProcessing) {
        submittedDuringProcessing = true;
        await scheduler.submit([
          update(1, 3n),
          update(2, 4n),
        ]);
      }
    });

    await scheduler.submit([
      update(1, 1n),
      update(1, 2n),
    ]);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([update(1, 2n)]);
    expect(batches[1]).toEqual([update(1, 3n), update(2, 4n)]);
  });

  test("keeps only the latest V3 pool state per pool", async () => {
    const batches: V3PoolUpdate[][] = [];
    const scheduler = createV3PoolUpdateScheduler(async batch => {
      batches.push(batch);
    });

    await scheduler.submit([
      v3Update(1, 10n),
      v3Update(1, 11n),
      v3Update(2, 20n),
    ]);

    expect(batches).toEqual([[
      v3Update(1, 11n),
      v3Update(2, 20n),
    ]]);
  });
});
