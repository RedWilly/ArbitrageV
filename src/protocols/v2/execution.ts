import { type Hex } from 'viem';
import { type V2Variant } from './types';

export function encodeV2RouteData(variant: V2Variant): Hex {
  return variant === 'solidly-stable' ? '0x01' : '0x';
}

export function v2FlashLoanFee(fee: number, amount: bigint): bigint {
  const rawFee = BigInt(fee);
  return (amount * rawFee) / (10_000n - rawFee) + 1n;
}
