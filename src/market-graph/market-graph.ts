import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, V3_POOLS } from '../constants';
import { V2Market } from '../market/v2-market';
import {
  type PairInfo,
  type ReserveUpdate,
  type SwapDirection,
} from '../market/v2-types';
import { V3Market } from '../market/v3-market';
import {
  type V3BitmapWord,
  type V3BitmapWordUpdate,
  type V3PoolConfig,
  type V3PoolInfo,
  type V3PoolUpdate,
  type V3Tick,
  type V3TickUpdate,
} from '../market/v3-types';
import { compareFractions, FEE_DENOMINATOR, swapV2 } from '../pricing/v2-swap-math';
import { Q96, quoteV3MultiRangeExactInput, V3_FEE_DENOMINATOR } from '../pricing/v3-swap-math';
import { feeMultiplier } from '../values';
import {
  type AnyMarketEdge,
  type ArbitrageSearchPolicy,
  type FlashPoolCandidate,
  type MarketEdgeId,
  type MarketRoute,
  type MarketRouteQuote,
  protocolAllowed,
} from './types';

type TokenSlot = {
  address: Address;
  edgeIndexes: number[];
};

type EdgeSlot = {
  edge: AnyMarketEdge;
  tokenIndex: number;
};

type IndexedEdgeCache = {
  limit: number;
  edges: AnyMarketEdge[];
};

const Q192 = Q96 * Q96;

export class MarketGraph {
  private readonly tokenIndexes = new Map<string, number>();
  private readonly tokens: TokenSlot[] = [];
  private readonly edgeIndexes = new Map<MarketEdgeId, number>();
  private readonly edges: EdgeSlot[] = [];
  private readonly rankedEdgesCache = new Map<number, IndexedEdgeCache>();

  constructor(
    private readonly policy: ArbitrageSearchPolicy = ARBITRAGE_SEARCH_POLICY,
    private readonly v2Market = new V2Market(),
    private readonly v3Market = new V3Market(V3_POOLS)
  ) {
    for (const pair of this.v2Market.allPairs()) {
      this.upsertV2Edges(pair);
    }

    for (const pool of this.v3Market.allPools()) {
      this.upsertV3Edges(pool);
    }
  }

  addPair(pair: PairInfo): void {
    this.v2Market.addPair(pair);
    this.upsertV2Edges(pair);
  }

  updateReserves(updates: ReserveUpdate[]): void {
    this.v2Market.updateReserves(updates);

    for (const update of updates) {
      const pair = this.v2Market.pair(update.pairAddress);
      if (pair) this.upsertV2Edges(pair);
    }
  }

  addV3Pool(pool: V3PoolConfig): void {
    this.v3Market.addPool(pool);
    const poolInfo = this.v3Market.pool(pool.address);
    if (poolInfo) this.upsertV3Edges(poolInfo);
  }

  updateV3PoolStates(updates: V3PoolUpdate[]): void {
    this.v3Market.updatePoolStates(updates);

    for (const update of updates) {
      const pool = this.v3Market.pool(update.poolAddress);
      if (pool) this.upsertV3Edges(pool);
    }
  }

  updateV3Ticks(updates: V3TickUpdate[]): void {
    this.v3Market.updateTicks(updates);
  }

  updateV3BitmapWords(updates: V3BitmapWordUpdate[]): void {
    this.v3Market.updateBitmapWords(updates);
  }

  rankedEdges(token: Address, limit: number): AnyMarketEdge[] {
    const tokenIndex = this.tokenIndexes.get(this.addressKey(token));
    if (tokenIndex === undefined) return [];

    const cached = this.rankedEdgesCache.get(tokenIndex);
    if (cached && cached.limit >= limit) return cached.edges;

    const ranked = this.selectTopEdges(this.tokens[tokenIndex].edgeIndexes, limit);
    this.rankedEdgesCache.set(tokenIndex, { limit, edges: ranked });
    return ranked;
  }

