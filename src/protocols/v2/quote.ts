import { feeMultiplier } from '../../values';

export const FEE_DENOMINATOR = 10000n;

export function swapV2(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, fee: number): bigint {
//   const amountInWithFee = amountIn * (FEE_DENOMINATOR - BigInt(fee));
  const amountInWithFee = amountIn * (feeMultiplier(fee));
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
}
