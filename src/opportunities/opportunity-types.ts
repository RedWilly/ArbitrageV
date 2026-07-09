import { type Address } from 'viem';
import { type MarketEdgeId, type MarketProtocol } from '../market-graph/types';

export type CandidateRoute = {
  path: Address[];
  pairs: Address[];
  edgeIds: MarketEdgeId[];
  edgeIndexes?: number[];
  protocols: MarketProtocol[];
};

export type ArbitrageOpportunity = CandidateRoute & {
  profit: bigint;
  optimalInput: bigint;
  fees: number[];
  routeData: `0x${string}`[];
};

export type FindOpportunitiesRequest = {
  startTokens: Address[];
  changedPairs?: readonly string[];
};

export type ArbitrageSearchResult = ArbitrageOpportunity[];