  edgesForTokenPool(token: Address, poolAddress: Address): AnyMarketEdge[] {
    const tokenIndex = this.tokenIndexes.get(this.addressKey(token));
    if (tokenIndex === undefined) return [];

    const edgeIndexes = this.tokens[tokenIndex].edgeIndexes;
    const matches: AnyMarketEdge[] = [];
    const lowerPoolAddress = poolAddress.toLowerCase();

    for (const edgeIndex of edgeIndexes) {
      const edge = this.edges[edgeIndex].edge;
      if (edge.poolAddress.toLowerCase() === lowerPoolAddress) {
        matches.push(edge);
      }
    }

    return matches;
  }

  edge(edgeId: MarketEdgeId): AnyMarketEdge | null {
    const edgeIndex = this.edgeIndexes.get(edgeId);
    return edgeIndex === undefined ? null : this.edges[edgeIndex].edge;
  }

  quote(route: MarketRoute, amountIn: bigint): MarketRouteQuote {
    if (amountIn <= 0n) {
      return { amountIn, amountOut: 0n, profit: 0n, complete: false };
    }

    let amount = amountIn;

    for (const edgeId of route.edgeIds) {
      const edge = this.edge(edgeId);
      if (!edge) return { amountIn, amountOut: 0n, profit: -1n, complete: false };

      const quote = edge.protocol === 'v2'
        ? this.quoteV2Edge(edge, amount)
        : this.quoteV3Edge(edge, amount);

      if (!quote.complete || quote.amountOut <= 0n) {
        return { amountIn, amountOut: quote.amountOut, profit: -1n, complete: false };
      }

      amount = quote.amountOut;
    }

    return {
      amountIn,
      amountOut: amount,
      profit: amount - amountIn,
      complete: true,
    };
  }

  maxInputForRoute(route: MarketRoute): bigint {
    let bound: bigint | null = null;

    for (const edgeId of route.edgeIds) {
      const edge = this.edge(edgeId);
      if (!edge) return 0n;

      const candidate = edge.liquidity / this.policy.maxInputReserveFraction;
      if (candidate <= 0n) return 0n;
      bound = bound === null || candidate < bound ? candidate : bound;
    }

    return bound ?? 0n;
  }

  getTokens(): Address[] {
    return this.tokens.map(token => token.address);
  }

  getPairAddresses(): Address[] {
    return this.v2Market.pairAddresses();
  }

  getAllPairs(): PairInfo[] {
    return this.v2Market.allPairs();
  }

  getV3PoolAddresses(): Address[] {
    return this.v3Market.poolAddresses();
  }

  getV3Pools(): V3PoolInfo[] {
    return this.v3Market.allPools();
  }

  getV3InitializedTicks(poolAddress: Address): V3Tick[] {
    return this.v3Market.initializedTicks(poolAddress);
  }

  getV3BitmapWords(poolAddress: Address): V3BitmapWord[] {
    return this.v3Market.bitmapWords(poolAddress);
  }

  findBestPairForToken(
    token: Address,
    amountIn: bigint,
    excludePairs: Address[] = []
  ): { pairAddress: Address; fee: number } | null {
    return this.v2Market.findBestPairForToken(token, amountIn, excludePairs);
  }

  findBestFlashPoolForToken(
    token: Address,
    amountIn: bigint,
    excludePools: Address[] = []
  ): FlashPoolCandidate | null {
    const tokenIndex = this.tokenIndexes.get(this.addressKey(token));
    if (tokenIndex === undefined) return null;

    const excluded = new Set(excludePools.map(pool => this.addressKey(pool)));
    let best: FlashPoolCandidate | null = null;

    for (const edgeIndex of this.tokens[tokenIndex].edgeIndexes) {
      const edge = this.edges[edgeIndex].edge;
      if (excluded.has(this.addressKey(edge.poolAddress))) continue;
      if (edge.liquidity < amountIn * 3n) continue;

      if (!best || edge.liquidity > best.liquidity) {
        best = {
          protocol: edge.protocol,
          poolAddress: edge.poolAddress,
          fee: edge.fee,
          liquidity: edge.liquidity,
        };
      }
    }

    return best;
  }

