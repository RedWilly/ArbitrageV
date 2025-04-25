import { TickMath } from "./TickMath";

const Q96 = BigInt(2) ** BigInt(96);

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
    return TickMath.getSqrtRatioAtTick(tick);
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
      const nextSqrtPrice = TickMath.getSqrtRatioAtTick(nextTick); // ✅ Using TickMath
      
      const swapResult = this.computeSwapStep(
        currentSqrtPrice,
        nextSqrtPrice,
        liquidity,
        remainingAmount,
        fee
      );
      
      remainingAmount -= swapResult.amountIn;
      outputAmount += swapResult.amountOut;
      currentSqrtPrice = swapResult.sqrtRatioNextX96;
      currentTick = nextTick;
      
      // Add price impact protection
      if (this.isPriceImpactTooHigh(
        currentSqrtPrice, 
        sqrtPriceX96, 
        direction
      )) {
        break;
      }
    }
    
    return outputAmount;
  }

  private static isPriceImpactTooHigh(
    newSqrtPrice: bigint,
    initialSqrtPrice: bigint,
    direction: SwapDirection
  ): boolean {
    const priceChange = direction === 'token0ToToken1' 
      ? Number(newSqrtPrice - initialSqrtPrice) / Number(initialSqrtPrice)
      : Number(initialSqrtPrice - newSqrtPrice) / Number(initialSqrtPrice);
      
    return Math.abs(priceChange) > 0.05; // 5% max price impact
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
      targetSqrtPrice: bigint,
      liquidity: bigint,
      amountRemaining: bigint,
      feeTier: number  // e.g., 3000 for 0.3%
  ): { amountIn: bigint; amountOut: bigint; sqrtRatioNextX96: bigint } {
      const zeroForOne = currentSqrtPrice >= targetSqrtPrice;
      const exactIn = amountRemaining > 0n;

      if (!exactIn) {
          throw new Error("Exact output swaps not implemented");
      }

      // Calculate fee-adjusted input amount (1 - fee)
      const feeAmount = (amountRemaining * BigInt(feeTier)) / 1_000_000n;
      const amountRemainingLessFee = amountRemaining - feeAmount;

      if (zeroForOne) {
          // Token0 → Token1 (price decreases)
          const amountInToken0 = (liquidity * Q96 * (currentSqrtPrice - targetSqrtPrice)) / 
                              (currentSqrtPrice * targetSqrtPrice);
          
          if (amountRemainingLessFee >= amountInToken0) {
              // Swap entire amount in this tick range
              return {
                  amountIn: amountInToken0 + feeAmount,
                  amountOut: (liquidity * (currentSqrtPrice - targetSqrtPrice)) / Q96,
                  sqrtRatioNextX96: targetSqrtPrice,
              };
          } else {
              // Partial swap
              const sqrtRatioNextX96 = currentSqrtPrice - 
                  ((amountRemainingLessFee * currentSqrtPrice * targetSqrtPrice) / (liquidity * Q96));
              
              return {
                  amountIn: amountRemaining,
                  amountOut: (liquidity * (currentSqrtPrice - sqrtRatioNextX96)) / Q96,
                  sqrtRatioNextX96,
              };
          }
      } else {
          // Token1 → Token0 (price increases)
          const amountInToken1 = (liquidity * (targetSqrtPrice - currentSqrtPrice)) / Q96;
          
          if (amountRemainingLessFee >= amountInToken1) {
              return {
                  amountIn: amountInToken1 + feeAmount,
                  amountOut: (liquidity * Q96 * (targetSqrtPrice - currentSqrtPrice)) / 
                          (targetSqrtPrice * currentSqrtPrice),
                  sqrtRatioNextX96: targetSqrtPrice,
              };
          } else {
              const sqrtRatioNextX96 = currentSqrtPrice + 
                  (amountRemainingLessFee * Q96) / liquidity;
              
              return {
                  amountIn: amountRemaining,
                  amountOut: (liquidity * Q96 * (sqrtRatioNextX96 - currentSqrtPrice)) / 
                            (sqrtRatioNextX96 * currentSqrtPrice),
                  sqrtRatioNextX96,
              };
          }
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


