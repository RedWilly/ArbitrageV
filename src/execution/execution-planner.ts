import { type Address } from 'viem';
import { type FlashPoolCandidate } from '../market-graph/types';
import { type ArbitrageOpportunity } from '../opportunities/opportunity-types';

export const CONTRACT_PROTOCOL = {
  v2: 0,
  v3: 1,
  carbon: 2,
} as const;

type FlashProtocol = 'v2' | 'v3';

export type ExecutableOpportunity = Pick<
  ArbitrageOpportunity,
  'path' | 'pairs' | 'protocols' | 'fees' | 'routeData' | 'optimalInput' | 'profit'
>;

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
  data: `0x${string}`[];
};

export type ExecutionPlan = {
  kind: 'flash';
  params: ArbContractParams;
};

export function flashLoanFee(pool: FlashPoolCandidate, amount: bigint): bigint {
  if (pool.protocol === 'v2') {
    const fee = BigInt(pool.fee);
    return (amount * fee) / (10_000n - fee) + 1n;
  }

  if (pool.protocol === 'v3') {
    const feeAmount = amount * BigInt(pool.fee);
    return feeAmount === 0n ? 0n : ((feeAmount - 1n) / 1_000_000n) + 1n;
  }

  return 0n;
}

export function createExecutionPlan(graph: FlashPoolLookup, opportunity: ExecutableOpportunity): ExecutionPlan | null {
  if (!isCircular(opportunity.path)) return null;
  if (opportunity.pairs.length !== opportunity.protocols.length) return null;
  if (opportunity.pairs.length !== opportunity.fees.length) return null;
  if (opportunity.pairs.length !== opportunity.routeData.length) return null;

  const borrowToken = opportunity.path[0];
  const flashPool = graph.findBestFlashPoolForToken(
    borrowToken,
    opportunity.optimalInput,
    opportunity.pairs
  );

  if (!flashPool) return null;
  if (!isFlashProtocol(flashPool.protocol)) return null;

  return {
    kind: 'flash',
    params: {
      flashProtocol: CONTRACT_PROTOCOL[flashPool.protocol],
      flashPool: flashPool.poolAddress,
      borrowToken,
      borrowAmount: opportunity.optimalInput,
      v2RepayFee: flashPool.protocol === 'v2' ? BigInt(flashPool.fee) : 0n,
      pools: opportunity.pairs,
      protocols: opportunity.protocols.map(protocol => CONTRACT_PROTOCOL[protocol]),
      fees: opportunity.fees.map(fee => BigInt(fee)),
      data: opportunity.routeData,
    },
  };
}

function isCircular(path: Address[]): boolean {
  if (path.length < 2) return false;
  return path[0].toLowerCase() === path[path.length - 1].toLowerCase();
}

function isFlashProtocol(protocol: string): protocol is FlashProtocol {
  return protocol === 'v2' || protocol === 'v3';
}
