import { type Address } from 'viem';
import { RUNTIME } from '../constants';
import { feeMultiplier } from '../values';
import { compareFractions, FEE_DENOMINATOR } from './v2-math';
import { type Edge, type PairInfo } from './types';

type PairEdges = {
  token0ToToken1: Edge;
  token1ToToken0: Edge;
};

type RankedEdgeCache = {
  limit: number;
  edges: Edge[];
};

export class MarketGraph {
  private graph: Map<Address, Edge[]> = new Map();
  private tokens: Set<Address> = new Set();
  private pairs: Map<Address, PairInfo> = new Map();
  private pairEdges: Map<Address, PairEdges> = new Map();
  private rankedEdgesCache: Map<Address, RankedEdgeCache> = new Map();

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
    if (cached && cached.limit >= limit) return cached.edges;

    const ranked = this.selectTopEdges(this.graph.get(token) || [], limit);
    this.rankedEdgesCache.set(token, { limit, edges: ranked });
    return ranked;
  }

  edgeForTokenPair(token: Address, pairAddress: Address): Edge | null {
    const edges = this.pairEdges.get(pairAddress);
    if (!edges) return null;
    if (this.pairs.get(pairAddress)?.token0 === token) return edges.token0ToToken1;
    if (this.pairs.get(pairAddress)?.token1 === token) return edges.token1ToToken0;
    return null;
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
    const excluded = new Set(excludePairs.map(pair => pair.toLowerCase()));
    let bestPair: { pairAddress: Address; reserves: bigint; fee: number } | null = null;

    for (const edge of this.graph.get(token) || []) {
      if (excluded.has(edge.pairAddress.toLowerCase())) continue;
      if (edge.reserveIn < amountIn * 3n) continue;

      if (!bestPair || edge.reserveIn > bestPair.reserves) {
        bestPair = {
          pairAddress: edge.pairAddress,
          reserves: edge.reserveIn,
          fee: edge.fee,
        };
      }
    }

    return bestPair ? { pairAddress: bestPair.pairAddress, fee: bestPair.fee } : null;
  }

  clear(): void {
    this.graph.clear();
    this.tokens.clear();
    this.pairs.clear();
    this.pairEdges.clear();
    this.rankedEdgesCache.clear();
  }

  private updateEdges(pair: PairInfo): void {
    if (pair.reserve0 === 0n || pair.reserve1 === 0n) return;

    const existing = this.pairEdges.get(pair.pairAddress);
    if (existing) {
      existing.token0ToToken1.fee = pair.fee;
      existing.token0ToToken1.reserveIn = pair.reserve0;
      existing.token0ToToken1.reserveOut = pair.reserve1;
      existing.token1ToToken0.fee = pair.fee;
      existing.token1ToToken0.reserveIn = pair.reserve1;
      existing.token1ToToken0.reserveOut = pair.reserve0;
      this.rankedEdgesCache.delete(pair.token0);
      this.rankedEdgesCache.delete(pair.token1);
      return;
    }

    const token0ToToken1: Edge = {
      to: pair.token1,
      pairAddress: pair.pairAddress,
      direction: 'token0ToToken1',
      fee: pair.fee,
      reserveIn: pair.reserve0,
      reserveOut: pair.reserve1,
    };

    const token1ToToken0: Edge = {
      to: pair.token0,
      pairAddress: pair.pairAddress,
      direction: 'token1ToToken0',
      fee: pair.fee,
      reserveIn: pair.reserve1,
      reserveOut: pair.reserve0,
    };

    this.pairEdges.set(pair.pairAddress, { token0ToToken1, token1ToToken0 });
    this.pushEdge(pair.token0, token0ToToken1);
    this.pushEdge(pair.token1, token1ToToken0);
    this.rankedEdgesCache.delete(pair.token0);
    this.rankedEdgesCache.delete(pair.token1);
  }

  private pushEdge(token: Address, edge: Edge): void {
    const edges = this.graph.get(token);
    if (edges) {
      edges.push(edge);
      return;
    }

    this.graph.set(token, [edge]);
  }

  private selectTopEdges(edges: Edge[], limit: number): Edge[] {
    if (limit <= 0 || edges.length === 0) return [];

    const top: Edge[] = [];
    for (const edge of edges) {
      if (top.length < limit) {
        top.push(edge);
        this.moveEdgeIntoRank(top, top.length - 1);
        continue;
      }

      if (this.compareEdgeRank(edge, top[top.length - 1]) < 0) continue;
      top[top.length - 1] = edge;
      this.moveEdgeIntoRank(top, top.length - 1);
    }

    return top;
  }

  private moveEdgeIntoRank(edges: Edge[], index: number): void {
    while (index > 0 && this.compareEdgeRank(edges[index], edges[index - 1]) > 0) {
      const previous = edges[index - 1];
      edges[index - 1] = edges[index];
      edges[index] = previous;
      index--;
    }
  }

  private compareEdgeRank(a: Edge, b: Edge): number {
    const rateCompare = compareFractions(
      a.reserveOut * feeMultiplier(a.fee),
      a.reserveIn * FEE_DENOMINATOR,
      b.reserveOut * feeMultiplier(b.fee),
      b.reserveIn * FEE_DENOMINATOR
    );

    if (rateCompare !== 0) return rateCompare;

    const aLiquidity = a.reserveIn < a.reserveOut ? a.reserveIn : a.reserveOut;
    const bLiquidity = b.reserveIn < b.reserveOut ? b.reserveIn : b.reserveOut;
    if (aLiquidity > bLiquidity) return 1;
    if (aLiquidity < bLiquidity) return -1;
    return 0;
  }
}

