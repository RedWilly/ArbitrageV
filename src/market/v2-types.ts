import { type Address } from 'viem';

export type PairInfo = {
  pairAddress: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  fee: number;
};

export type ReserveUpdate = {
  pairAddress: Address;
  reserve0: bigint;
  reserve1: bigint;
};

export type SwapDirection = 'token0ToToken1' | 'token1ToToken0';
