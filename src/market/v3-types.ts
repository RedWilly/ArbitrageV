import { type Address } from 'viem';

export type V3PoolConfig = {
  name: string;
  address: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  enabled: boolean;
};

export type V3StartupPolicy = {
  batchSize: number;
};

export type V3PoolState = {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
};

export type V3Tick = {
  index: number;
  liquidityGross: bigint;
  liquidityNet: bigint;
};

export type V3BitmapWord = {
  wordPosition: number;
  bitmap: bigint;
};

export type V3PoolInfo = V3PoolConfig & {
  state: V3PoolState | null;
  ticks: Map<number, V3Tick>;
  bitmapWords: Map<number, bigint>;
};

export type V3PoolUpdate = {
  poolAddress: Address;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
};

export type V3TickUpdate = {
  poolAddress: Address;
  ticks: V3Tick[];
};

export type V3BitmapWordUpdate = {
  poolAddress: Address;
  words: V3BitmapWord[];
};

export type V3PoolStartupState = {
  poolAddress: Address;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  bitmapWords: V3BitmapWord[];
  ticks: Array<V3Tick & { initialized: boolean }>;
};

export type V3SwapDirection = 'token0ToToken1' | 'token1ToToken0';

export type V3Edge = {
  to: Address;
  poolAddress: Address;
  direction: V3SwapDirection;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
};
