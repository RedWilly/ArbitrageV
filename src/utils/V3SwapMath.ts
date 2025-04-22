const Q96 = BigInt(2) ** BigInt(96);
const Q192 = Q96 * Q96;

export type SwapDirection = 'token0ToToken1' | 'token1ToToken0';

export class V3SwapMath {
  // Convert sqrtPriceX96 (Q64.96) to a float with more precision
  static sqrtPriceX96ToFloat(sqrtPriceX96: bigint): number {
    return Number(sqrtPriceX96) / Number(Q96);
  }

  // Convert float sqrtPrice to Q64.96 with proper rounding
  static floatToSqrtPriceX96(sqrtPrice: number): bigint {
    return BigInt(Math.round(sqrtPrice * Number(Q96)));
  }

  // More precise calculation for token0 → token1
  private static getAmountOutToken0ToToken1(
    liquidity: bigint,
    sqrtPriceX96Before: bigint,
    sqrtPriceX96After: bigint
  ): bigint {
    if (sqrtPriceX96After <= sqrtPriceX96Before) return BigInt(0);
    const delta = sqrtPriceX96After - sqrtPriceX96Before;
    return (liquidity * delta * Q96) / (sqrtPriceX96Before * sqrtPriceX96After);
  }

  // More precise calculation for token1 → token0
  private static getAmountOutToken1ToToken0(
    liquidity: bigint,
    sqrtPriceX96Before: bigint,
    sqrtPriceX96After: bigint
  ): bigint {
    if (sqrtPriceX96After >= sqrtPriceX96Before) return BigInt(0);
    const numerator = liquidity * (sqrtPriceX96Before - sqrtPriceX96After) * Q96;
    const denominator = sqrtPriceX96Before * sqrtPriceX96After;
    return numerator / denominator;
  }

  static getAmountOut(
    direction: SwapDirection,
    liquidity: bigint,
    sqrtPriceX96Before: bigint,
    sqrtPriceX96After: bigint
  ): bigint {
    try {
      return direction === 'token0ToToken1'
        ? this.getAmountOutToken0ToToken1(liquidity, sqrtPriceX96Before, sqrtPriceX96After)
        : this.getAmountOutToken1ToToken0(liquidity, sqrtPriceX96Before, sqrtPriceX96After);
    } catch (e) {
      console.error('V3SwapMath.getAmountOut error:', e);
      return BigInt(0);
    }
  }

  /**
   * More accurate first derivative calculation
   */
  static getAmountOutFirstDerivative(
    direction: SwapDirection,
    liquidity: bigint,
    sqrtPriceX96Before: bigint,
    sqrtPriceX96After: bigint,
    fee: number
  ): number {
    const feeMult = 1 - fee / 10000;
    const priceAfter = (Number(sqrtPriceX96After) / Number(Q96)) ** 2;
    
    if (direction === 'token0ToToken1') {
      return priceAfter * feeMult;
    } else {
      return (1 / priceAfter) * feeMult;
    }
  }

  /**
   * More accurate second derivative calculation
   */
  static getAmountOutSecondDerivative(
    direction: SwapDirection,
    liquidity: bigint,
    sqrtPriceX96After: bigint,
    fee: number
  ): number {
    const feeMult = 1 - fee / 10000;
    const sqrtPrice = Number(sqrtPriceX96After) / Number(Q96);
    const price = sqrtPrice * sqrtPrice;
    const L = Number(liquidity);
    
    if (direction === 'token0ToToken1') {
      return (-2 * feeMult * sqrtPrice) / (L * price);
    } else {
      return (2 * feeMult) / (L * sqrtPrice * price * price);
    }
  }

  /**
   * Simulate a complete swap with fee handling
   */
  static simulateSwap(params: {
    direction: SwapDirection;
    amountIn: bigint;
    pool: {
      liquidity: bigint;
      sqrtPriceX96: bigint;
      fee: number;
      tick: number;
    };
  }): bigint {
    const { direction, amountIn, pool } = params;
    if (amountIn <= 0) return BigInt(0);

    const feeAmount = (amountIn * BigInt(pool.fee)) / BigInt(10000);
    const amountInAfterFee = amountIn - feeAmount;

    const sqrtPriceBefore = pool.sqrtPriceX96;
    let sqrtPriceAfter: bigint;

    if (direction === 'token0ToToken1') {
      sqrtPriceAfter = sqrtPriceBefore + (amountInAfterFee * Q96) / pool.liquidity;
    } else {
      sqrtPriceAfter = sqrtPriceBefore - (amountInAfterFee * Q96) / pool.liquidity;
    }

    // Prevent price from crossing zero
    if (sqrtPriceAfter <= 0) return BigInt(0);

    return this.getAmountOut(direction, pool.liquidity, sqrtPriceBefore, sqrtPriceAfter);
  }
}