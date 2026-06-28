import { type PairInfo, type SwapDirection } from './types';

export const FEE_DENOMINATOR = 10000n;

export function compareFractions(
  aNumerator: bigint,
  aDenominator: bigint,
  bNumerator: bigint,
  bDenominator: bigint
): number {
  const left = aNumerator * bDenominator;
  const right = bNumerator * aDenominator;
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
}

export function swapV2(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, fee: number): bigint {
  const feeMultiplier = BigInt(10000 - fee);
  const amountInAfterFee = (amountIn * feeMultiplier) / FEE_DENOMINATOR;
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
}

export function reservesForDirection(
  pair: PairInfo,
  direction: SwapDirection
): { reserveIn: bigint; reserveOut: bigint } {
  return direction === 'token0ToToken1'
    ? { reserveIn: pair.reserve0, reserveOut: pair.reserve1 }
    : { reserveIn: pair.reserve1, reserveOut: pair.reserve0 };
}

export function calculateRouteProfit(
  inputAmount: bigint,
  pairs: PairInfo[],
  directions: SwapDirection[]
): bigint {
  try {
    let amount = inputAmount;

    for (let i = 0; i < pairs.length; i++) {
      const { reserveIn, reserveOut } = reservesForDirection(pairs[i], directions[i]);
      if (amount <= 0n || amount >= reserveIn) {
        return -1n;
      }

      amount = swapV2(amount, reserveIn, reserveOut, pairs[i].fee);
    }

    return amount - inputAmount;
  } catch {
    return -1n;
  }
}
