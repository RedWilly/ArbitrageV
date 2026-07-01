import { type Address } from 'viem';
import { type MarketProtocol } from '../market-graph/types';
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

export type FlashLoanPairLookup = {
  findBestPairForToken(
    token: Address,
    amountIn: bigint,
    excludePairs?: Address[]
  ): { pairAddress: Address; fee: number } | null;
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
  createPlan(graph: FlashLoanPairLookup, opportunity: ExecutableOpportunity): ExecutionPlan | null {
    if (!this.isCircular(opportunity.path)) return null;
    if (opportunity.pairs.length !== opportunity.protocols.length) return null;
    if (opportunity.pairs.length !== opportunity.fees.length) return null;

    const borrowToken = opportunity.path[0];
    const flashLoanPair = graph.findBestPairForToken(
      borrowToken,
      opportunity.optimalAmount,
      opportunity.pairs
    );

    if (!flashLoanPair) return null;

    return {
      kind: 'flash',
      params: {
        flashProtocol: CONTRACT_PROTOCOL.v2,
        flashPool: flashLoanPair.pairAddress,
        borrowToken,
        borrowAmount: opportunity.optimalAmount,
        v2RepayFee: BigInt(flashLoanPair.fee),
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
