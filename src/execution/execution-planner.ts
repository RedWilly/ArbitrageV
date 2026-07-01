import { type Address } from 'viem';
import { type FlashPoolCandidate, type MarketProtocol } from '../market-graph/types';
import { type RouteKind } from '../opportunities/opportunity-types';

export const CONTRACT_PROTOCOL = {
  v2: 0,
  v3: 1,
} as const;

export type ExecutableOpportunity = {
  path: Address[];
  pairs: Address[];
  protocols: MarketProtocol[];
  fees: number[];
  optimalAmount: bigint;
  expectedProfit: bigint;
  routeKind: RouteKind;
};

export type FlashPoolLookup = {
  findBestFlashPoolForToken(
    token: Address,
    amountIn: bigint,
    excludePools?: Address[]
  ): FlashPoolCandidate | null;
};

export type ArbContractParams = {
  flashProtocol: number;
  flashPool: Address;
  borrowToken: Address;
  borrowAmount: bigint;
  v2RepayFee: bigint;
  pools: Address[];
  protocols: number[];
  fees: bigint[];
};

export type ExecutionPlan = {
  kind: 'flash';
  params: ArbContractParams;
};

export class ExecutionPlanner {
  createPlan(graph: FlashPoolLookup, opportunity: ExecutableOpportunity): ExecutionPlan | null {
    if (!this.isCircular(opportunity.path)) return null;
    if (opportunity.pairs.length !== opportunity.protocols.length) return null;
    if (opportunity.pairs.length !== opportunity.fees.length) return null;

    const borrowToken = opportunity.path[0];
    const flashPool = graph.findBestFlashPoolForToken(
      borrowToken,
      opportunity.optimalAmount,
      opportunity.pairs
    );

    if (!flashPool) return null;

    return {
      kind: 'flash',
      params: {
        flashProtocol: CONTRACT_PROTOCOL[flashPool.protocol],
        flashPool: flashPool.poolAddress,
        borrowToken,
        borrowAmount: opportunity.optimalAmount,
        v2RepayFee: flashPool.protocol === 'v2' ? BigInt(flashPool.fee) : 0n,
        pools: opportunity.pairs,
        protocols: opportunity.protocols.map(protocol => CONTRACT_PROTOCOL[protocol]),
        fees: opportunity.fees.map(fee => BigInt(fee)),
      },
    };
  }

  private isCircular(path: Address[]): boolean {
    if (path.length < 2) return false;
    return path[0].toLowerCase() === path[path.length - 1].toLowerCase();
  }
}
