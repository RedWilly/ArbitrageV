import { type Address } from 'viem';
import { type SwapDirection } from '../market/v2-types';

export type RouteKind = 'v2' | 'v3' | 'mixed';

export type CandidateRoute = {
  path: Address[];
  pairs: Address[];
  directions: SwapDirection[];
};

export type ArbitrageOpportunity = CandidateRoute & {
  profit: bigint;
  optimalInput: bigint;
  fees: number[];
  routeKind: RouteKind;
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
  routeKinds: RouteKind[];
};
