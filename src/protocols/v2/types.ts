import { type Address } from 'viem';

export type V2Variant = 'uniswap-v2' | 'solidly-volatile' | 'solidly-stable';

export type PairInfo = {
  pairAddress: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  fee: number;
  variant: V2Variant;
  scale0: bigint;
  scale1: bigint;
};

export type V2QuoteState = {
  variant: V2Variant;
  reserveIn: bigint;
  reserveOut: bigint;
  scaleIn: bigint;
  scaleOut: bigint;
  fee: number;
};

export type ReserveUpdate = {
  pairAddress: Address;
  reserve0: bigint;
  reserve1: bigint;
};

export type SwapDirection = 'token0ToToken1' | 'token1ToToken0';
