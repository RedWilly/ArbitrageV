const Q96 = BigInt(2) ** BigInt(96);
const Q192 = Q96 * Q96;

export type SwapDirection = 'token0ToToken1' | 'token1ToToken0';

export class V3SwapMath {
  // Basic conversion utilities
  static sqrtPriceX96ToFloat(sqrtPriceX96: bigint): number {
    return Number(sqrtPriceX96) / Number(Q96);
  }

  static floatToSqrtPriceX96(sqrtPrice: number): bigint {
    return BigInt(Math.round(sqrtPrice * Number(Q96)));
  }

  static getSqrtPriceFromTick(tick: number): bigint {
    return Q96 * BigInt(1.0001 ** tick);
  }

  static calculateV3SwapOutput(
    amountIn: bigint,
    currentTick: number,
    sqrtPriceX96: bigint,
    liquidity: bigint,
    fee: number,
    tickSpacing: number,
    direction: SwapDirection
  ): bigint {
    let remainingAmount = amountIn;
    let currentSqrtPrice = sqrtPriceX96;
    let outputAmount = 0n;
    
    while (remainingAmount > 0n) {
      const nextTick = this.getNextInitializedTick(currentTick, tickSpacing, direction);
      
      const virtualReserves = this.calculateVirtualReserves(
        currentSqrtPrice,
        liquidity,
        currentTick,
        nextTick
      );
      
      const { maxIn, maxOut } = this.calculateTickRangeIO(
        virtualReserves,
        currentSqrtPrice,
        direction
      );
      
      const swapResult = this.computeSwapStep(
        currentSqrtPrice,
        this.getSqrtPriceFromTick(nextTick),
        liquidity,
        remainingAmount,
        fee
      );
      
      remainingAmount -= swapResult.amountIn;
      outputAmount += swapResult.amountOut;
      currentSqrtPrice = swapResult.sqrtRatioNextX96;
      currentTick = nextTick;
    }
    
    return outputAmount;
  }

  static calculateVirtualReserves(
    currentSqrtPrice: bigint,
    liquidity: bigint,
    currentTick: number,
    nextTick: number
  ): { reserve0: bigint; reserve1: bigint } {
    const sqrtPriceLower = this.getSqrtPriceFromTick(currentTick);
    const sqrtPriceUpper = this.getSqrtPriceFromTick(nextTick);

    if (currentSqrtPrice <= sqrtPriceLower) {
      return {
        reserve0: 0n,
        reserve1: liquidity
      };
    } else if (currentSqrtPrice >= sqrtPriceUpper) {
      return {
        reserve0: liquidity,
        reserve1: 0n
      };
    } else {
      const reserve0 = this.calculateToken0Virtual(liquidity, sqrtPriceUpper, currentSqrtPrice);
      const reserve1 = this.calculateToken1Virtual(liquidity, currentSqrtPrice, sqrtPriceLower);
      return { reserve0, reserve1 };
    }
  }

  private static calculateToken0Virtual(
    liquidity: bigint,
    sqrtPriceUpperX96: bigint,
    sqrtPriceCurrentX96: bigint
  ): bigint {
    return (liquidity * (sqrtPriceUpperX96 - sqrtPriceCurrentX96)) / 
           (sqrtPriceCurrentX96 * sqrtPriceUpperX96);
  }

  private static calculateToken1Virtual(
    liquidity: bigint,
    sqrtPriceCurrentX96: bigint,
    sqrtPriceLowerX96: bigint
  ): bigint {
    return liquidity * (sqrtPriceCurrentX96 - sqrtPriceLowerX96);
  }

  static calculateTickRangeIO(
    virtualReserves: { reserve0: bigint; reserve1: bigint },
    currentSqrtPrice: bigint,
    direction: SwapDirection
  ): { maxIn: bigint; maxOut: bigint } {
    if (direction === 'token0ToToken1') {
      return {
        maxIn: virtualReserves.reserve0,
        maxOut: virtualReserves.reserve1
      };
    } else {
      return {
        maxIn: virtualReserves.reserve1,
        maxOut: virtualReserves.reserve0
      };
    }
  }

  static computeSwapStep(
    currentSqrtPrice: bigint,
    nextSqrtPrice: bigint,
    liquidity: bigint,
    amountIn: bigint,
    fee: number
  ): { amountIn: bigint; amountOut: bigint; sqrtRatioNextX96: bigint } {
    const feeMult = BigInt(Math.floor((1 - fee / 10000) * 1e6)) / BigInt(1e6);
    const amountInWithFee = (amountIn * feeMult);

    if (currentSqrtPrice <= nextSqrtPrice) {
      const amountOut = (amountInWithFee * currentSqrtPrice) / Q96;
      const sqrtRatioNextX96 = currentSqrtPrice + (amountInWithFee * Q96) / liquidity;
      return { amountIn, amountOut, sqrtRatioNextX96 };
    } else {
      const amountOut = liquidity * (currentSqrtPrice - nextSqrtPrice) / Q96;
      const sqrtRatioNextX96 = nextSqrtPrice;
      return { amountIn, amountOut, sqrtRatioNextX96 };
    }
  }

  static getNextInitializedTick(
    currentTick: number,
    tickSpacing: number,
    direction: SwapDirection
  ): number {
    const tickIncrement = direction === 'token0ToToken1' ? tickSpacing : -tickSpacing;
    return Math.floor((currentTick + tickIncrement) / tickSpacing) * tickSpacing;
  }
}
