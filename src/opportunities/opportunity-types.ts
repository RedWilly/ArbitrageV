import { type Address } from 'viem';
import { type SwapDirection } from '../market/v2-types';
import { type MarketProtocol } from '../market-graph/types';
import { type MarketEdgeId } from '../market-graph/types';

export type RouteKind = 'v2' | 'v3' | 'mixed';

export type CandidateRoute = {
  path: Address[];
  pairs: Address[];
  directions: SwapDirection[];
  edgeIds?: MarketEdgeId[];
  protocols?: MarketProtocol[];
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
