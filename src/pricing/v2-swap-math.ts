import { feeMultiplier } from '../values';

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
  const amountInAfterFee = (amountIn * feeMultiplier(fee)) / FEE_DENOMINATOR;
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
}
