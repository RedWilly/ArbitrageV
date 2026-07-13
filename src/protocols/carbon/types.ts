import { type Address } from 'viem';

export type CarbonPairMetadata = {
  controller: Address;
  token0: Address;
  token1: Address;
  strategyCount: number;
  feePpm: number;
};

export type CarbonOrder = {
  y: bigint;
  z: bigint;
  A: bigint;
  B: bigint;
};

export type CarbonStrategy = {
  id: bigint;
  owner: Address;
  controller: Address;
  token0: Address;
  token1: Address;
  feePpm: number;
  orders: [CarbonOrder, CarbonOrder];
};
