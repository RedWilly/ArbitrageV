import { type Address } from 'viem';
import { V3Market } from '../market/v3-market';
import { type V3PoolInfo, type V3SwapDirection } from '../market/v3-types';
import { type V2SearchPolicy } from '../market/v2-types';
import { quoteV3MultiRangeExactInput } from './v3-swap-math';

export type V3Route = {
  path: Address[];
  pools: Address[];
  directions: V3SwapDirection[];
};

export type V3RouteQuote = {
  amountIn: bigint;
  amountOut: bigint;
  profit: bigint;
  complete: boolean;
};

export type V3SizedRoute = {
  profit: bigint;
  optimalInput: bigint;
  complete: boolean;
};

export class V3RouteSizer {
  constructor(
    private readonly market: V3Market,
    private readonly policy: V2SearchPolicy
  ) {}

  quote(route: V3Route, amountIn: bigint): V3RouteQuote {
    if (amountIn <= 0n) {
      return { amountIn, amountOut: 0n, profit: 0n, complete: false };
    }

    let amount = amountIn;

    for (let i = 0; i < route.pools.length; i++) {
      const pool = this.market.pool(route.pools[i]);
      if (!pool?.state || pool.state.liquidity <= 0n) {
        return { amountIn, amountOut: 0n, profit: -1n, complete: false };
      }

      const quote = quoteV3MultiRangeExactInput({
        amountIn: amount,
        sqrtPriceX96: pool.state.sqrtPriceX96,
        liquidity: pool.state.liquidity,
        tick: pool.state.tick,
        fee: pool.fee,
        direction: route.directions[i],
        ticks: this.market.initializedTicks(pool.address),
      });

      if (quote.exhaustedLiquidity || quote.amountOut <= 0n) {
        return { amountIn, amountOut: quote.amountOut, profit: -1n, complete: false };
      }

      amount = quote.amountOut;
    }

    return {
      amountIn,
      amountOut: amount,
      profit: amount - amountIn,
      complete: true,
    };
  }

  size(route: V3Route): V3SizedRoute {
    let low = 1n;
    let high = this.maxInputBound(route);

    while (high > low && !this.quote(route, high).complete) {
      high /= 2n;
    }

    if (high <= low) {
      return { profit: 0n, optimalInput: 0n, complete: false };
    }

    for (let i = 0; i < this.policy.optimizationIterations && high - low > 3n; i++) {
      const third = (high - low) / 3n;
      if (third === 0n) break;

      const mid1 = low + third;
      const mid2 = high - third;
      const profit1 = this.quoteProfit(route, mid1);
      const profit2 = this.quoteProfit(route, mid2);

      if (profit1 < profit2) {
        low = mid1 + 1n;
      } else {
        high = mid2 - 1n;
      }
    }

    return this.bestFinalCandidate(route, low, high);
  }

  private quoteProfit(route: V3Route, amountIn: bigint): bigint {
    const quote = this.quote(route, amountIn);
    return quote.complete ? quote.profit : -1n;
  }

  private maxInputBound(route: V3Route): bigint {
    let bound: bigint | null = null;

    for (const poolAddress of route.pools) {
      const pool = this.market.pool(poolAddress);
      const candidate = pool ? this.maxInputForPool(pool) : 0n;
      if (candidate <= 0n) return 0n;
      bound = bound === null || candidate < bound ? candidate : bound;
    }

    return bound ?? 0n;
  }

  private maxInputForPool(pool: V3PoolInfo): bigint {
    if (!pool.state || pool.state.liquidity <= 0n) return 0n;
    return pool.state.liquidity / this.policy.maxInputReserveFraction;
  }

  private bestFinalCandidate(route: V3Route, low: bigint, high: bigint): V3SizedRoute {
    const center = (low + high) / 2n;
    const candidates = new Set<bigint>([low, center, high]);

    for (let offset = 1n; offset <= 5n; offset++) {
      if (center > offset) candidates.add(center - offset);
      candidates.add(center + offset);
    }

    let profit = 0n;
    let optimalInput = 0n;
    let complete = false;

    for (const input of candidates) {
      if (input < low || input > high) continue;
      const quote = this.quote(route, input);
      if (quote.complete && quote.profit > profit) {
        profit = quote.profit;
        optimalInput = input;
        complete = true;
      }
    }

    return { profit, optimalInput, complete };
  }
}
