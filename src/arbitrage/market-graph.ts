import { type Address } from 'viem';
import { RUNTIME } from '../constants';
import { compareFractions, FEE_DENOMINATOR } from './v2-math';
import { type Edge, type PairInfo } from './types';

type EdgeKey = `${string}-${string}`;

export class MarketGraph {
  private graph: Map<Address, Edge[]> = new Map();
  private tokens: Set<Address> = new Set();
  private pairs: Map<Address, PairInfo> = new Map();
  private edgeIndex: Map<EdgeKey, Edge> = new Map();
  private rankedEdgesCache: Map<Address, Edge[]> = new Map();
  private tokenToHighestReservePair: Map<Address, { pairAddress: Address; reserves: bigint; fee: number }> = new Map();

  addPair(pair: PairInfo): void {
    if (pair.reserve0 === 0n || pair.reserve1 === 0n) return;

    this.tokens.add(pair.token0);
    this.tokens.add(pair.token1);
    this.pairs.set(pair.pairAddress, pair);
    this.updateEdges(pair);
  }

  updateReserves(updates: { pairAddress: Address; reserve0: bigint; reserve1: bigint }[]): void {
    const updatedPairs = new Set<PairInfo>();

    for (const update of updates) {
      const pair = this.pairs.get(update.pairAddress);
      if (!pair) {
        console.warn(`Pair ${update.pairAddress} not found in graph. Consider adding it first.`);
        continue;
      }

      pair.reserve0 = update.reserve0;
      pair.reserve1 = update.reserve1;
      updatedPairs.add(pair);

      if (RUNTIME.debug) {
        console.log(`Updated reserves for pair ${update.pairAddress}: ${update.reserve0}, ${update.reserve1}`);
      }
    }

    for (const pair of updatedPairs) {
      this.updateEdges(pair);
    }
  }

  rankedEdges(token: Address, limit: number): Edge[] {
    const cached = this.rankedEdgesCache.get(token);
    if (cached) return cached.slice(0, limit);

    const ranked = [...(this.graph.get(token) || [])].sort((a, b) => {
      const rateCompare = compareFractions(
        b.reserveOut * BigInt(10000 - b.fee),
        b.reserveIn * FEE_DENOMINATOR,
        a.reserveOut * BigInt(10000 - a.fee),
        a.reserveIn * FEE_DENOMINATOR
      );

      if (rateCompare !== 0) return rateCompare;

      const aLiquidity = a.reserveIn < a.reserveOut ? a.reserveIn : a.reserveOut;
      const bLiquidity = b.reserveIn < b.reserveOut ? b.reserveIn : b.reserveOut;
      if (bLiquidity > aLiquidity) return 1;
      if (bLiquidity < aLiquidity) return -1;
      return 0;
    });

    this.rankedEdgesCache.set(token, ranked);
    return ranked.slice(0, limit);
  }

  pair(pairAddress: Address): PairInfo | null {
    return this.pairs.get(pairAddress) ?? null;
  }

  pairAddresses(): Address[] {
    return Array.from(this.pairs.keys());
  }

  allPairs(): PairInfo[] {
    return Array.from(this.pairs.values());
  }

  tokensList(): Address[] {
    return Array.from(this.tokens);
  }

  findBestPairForToken(
    token: Address,
    amountIn: bigint,
    excludePairs: Address[] = []
  ): { pairAddress: Address; fee: number } | null {
    const bestPair = this.tokenToHighestReservePair.get(token);
    if (!bestPair) return null;
    if (excludePairs.includes(bestPair.pairAddress)) return null;
    if (bestPair.reserves < amountIn * 3n) return null;

    return {
      pairAddress: bestPair.pairAddress,
      fee: bestPair.fee,
    };
  }

  clear(): void {
    this.graph.clear();
    this.tokens.clear();
    this.pairs.clear();
    this.edgeIndex.clear();
    this.rankedEdgesCache.clear();
    this.tokenToHighestReservePair.clear();
  }

  private createEdgeKey(fromToken: Address, pairAddress: Address): EdgeKey {
    return `${fromToken}-${pairAddress}`;
  }

  private updateEdges(pair: PairInfo): void {
    if (pair.reserve0 === 0n || pair.reserve1 === 0n) return;

    this.updateHighestReservePair(pair.token0, pair.pairAddress, pair.reserve0, pair.fee);
    this.updateHighestReservePair(pair.token1, pair.pairAddress, pair.reserve1, pair.fee);

    this.upsertEdge(pair.token0, {
      to: pair.token1,
      pairAddress: pair.pairAddress,
      direction: 'token0ToToken1',
      fee: pair.fee,
      reserveIn: pair.reserve0,
      reserveOut: pair.reserve1,
    });

    this.upsertEdge(pair.token1, {
      to: pair.token0,
      pairAddress: pair.pairAddress,
      direction: 'token1ToToken0',
      fee: pair.fee,
      reserveIn: pair.reserve1,
      reserveOut: pair.reserve0,
    });
  }

  private updateHighestReservePair(token: Address, pairAddress: Address, reserves: bigint, fee: number): void {
    const currentBest = this.tokenToHighestReservePair.get(token);
    if (!currentBest || reserves > currentBest.reserves) {
      this.tokenToHighestReservePair.set(token, { pairAddress, reserves, fee });
    }
  }

  private upsertEdge(fromToken: Address, edge: Edge): void {
    const edgeKey = this.createEdgeKey(fromToken, edge.pairAddress);
    const existing = this.edgeIndex.get(edgeKey);

    if (existing) {
      existing.reserveIn = edge.reserveIn;
      existing.reserveOut = edge.reserveOut;
      existing.fee = edge.fee;
    } else {
      if (!this.graph.has(fromToken)) {
        this.graph.set(fromToken, []);
      }

      this.graph.get(fromToken)!.push(edge);
      this.edgeIndex.set(edgeKey, edge);
    }

    this.rankedEdgesCache.delete(fromToken);
  }
}

