import { type Address } from 'viem';
import { type SwapDirection } from '../market/v2-types';
import { type MarketProtocol } from '../market-graph/types';
import { type MarketEdgeId } from '../market-graph/types';

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
};

export type FindOpportunitiesRequest = {
  startTokens: Address[];
  changedPairs?: Address[];
};

export type ArbitrageSearchResult = {
  paths: Address[][];
  pairs: Address[][];
  protocols: MarketProtocol[][];
  profits: bigint[];
  optimalAmounts: bigint[];
  fees: number[][];
};
