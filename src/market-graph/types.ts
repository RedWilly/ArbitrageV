import { type Address } from 'viem';
import { type SwapDirection } from '../market/v2-types';

export type RouteMode = 'circular' | 'cross-token';
export type MarketProtocol = 'v2' | 'v3';

export type ArbitrageSearchPolicy = {
  topTokens: number;
  routeMode: RouteMode;
  allowedProtocols: readonly MarketProtocol[];
  allowProtocolMixing: boolean;
  maxRouteEdges: number;
  beamWidth: number;
  optimizationIterations: number;
  maxInputReserveFraction: bigint;
  maxOpportunities: number;
};

export type MarketEdgeId = string;

export type MarketEdge = {
  id: MarketEdgeId;
  protocol: MarketProtocol;
  from: Address;
  to: Address;
  poolAddress: Address;
  direction: SwapDirection;
  fee: number;
  rateNumerator: bigint;
  rateDenominator: bigint;
  liquidity: bigint;
};

export type V2MarketEdge = MarketEdge & {
  protocol: 'v2';
  reserveIn: bigint;
  reserveOut: bigint;
};

export type V3MarketEdge = MarketEdge & {
  protocol: 'v3';
  sqrtPriceX96: bigint;
  tickSpacing: number;
  tick: number;
};

export type AnyMarketEdge = V2MarketEdge | V3MarketEdge;

export type MarketRoute = {
  path: Address[];
  pools: Address[];
  directions: SwapDirection[];
  edgeIds: MarketEdgeId[];
  edgeIndexes?: number[];
  protocols: MarketProtocol[];
};

export type MarketRouteQuote = {
  amountIn: bigint;
  amountOut: bigint;
  profit: bigint;
  complete: boolean;
};

export type MarketSizedRoute = {
  profit: bigint;
  optimalInput: bigint;
  complete: boolean;
};

export type FlashPoolCandidate = {
  protocol: MarketProtocol;
  poolAddress: Address;
  fee: number;
  liquidity: bigint;
};

export function protocolAllowed(policy: ArbitrageSearchPolicy, protocol: MarketProtocol): boolean {
  return policy.allowedProtocols.includes(protocol);
}

export function transitionAllowed(
  policy: ArbitrageSearchPolicy,
  previous: MarketProtocol | null,
  next: MarketProtocol
): boolean {
  if (!previous) return protocolAllowed(policy, next);
  if (!protocolAllowed(policy, next)) return false;
  return policy.allowProtocolMixing || previous === next;
}
