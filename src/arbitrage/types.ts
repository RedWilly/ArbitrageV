import { type Address } from 'viem';

export type PairInfo = {
  pairAddress: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  fee: number;
};

export type SwapDirection = 'token0ToToken1' | 'token1ToToken0';

export type Edge = {
  to: Address;
  pairAddress: Address;
  direction: SwapDirection;
  fee: number;
  reserveIn: bigint;
  reserveOut: bigint;
};

export type CandidateRoute = {
  path: Address[];
  pairs: Address[];
  directions: SwapDirection[];
};

export type ArbitrageOpportunity = CandidateRoute & {
  profit: bigint;
  optimalInput: bigint;
  fees: number[];
};

export type FindOpportunitiesRequest = {
  startTokens: Address[];
  changedPairs?: Address[];
};

export type ArbitrageSearchResult = {
  paths: Address[][];
  pairs: Address[][];
  profits: bigint[];
  optimalAmounts: bigint[];
  fees: number[][];
};
