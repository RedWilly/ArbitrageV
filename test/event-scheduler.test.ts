import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { type ReserveUpdate } from "../src/market/v2-types";
import { ReserveUpdateScheduler } from "../src/runtime/event-scheduler";

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

describe("ReserveUpdateScheduler", () => {
  test("serializes processing and keeps only the latest update per pair", async () => {
    const batches: ReserveUpdate[][] = [];
    let scheduler!: ReserveUpdateScheduler;
    let submittedDuringProcessing = false;

    scheduler = new ReserveUpdateScheduler(async batch => {
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
});
