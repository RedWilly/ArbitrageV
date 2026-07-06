import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { type ReserveUpdate } from "../src/market/v2-types";
import { type V3PoolUpdate } from "../src/market/v3-types";
import { LatestUpdateScheduler } from "../src/runtime/event-scheduler";

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
    let scheduler!: LatestUpdateScheduler<ReserveUpdate>;
    let submittedDuringProcessing = false;

    scheduler = new LatestUpdateScheduler(async batch => {
      batches.push(batch);

      if (!submittedDuringProcessing) {
        submittedDuringProcessing = true;
        await scheduler.submit([
          update(1, 3n),
          update(2, 4n),
        ]);
      }
    }, update => update.pairAddress.toLowerCase());

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
    const scheduler = new LatestUpdateScheduler<V3PoolUpdate>(async batch => {
      batches.push(batch);
    }, update => update.poolAddress.toLowerCase());

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
