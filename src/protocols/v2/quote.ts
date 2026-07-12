import { feeMultiplier } from '../../values';

export const FEE_DENOMINATOR = 10000n;

export function swapV2(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, fee: number): bigint {
  const amountInAfterFee = (amountIn * feeMultiplier(fee)) / FEE_DENOMINATOR;
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
}
