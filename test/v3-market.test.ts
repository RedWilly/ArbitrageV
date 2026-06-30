import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { TOKENS } from "../src/constants";
import { V3Market } from "../src/market/v3-market";
import { type V3PoolConfig } from "../src/market/v3-types";

const [tokenA, tokenB, tokenC] = TOKENS.map(({ address }) => address);

function poolAddress(id: number): Address {
  return `0x${(5_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function pool(
  id: number,
  token0: Address,
  token1: Address,
  fee: number,
  enabled = true,
): V3PoolConfig {
  return {
    name: `v3-pool-${id}`,
    address: poolAddress(id),
    token0,
    token1,
    fee,
    tickSpacing: fee === 500 ? 10 : 60,
    enabled,
  };
}

describe("V3Market", () => {
  test("loads only explicitly configured enabled pools", () => {
    const enabledPool = pool(1, tokenA, tokenB, 3000);
    const disabledPool = pool(2, tokenA, tokenC, 500, false);
    const market = new V3Market([enabledPool, disabledPool]);

    expect(market.poolAddresses()).toEqual([enabledPool.address]);
    expect(market.tokensList()).toEqual([tokenA, tokenB]);
    expect(market.pool(disabledPool.address)).toBeNull();
  });

  test("updates configured pool state and exposes directional edges", () => {
    const configuredPool = pool(1, tokenA, tokenB, 3000);
    const market = new V3Market([configuredPool]);

    market.updatePoolStates([{
      poolAddress: configuredPool.address,
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1_000_000n,
      tick: 0,
    }]);

    const token0Edge = market.edgeForTokenPool(tokenA, configuredPool.address);
    const token1Edge = market.edgeForTokenPool(tokenB, configuredPool.address);

    expect(token0Edge?.direction).toBe("token0ToToken1");
    expect(token0Edge?.to).toBe(tokenB);
    expect(token0Edge?.sqrtPriceX96).toBe(2n ** 96n);
    expect(token0Edge?.liquidity).toBe(1_000_000n);
    expect(token1Edge?.direction).toBe("token1ToToken0");
    expect(token1Edge?.to).toBe(tokenA);
    expect(token1Edge?.sqrtPriceX96).toBe(2n ** 96n);
  });

  test("ranks only pools with live liquidity", () => {
    const lowLiquidityPool = pool(1, tokenA, tokenB, 3000);
    const noStatePool = pool(2, tokenA, tokenC, 500);
    const highLiquidityPool = pool(3, tokenA, tokenC, 500);
    const market = new V3Market([lowLiquidityPool, noStatePool, highLiquidityPool]);

    market.updatePoolStates([
      {
        poolAddress: lowLiquidityPool.address,
        sqrtPriceX96: 2n ** 96n,
        liquidity: 100n,
        tick: 0,
      },
      {
        poolAddress: highLiquidityPool.address,
        sqrtPriceX96: 2n ** 96n,
        liquidity: 1_000n,
        tick: 0,
      },
    ]);

    const ranked = market.rankedEdges(tokenA, 10);

    expect(ranked.map(edge => edge.poolAddress)).toEqual([
      highLiquidityPool.address,
      lowLiquidityPool.address,
    ]);
    expect(ranked.every(edge => edge.liquidity > 0n)).toBe(true);
  });

  test("updates initialized ticks and removes empty ticks", () => {
    const configuredPool = pool(1, tokenA, tokenB, 3000);
    const market = new V3Market([configuredPool]);

    market.updateTicks([{
      poolAddress: configuredPool.address,
      ticks: [
        { index: -120, liquidityGross: 1_000n, liquidityNet: 1_000n },
        { index: 120, liquidityGross: 1_000n, liquidityNet: -1_000n },
      ],
    }]);

    expect(market.initializedTicks(configuredPool.address).map(tick => tick.index)).toEqual([-120, 120]);

    market.updateTicks([{
      poolAddress: configuredPool.address,
      ticks: [
        { index: -120, liquidityGross: 0n, liquidityNet: 0n },
      ],
    }]);

    expect(market.initializedTicks(configuredPool.address).map(tick => tick.index)).toEqual([120]);
  });
});