  clear(): void {
    this.v2Market.clear();
    this.v3Market.clear();
    this.tokenIndexes.clear();
    this.tokens.length = 0;
    this.edgeIndexes.clear();
    this.edges.length = 0;
    this.rankedEdgesCache.clear();
  }

  private quoteV2Edge(edge: Extract<AnyMarketEdge, { protocol: 'v2' }>, amountIn: bigint): MarketRouteQuote {
    if (amountIn >= edge.reserveIn) {
      return { amountIn, amountOut: 0n, profit: -1n, complete: false };
    }

    const amountOut = swapV2(amountIn, edge.reserveIn, edge.reserveOut, edge.fee);
    return {
      amountIn,
      amountOut,
      profit: amountOut - amountIn,
      complete: amountOut > 0n,
    };
  }

  private quoteV3Edge(edge: Extract<AnyMarketEdge, { protocol: 'v3' }>, amountIn: bigint): MarketRouteQuote {
    const pool = this.v3Market.pool(edge.poolAddress);
    if (!pool?.state || pool.state.liquidity <= 0n) {
      return { amountIn, amountOut: 0n, profit: -1n, complete: false };
    }

    const quote = quoteV3MultiRangeExactInput({
      amountIn,
      sqrtPriceX96: pool.state.sqrtPriceX96,
      liquidity: pool.state.liquidity,
      tick: pool.state.tick,
      fee: pool.fee,
      direction: edge.direction,
      ticks: this.v3Market.initializedTicks(pool.address),
    });

    if (quote.exhaustedLiquidity) {
      return { amountIn, amountOut: quote.amountOut, profit: -1n, complete: false };
    }

    return {
      amountIn,
      amountOut: quote.amountOut,
      profit: quote.amountOut - amountIn,
      complete: quote.amountOut > 0n,
    };
  }

  private upsertV2Edges(pair: PairInfo): void {
    if (pair.reserve0 === 0n || pair.reserve1 === 0n || !protocolAllowed(this.policy, 'v2')) return;

    this.upsertEdge({
      id: this.edgeId('v2', pair.pairAddress, 'token0ToToken1'),
      protocol: 'v2',
      from: pair.token0,
      to: pair.token1,
      poolAddress: pair.pairAddress,
      direction: 'token0ToToken1',
      fee: pair.fee,
      reserveIn: pair.reserve0,
      reserveOut: pair.reserve1,
      rateNumerator: pair.reserve1 * feeMultiplier(pair.fee),
      rateDenominator: pair.reserve0 * FEE_DENOMINATOR,
      liquidity: pair.reserve0 < pair.reserve1 ? pair.reserve0 : pair.reserve1,
    });

    this.upsertEdge({
      id: this.edgeId('v2', pair.pairAddress, 'token1ToToken0'),
      protocol: 'v2',
      from: pair.token1,
      to: pair.token0,
      poolAddress: pair.pairAddress,
      direction: 'token1ToToken0',
      fee: pair.fee,
      reserveIn: pair.reserve1,
      reserveOut: pair.reserve0,
      rateNumerator: pair.reserve0 * feeMultiplier(pair.fee),
      rateDenominator: pair.reserve1 * FEE_DENOMINATOR,
      liquidity: pair.reserve0 < pair.reserve1 ? pair.reserve0 : pair.reserve1,
    });
  }

