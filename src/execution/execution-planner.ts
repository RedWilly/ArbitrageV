import { type Address } from 'viem';
import { type FlashPoolCandidate } from '../market-graph/types';

export const CONTRACT_PROTOCOL = {
  v2: 0,
  v3: 1,
} as const;

type ExecutableProtocol = keyof typeof CONTRACT_PROTOCOL;

export type ExecutableOpportunity = {
  path: Address[];
  pairs: Address[];
  protocols: ExecutableProtocol[];
  fees: number[];
  optimalAmount: bigint;
  expectedProfit: bigint;
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

export function createExecutionPlan(graph: FlashPoolLookup, opportunity: ExecutableOpportunity): ExecutionPlan | null {
  if (!isCircular(opportunity.path)) return null;
  if (opportunity.pairs.length !== opportunity.protocols.length) return null;
  if (opportunity.pairs.length !== opportunity.fees.length) return null;

  const borrowToken = opportunity.path[0];
  const flashPool = graph.findBestFlashPoolForToken(
    borrowToken,
    opportunity.optimalAmount,
    opportunity.pairs
  );

  if (!flashPool) return null;
  if (!isExecutableProtocol(flashPool.protocol)) return null;

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

function isCircular(path: Address[]): boolean {
  if (path.length < 2) return false;
  return path[0].toLowerCase() === path[path.length - 1].toLowerCase();
}

function isExecutableProtocol(protocol: string): protocol is ExecutableProtocol {
  return protocol === 'v2' || protocol === 'v3';
}
