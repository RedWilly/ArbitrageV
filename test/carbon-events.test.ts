import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { CarbonStrategyStore, type CarbonPairMetadata } from "../src/market/carbon";

const controller = "0x0000000000000000000000000000000000000c01" as Address;
const token0 = "0x0000000000000000000000000000000000000c02" as Address;
const token1 = "0x0000000000000000000000000000000000000c03" as Address;

const pair: CarbonPairMetadata = {
  controller,
  token0,
  token1,
  strategyCount: 1,
  feePpm: 4000,
};

describe("CarbonStrategyStore events", () => {
  test("updates strategy state from StrategyUpdated without runtime refetch", async () => {
    const client = {
      readContract: async () => {
        throw new Error("unexpected runtime Carbon refetch");
      },
    };
    let notified = 0;
    let changedPoolKeys: readonly string[] = [];
    let strategies: readonly unknown[] = [];
    const store = new CarbonStrategyStore(client, [pair], (nextStrategies, keys) => {
      notified++;
      strategies = nextStrategies;
      changedPoolKeys = keys;
    });

    await store.handleEvents(controller, [{
      eventName: "StrategyUpdated",
      args: {
        id: 12n,
        token0,
        token1,
        order0: order(1_000n),
        order1: order(2_000n),
      },
    }]);

    expect(store.stats()).toEqual({ strategyCount: 1, pairCount: 1 });
    expect(strategies[0]).toMatchObject({
      id: 12n,
      feePpm: 4000,
      orders: [order(1_000n), order(2_000n)],
    });
    expect(notified).toBe(1);
    expect(changedPoolKeys).toEqual([
      `carbon:${controller.toLowerCase()}:12`,
      `carbon-group:${controller.toLowerCase()}:${token0.toLowerCase()}:${token1.toLowerCase()}`,
      `carbon-group:${controller.toLowerCase()}:${token1.toLowerCase()}:${token0.toLowerCase()}`,
    ]);
  });
});

function order(y: bigint) {
  return {
    y,
    z: y,
    A: 0n,
    B: 1n,
  };
}