  private upsertV3Edges(pool: V3PoolInfo): void {
    if (!protocolAllowed(this.policy, 'v3')) return;

    const state = pool.state ?? {
      sqrtPriceX96: 0n,
      liquidity: 0n,
      tick: 0,
    };
    const feeMultiplier = V3_FEE_DENOMINATOR - BigInt(pool.fee);
    const priceNumerator = state.sqrtPriceX96 * state.sqrtPriceX96;

    this.upsertEdge({
      id: this.edgeId('v3', pool.address, 'token0ToToken1'),
      protocol: 'v3',
      from: pool.token0,
      to: pool.token1,
      poolAddress: pool.address,
      direction: 'token0ToToken1',
      fee: pool.fee,
      sqrtPriceX96: state.sqrtPriceX96,
      tickSpacing: pool.tickSpacing,
      tick: state.tick,
      rateNumerator: priceNumerator * feeMultiplier,
      rateDenominator: Q192 * V3_FEE_DENOMINATOR,
      liquidity: state.liquidity,
    });

    this.upsertEdge({
      id: this.edgeId('v3', pool.address, 'token1ToToken0'),
      protocol: 'v3',
      from: pool.token1,
      to: pool.token0,
      poolAddress: pool.address,
      direction: 'token1ToToken0',
      fee: pool.fee,
      sqrtPriceX96: state.sqrtPriceX96,
      tickSpacing: pool.tickSpacing,
      tick: state.tick,
      rateNumerator: Q192 * feeMultiplier,
      rateDenominator: priceNumerator * V3_FEE_DENOMINATOR,
      liquidity: state.liquidity,
    });
  }

  private upsertEdge(edge: AnyMarketEdge): void {
    const tokenIndex = this.tokenIndex(edge.from);
    const existingIndex = this.edgeIndexes.get(edge.id);

    if (existingIndex !== undefined) {
      Object.assign(this.edges[existingIndex].edge, edge);
      this.rankedEdgesCache.delete(this.edges[existingIndex].tokenIndex);
      return;
    }

    const edgeIndex = this.edges.length;
    this.edgeIndexes.set(edge.id, edgeIndex);
    this.edges.push({ edge, tokenIndex });
    this.tokens[tokenIndex].edgeIndexes.push(edgeIndex);
    this.rankedEdgesCache.delete(tokenIndex);
  }

  private selectTopEdges(edgeIndexes: number[], limit: number): AnyMarketEdge[] {
    if (limit <= 0 || edgeIndexes.length === 0) return [];

    const top: AnyMarketEdge[] = [];
    for (const edgeIndex of edgeIndexes) {
      const edge = this.edges[edgeIndex].edge;
      if (edge.liquidity <= 0n || edge.rateDenominator <= 0n) continue;

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

  private moveEdgeIntoRank(edges: AnyMarketEdge[], index: number): void {
    while (index > 0 && this.compareEdgeRank(edges[index], edges[index - 1]) > 0) {
      const previous = edges[index - 1];
      edges[index - 1] = edges[index];
      edges[index] = previous;
      index--;
    }
  }

  private compareEdgeRank(a: AnyMarketEdge, b: AnyMarketEdge): number {
    const rateCompare = compareFractions(
      a.rateNumerator,
      a.rateDenominator,
      b.rateNumerator,
      b.rateDenominator
    );

    if (rateCompare !== 0) return rateCompare;
    if (a.liquidity > b.liquidity) return 1;
    if (a.liquidity < b.liquidity) return -1;
    if (a.fee < b.fee) return 1;
    if (a.fee > b.fee) return -1;
    return 0;
  }

  private edgeId(protocol: 'v2' | 'v3', poolAddress: Address, direction: SwapDirection): MarketEdgeId {
    return `${protocol}:${poolAddress.toLowerCase()}:${direction}`;
  }

  private tokenIndex(token: Address): number {
    const key = this.addressKey(token);
    const existing = this.tokenIndexes.get(key);
    if (existing !== undefined) return existing;

    const index = this.tokens.length;
    this.tokenIndexes.set(key, index);
    this.tokens.push({ address: token, edgeIndexes: [] });
    return index;
  }

  private addressKey(address: Address): string {
    return address.toLowerCase();
  }
}
