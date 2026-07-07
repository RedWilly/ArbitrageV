import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, V3_POOLS } from '../constants';
import { type CarbonStrategy } from '../market/carbon';
import { graphToken } from '../tokens';
import {
  type PairInfo,
  type ReserveUpdate,
  type SwapDirection,
} from '../market/v2-types';
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
import {
  carbonMarginalRate,
  carbonSourceAmountForFullOrder,
  quoteCarbonExactInput,
  quoteCarbonExactInputBeforeFee,
} from '../pricing/carbon-swap-math';
import { Q96, quoteV3MultiRangeExactInput, V3_FEE_DENOMINATOR } from '../pricing/v3-swap-math';
import { feeMultiplier } from '../values';
import {
  type AnyMarketEdge,
  type ArbitrageSearchPolicy,
  type CarbonGroupOrder,
  type CarbonGroupedMarketEdge,
  type CarbonMarketEdge,
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
  toTokenIndex: number;
  poolIndex: number;
};

type IndexedEdgeCache = {
  limit: number;
  edgeIndexes: number[];
};

type CarbonAllocation = {
  strategyId: bigint;
  amountIn: bigint;
};

const Q192 = Q96 * Q96;
const MAX_GROUPED_CARBON_ORDERS = 8;

class AddressRegistry {
  private readonly indexes = new Map<string, number>();
  private readonly addresses: string[] = [];

  get(address: Address | string): number | undefined {
    return this.indexes.get(this.key(address));
  }

  getOrAdd(address: Address | string): number {
    const key = this.key(address);
    const existing = this.indexes.get(key);
    if (existing !== undefined) return existing;

    const index = this.addresses.length;
    this.indexes.set(key, index);
    this.addresses.push(address);
    return index;
  }

  address(index: number): string {
    return this.addresses[index];
  }

  clear(): void {
    this.indexes.clear();
    this.addresses.length = 0;
  }

  key(address: Address | string): string {
    return address.toLowerCase();
  }
}

export class MarketGraph {
  private readonly tokenRegistry = new AddressRegistry();
  private readonly poolRegistry = new AddressRegistry();
  private readonly tokens: TokenSlot[] = [];
  private readonly edgeIndexes = new Map<MarketEdgeId, number>();
  private readonly edges: EdgeSlot[] = [];
  private readonly rankedEdgesCache = new Map<number, IndexedEdgeCache>();
  private readonly pairs: Array<PairInfo | undefined> = [];
  private readonly v3Pools: Array<V3PoolInfo | undefined> = [];
  private readonly carbonEdgeIds = new Set<MarketEdgeId>();

  constructor(
    private readonly policy: ArbitrageSearchPolicy = ARBITRAGE_SEARCH_POLICY,
    configuredV3Pools: readonly V3PoolConfig[] = V3_POOLS
  ) {
    for (const pool of configuredV3Pools) this.addV3Pool(pool);
  }

  addPair(pair: PairInfo): void {
    if (pair.reserve0 === 0n || pair.reserve1 === 0n) return;
    const poolIndex = this.poolIndex(pair.pairAddress);
    this.pairs[poolIndex] = pair;
    this.upsertV2Edges(pair, poolIndex);
  }

  updateReserves(updates: ReserveUpdate[]): void {
    for (const update of updates) {
      const poolIndex = this.poolRegistry.get(update.pairAddress);
      if (poolIndex === undefined) continue;

      const pair = this.pairs[poolIndex];
      if (!pair) continue;

      pair.reserve0 = update.reserve0;
      pair.reserve1 = update.reserve1;
      this.upsertV2Edges(pair, poolIndex);
    }
  }

  addV3Pool(pool: V3PoolConfig): void {
    if (!pool.enabled) return;

    const poolIndex = this.poolIndex(pool.address);
    const existing = this.v3Pools[poolIndex];
    const poolInfo: V3PoolInfo = {
      ...pool,
      state: existing?.state ?? null,
      ticks: existing?.ticks ?? new Map(),
      bitmapWords: existing?.bitmapWords ?? new Map(),
    };

    this.v3Pools[poolIndex] = poolInfo;
    this.upsertV3Edges(poolInfo, poolIndex);
  }

  updateV3PoolStates(updates: V3PoolUpdate[]): void {
    for (const update of updates) {
      const poolIndex = this.poolRegistry.get(update.poolAddress);
      if (poolIndex === undefined) continue;

      const pool = this.v3Pools[poolIndex];
      if (!pool) continue;

      pool.state = {
        sqrtPriceX96: update.sqrtPriceX96,
        liquidity: update.liquidity,
        tick: update.tick,
      };
      this.upsertV3Edges(pool, poolIndex);
    }
  }

  updateV3Ticks(updates: V3TickUpdate[]): void {
    for (const update of updates) {
      const poolIndex = this.poolRegistry.get(update.poolAddress);
      const pool = poolIndex === undefined ? undefined : this.v3Pools[poolIndex];
      if (!pool) continue;

      for (const tick of update.ticks) {
        if (tick.liquidityGross === 0n && tick.liquidityNet === 0n) {
          pool.ticks.delete(tick.index);
        } else {
          pool.ticks.set(tick.index, tick);
        }
      }
    }
  }

  updateV3BitmapWords(updates: V3BitmapWordUpdate[]): void {
    for (const update of updates) {
      const poolIndex = this.poolRegistry.get(update.poolAddress);
      const pool = poolIndex === undefined ? undefined : this.v3Pools[poolIndex];
      if (!pool) continue;

      for (const word of update.words) {
        if (word.bitmap === 0n) {
          pool.bitmapWords.delete(word.wordPosition);
        } else {
          pool.bitmapWords.set(word.wordPosition, word.bitmap);
        }
      }
    }
  }

  rankedEdges(token: Address, limit: number): AnyMarketEdge[] {
    const tokenIndex = this.tokenIndexOf(token);
    if (tokenIndex === undefined) return [];

    return this.rankedEdgeIndexes(tokenIndex, limit)
      .map(edgeIndex => this.edges[edgeIndex].edge);
  }

  setCarbonStrategies(strategies: readonly CarbonStrategy[]): void {
    for (const edgeId of this.carbonEdgeIds) {
      const edge = this.edge(edgeId);
      if (edge?.protocol !== 'carbon') continue;
      edge.liquidity = 0n;
      edge.rateNumerator = 0n;
      edge.rateDenominator = 0n;
      if (edge.carbonKind === 'group') edge.orders = [];
    }

    for (const strategy of strategies) {
      this.upsertCarbonEdges(strategy);
    }
    this.upsertGroupedCarbonEdges(strategies);

    this.rankedEdgesCache.clear();
  }

  edgesForTokenPool(token: Address, poolAddress: Address): AnyMarketEdge[] {
    const tokenIndex = this.tokenIndexOf(token);
    const poolIndex = this.poolIndexOf(poolAddress);
    if (tokenIndex === undefined || poolIndex === undefined) return [];

    return this.edgeIndexesForTokenPool(tokenIndex, poolIndex)
      .map(edgeIndex => this.edges[edgeIndex].edge);
  }

  rankedEdgeIndexes(tokenIndex: number, limit: number): number[] {
    if (tokenIndex < 0 || tokenIndex >= this.tokens.length) return [];

    const cached = this.rankedEdgesCache.get(tokenIndex);
    if (cached && cached.limit >= limit) return cached.edgeIndexes;

    const ranked = this.selectTopEdgeIndexes(this.tokens[tokenIndex].edgeIndexes, limit);
    this.rankedEdgesCache.set(tokenIndex, { limit, edgeIndexes: ranked });
    return ranked;
  }

  edgeIndexesForTokenPool(tokenIndex: number, poolIndex: number): number[] {
    if (tokenIndex < 0 || tokenIndex >= this.tokens.length) return [];

    const edgeIndexes = this.tokens[tokenIndex].edgeIndexes;
    const matches: number[] = [];

    for (const edgeIndex of edgeIndexes) {
      if (this.edges[edgeIndex].poolIndex === poolIndex) {
        matches.push(edgeIndex);
      }
    }

    return matches;
  }

  tokenIndexOf(token: Address): number | undefined {
    return this.tokenRegistry.get(token);
  }

  poolIndexOf(pool: Address): number | undefined {
    return this.poolRegistry.get(pool);
  }

  tokenAddress(tokenIndex: number): Address {
    return this.tokenRegistry.address(tokenIndex) as Address;
  }

  edgeAt(edgeIndex: number): AnyMarketEdge | null {
    return this.edges[edgeIndex]?.edge ?? null;
  }

  edgeToTokenIndex(edgeIndex: number): number {
    return this.edges[edgeIndex].toTokenIndex;
  }

  edgePoolIndex(edgeIndex: number): number {
    return this.edges[edgeIndex].poolIndex;
  }

  edge(edgeId: MarketEdgeId): AnyMarketEdge | null {
    const edgeIndex = this.edgeIndexes.get(edgeId);
    return edgeIndex === undefined ? null : this.edges[edgeIndex].edge;
  }

  quoteEdgeAt(edgeIndex: number, amountIn: bigint): MarketRouteQuote {
    const edge = this.edgeAt(edgeIndex);
    return edge
      ? this.quoteEdge(edge, amountIn)
      : { amountIn, amountOut: 0n, profit: -1n, complete: false };
  }

  carbonExecution(
    edgeIndex: number,
    amountIn: bigint
  ): { rawFrom: Address; rawTo: Address; strategyIds: bigint[]; amounts: bigint[] } | null {
    const edge = this.edgeAt(edgeIndex);
    if (!edge || edge.protocol !== 'carbon') return null;

    if (edge.carbonKind === 'single') {
      return {
        rawFrom: edge.rawFrom,
        rawTo: edge.rawTo,
        strategyIds: [edge.strategyId],
        amounts: [amountIn],
      };
    }

    const allocations: CarbonAllocation[] = [];
    const quote = this.quoteCarbonGroupEdge(edge, amountIn, allocations);
    if (!quote.complete || allocations.length === 0) return null;

    return {
      rawFrom: edge.rawFrom,
      rawTo: edge.rawTo,
      strategyIds: allocations.map(allocation => allocation.strategyId),
      amounts: allocations.map(allocation => allocation.amountIn),
    };
  }

  quote(route: MarketRoute, amountIn: bigint): MarketRouteQuote {
    if (amountIn <= 0n) {
      return { amountIn, amountOut: 0n, profit: 0n, complete: false };
    }

    let amount = amountIn;

    const edgeIndexes = route.edgeIndexes ?? route.edgeIds.map(edgeId => this.edgeIndexes.get(edgeId) ?? -1);

    for (const edgeIndex of edgeIndexes) {
      const edge = this.edgeAt(edgeIndex);
      if (!edge) return { amountIn, amountOut: 0n, profit: -1n, complete: false };

      const quote = this.quoteEdge(edge, amount);

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

    const edgeIndexes = route.edgeIndexes ?? route.edgeIds.map(edgeId => this.edgeIndexes.get(edgeId) ?? -1);

    for (const edgeIndex of edgeIndexes) {
      const edge = this.edgeAt(edgeIndex);
      if (!edge) return 0n;

      const candidate = edge.liquidity / this.policy.maxInputReserveFraction;
      if (candidate <= 0n) return 0n;
      bound = bound === null || candidate < bound ? candidate : bound;
    }

    return bound ?? 0n;
  }

  getTokens(): Address[] {
    return this.tokens.map((_, index) => this.tokenRegistry.address(index) as Address);
  }

  getPairAddresses(): Address[] {
    return this.pairs.filter((pair): pair is PairInfo => pair !== undefined)
      .map(pair => pair.pairAddress);
  }

  getAllPairs(): PairInfo[] {
    return this.pairs.filter((pair): pair is PairInfo => pair !== undefined);
  }

  getV3PoolAddresses(): Address[] {
    return this.v3Pools.filter((pool): pool is V3PoolInfo => pool !== undefined)
      .map(pool => pool.address);
  }

  getV3Pools(): V3PoolInfo[] {
    return this.v3Pools.filter((pool): pool is V3PoolInfo => pool !== undefined);
  }

  getV3InitializedTicks(poolAddress: Address): V3Tick[] {
    const poolIndex = this.poolRegistry.get(poolAddress);
    const pool = poolIndex === undefined ? undefined : this.v3Pools[poolIndex];
    if (!pool) return [];
    return Array.from(pool.ticks.values()).sort((a, b) => a.index - b.index);
  }

  getV3BitmapWords(poolAddress: Address): V3BitmapWord[] {
    const poolIndex = this.poolRegistry.get(poolAddress);
    const pool = poolIndex === undefined ? undefined : this.v3Pools[poolIndex];
    if (!pool) return [];
    return Array.from(pool.bitmapWords.entries())
      .map(([wordPosition, bitmap]) => ({ wordPosition, bitmap }))
      .sort((a, b) => a.wordPosition - b.wordPosition);
  }

  findBestFlashPoolForToken(
    token: Address,
    amountIn: bigint,
    excludePools: Address[] = []
  ): FlashPoolCandidate | null {
    const tokenIndex = this.tokenIndexOf(token);
    if (tokenIndex === undefined) return null;

    const excluded = new Set<number>();
    for (const pool of excludePools) {
      const poolIndex = this.poolIndexOf(pool);
      if (poolIndex !== undefined) excluded.add(poolIndex);
    }

    let best: FlashPoolCandidate | null = null;

    for (const edgeIndex of this.tokens[tokenIndex].edgeIndexes) {
      if (excluded.has(this.edges[edgeIndex].poolIndex)) continue;
      const edge = this.edges[edgeIndex].edge;
      if (edge.protocol === 'carbon') continue;
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
    this.pairs.length = 0;
    this.v3Pools.length = 0;
    this.tokenRegistry.clear();
    this.poolRegistry.clear();
    this.tokens.length = 0;
    this.edgeIndexes.clear();
    this.edges.length = 0;
    this.rankedEdgesCache.clear();
    this.carbonEdgeIds.clear();
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

  private quoteEdge(edge: AnyMarketEdge, amountIn: bigint): MarketRouteQuote {
    return edge.protocol === 'v2'
      ? this.quoteV2Edge(edge, amountIn)
      : edge.protocol === 'v3'
        ? this.quoteV3Edge(edge, amountIn)
        : this.quoteCarbonEdge(edge, amountIn);
  }

  private quoteV3Edge(edge: Extract<AnyMarketEdge, { protocol: 'v3' }>, amountIn: bigint): MarketRouteQuote {
    const poolIndex = this.poolIndexOf(edge.poolAddress);
    const pool = poolIndex === undefined ? undefined : this.v3Pools[poolIndex];
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
      ticks: this.getV3InitializedTicks(pool.address),
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

  private upsertV2Edges(pair: PairInfo, poolIndex: number): void {
    if (pair.reserve0 === 0n || pair.reserve1 === 0n || !protocolAllowed(this.policy, 'v2')) return;

    const token0Index = this.tokenIndex(pair.token0);
    const token1Index = this.tokenIndex(pair.token1);

    this.upsertEdge({
      id: this.edgeId('v2', poolIndex, 'token0ToToken1'),
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
    }, token0Index, token1Index, poolIndex);

    this.upsertEdge({
      id: this.edgeId('v2', poolIndex, 'token1ToToken0'),
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
    }, token1Index, token0Index, poolIndex);
  }

  private quoteCarbonEdge(edge: CarbonMarketEdge, amountIn: bigint): MarketRouteQuote {
    if (edge.carbonKind === 'group') return this.quoteCarbonGroupEdge(edge, amountIn);

    const quote = quoteCarbonExactInput(amountIn, edge.order, edge.fee);
    return {
      amountIn,
      amountOut: quote.amountOut,
      profit: quote.complete ? quote.amountOut - amountIn : -1n,
      complete: quote.complete,
    };
  }

  private quoteCarbonGroupEdge(
    edge: CarbonGroupedMarketEdge,
    amountIn: bigint,
    allocations?: CarbonAllocation[]
  ): MarketRouteQuote {
    let remaining = amountIn;
    let amountOutBeforeFee = 0n;

    for (const order of edge.orders) {
      if (remaining <= 0n) break;

      let input = remaining;
      let quote = quoteCarbonExactInputBeforeFee(input, order.order);
      if (!quote.complete) {
        input = carbonSourceAmountForFullOrder(order.order);
        if (input <= 0n) continue;
        if (input > remaining) input = remaining;
        quote = quoteCarbonExactInputBeforeFee(input, order.order);
        if (!quote.complete) {
          input = this.maxCarbonInputForOrder(order.order, input);
          if (input <= 0n) continue;
          quote = quoteCarbonExactInputBeforeFee(input, order.order);
        }
      }
      if (!quote.complete || quote.amountOut <= 0n) continue;

      remaining -= input;
      amountOutBeforeFee += quote.amountOut;
      allocations?.push({ strategyId: order.strategyId, amountIn: input });
    }

    if (remaining > 0n || amountOutBeforeFee <= 0n) {
      return { amountIn, amountOut: amountOutBeforeFee, profit: -1n, complete: false };
    }

    const amountOut = (amountOutBeforeFee * BigInt(1_000_000 - edge.fee)) / 1_000_000n;
    return {
      amountIn,
      amountOut,
      profit: amountOut - amountIn,
      complete: amountOut > 0n,
    };
  }

  private maxCarbonInputForOrder(order: CarbonGroupOrder['order'], high: bigint): bigint {
    let low = 0n;

    while (low < high) {
      const mid = (low + high + 1n) / 2n;
      if (quoteCarbonExactInputBeforeFee(mid, order).complete) {
        low = mid;
      } else {
        high = mid - 1n;
      }
    }

    return low;
  }

  private upsertV3Edges(pool: V3PoolInfo, poolIndex: number): void {
    if (!protocolAllowed(this.policy, 'v3')) return;

    const token0Index = this.tokenIndex(pool.token0);
    const token1Index = this.tokenIndex(pool.token1);
    const state = pool.state ?? {
      sqrtPriceX96: 0n,
      liquidity: 0n,
      tick: 0,
    };
    const feeMultiplier = V3_FEE_DENOMINATOR - BigInt(pool.fee);
    const priceNumerator = state.sqrtPriceX96 * state.sqrtPriceX96;

    this.upsertEdge({
      id: this.edgeId('v3', poolIndex, 'token0ToToken1'),
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
    }, token0Index, token1Index, poolIndex);

    this.upsertEdge({
      id: this.edgeId('v3', poolIndex, 'token1ToToken0'),
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
    }, token1Index, token0Index, poolIndex);
  }

  private upsertCarbonEdges(strategy: CarbonStrategy): void {
    if (!protocolAllowed(this.policy, 'carbon')) return;

    this.upsertCarbonOrder(strategy, 0, strategy.token1, strategy.token0);
    this.upsertCarbonOrder(strategy, 1, strategy.token0, strategy.token1);
  }

  private upsertGroupedCarbonEdges(strategies: readonly CarbonStrategy[]): void {
    if (!protocolAllowed(this.policy, 'carbon')) return;

    const groups = new Map<string, {
      controller: Address;
      rawFrom: Address;
      rawTo: Address;
      graphFrom: Address;
      graphTo: Address;
      fee: number;
      direction: SwapDirection;
      orders: Array<CarbonGroupOrder & { rateNumerator: bigint; rateDenominator: bigint; liquidity: bigint }>;
    }>();

    for (const strategy of strategies) {
      this.collectGroupedCarbonOrder(groups, strategy, 0, strategy.token1, strategy.token0);
      this.collectGroupedCarbonOrder(groups, strategy, 1, strategy.token0, strategy.token1);
    }

    for (const group of groups.values()) {
      if (group.orders.length < 2) continue;

      group.orders.sort((a, b) => compareFractions(
        b.rateNumerator,
        b.rateDenominator,
        a.rateNumerator,
        a.rateDenominator
      ));
      const orders = group.orders.slice(0, MAX_GROUPED_CARBON_ORDERS);
      const liquidity = orders.reduce((sum, order) => sum + order.liquidity, 0n);
      if (liquidity <= 0n) continue;

      const poolIndex = this.poolIndex(`carbon-group:${group.controller.toLowerCase()}:${group.rawFrom.toLowerCase()}:${group.rawTo.toLowerCase()}`);
      const tokenIndex = this.tokenIndex(group.graphFrom);
      const toTokenIndex = this.tokenIndex(group.graphTo);
      const edgeId = this.carbonGroupEdgeId(group.controller, group.rawFrom, group.rawTo);
      const best = orders[0];

      this.carbonEdgeIds.add(edgeId);
      this.upsertEdge({
        id: edgeId,
        protocol: 'carbon',
        carbonKind: 'group',
        from: group.graphFrom,
        to: group.graphTo,
        poolAddress: group.controller,
        direction: group.direction,
        fee: group.fee,
        rawFrom: group.rawFrom,
        rawTo: group.rawTo,
        orders,
        rateNumerator: best.rateNumerator,
        rateDenominator: best.rateDenominator,
        liquidity,
      }, tokenIndex, toTokenIndex, poolIndex);
    }
  }

  private collectGroupedCarbonOrder(
    groups: Map<string, {
      controller: Address;
      rawFrom: Address;
      rawTo: Address;
      graphFrom: Address;
      graphTo: Address;
      fee: number;
      direction: SwapDirection;
      orders: Array<CarbonGroupOrder & { rateNumerator: bigint; rateDenominator: bigint; liquidity: bigint }>;
    }>,
    strategy: CarbonStrategy,
    orderIndex: 0 | 1,
    from: Address,
    to: Address
  ): void {
    const order = strategy.orders[orderIndex];
    if (order.y <= 0n || order.z <= 0n) return;

    const rate = carbonMarginalRate(order, strategy.feePpm);
    if (rate.numerator <= 0n || rate.denominator <= 0n) return;

    const key = `${strategy.controller.toLowerCase()}:${from.toLowerCase()}:${to.toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        controller: strategy.controller,
        rawFrom: from,
        rawTo: to,
        graphFrom: graphToken(from),
        graphTo: graphToken(to),
        fee: strategy.feePpm,
        direction: orderIndex === 0 ? 'token1ToToken0' : 'token0ToToken1',
        orders: [],
      };
      groups.set(key, group);
    }

    group.orders.push({
      strategyId: strategy.id,
      orderIndex,
      rawFrom: from,
      rawTo: to,
      order,
      rateNumerator: rate.numerator,
      rateDenominator: rate.denominator,
      liquidity: order.y,
    });
  }

  private upsertCarbonOrder(
    strategy: CarbonStrategy,
    orderIndex: 0 | 1,
    from: Address,
    to: Address
  ): void {
    const order = strategy.orders[orderIndex];
    if (order.y <= 0n || order.z <= 0n) return;

    const graphFrom = graphToken(from);
    const graphTo = graphToken(to);
    const poolIndex = this.poolIndex(`carbon:${strategy.controller.toLowerCase()}:${strategy.id.toString()}`);
    const tokenIndex = this.tokenIndex(graphFrom);
    const toTokenIndex = this.tokenIndex(graphTo);
    const rate = carbonMarginalRate(order, strategy.feePpm);
    const edgeId = this.carbonEdgeId(strategy, orderIndex);

    this.carbonEdgeIds.add(edgeId);
    this.upsertEdge({
      id: edgeId,
      protocol: 'carbon',
      carbonKind: 'single',
      from: graphFrom,
      to: graphTo,
      poolAddress: strategy.controller,
      direction: orderIndex === 0 ? 'token1ToToken0' : 'token0ToToken1',
      fee: strategy.feePpm,
      strategyId: strategy.id,
      orderIndex,
      rawFrom: from,
      rawTo: to,
      order,
      rateNumerator: rate.numerator,
      rateDenominator: rate.denominator,
      liquidity: order.y,
    }, tokenIndex, toTokenIndex, poolIndex);
  }

  private upsertEdge(
    edge: AnyMarketEdge,
    tokenIndex: number,
    toTokenIndex: number,
    poolIndex: number
  ): void {
    const existingIndex = this.edgeIndexes.get(edge.id);

    if (existingIndex !== undefined) {
      const previousTokenIndex = this.edges[existingIndex].tokenIndex;
      Object.assign(this.edges[existingIndex].edge, edge);
      this.edges[existingIndex].tokenIndex = tokenIndex;
      this.edges[existingIndex].toTokenIndex = toTokenIndex;
      this.edges[existingIndex].poolIndex = poolIndex;
      this.rankedEdgesCache.delete(previousTokenIndex);
      this.rankedEdgesCache.delete(tokenIndex);
      return;
    }

    const edgeIndex = this.edges.length;
    this.edgeIndexes.set(edge.id, edgeIndex);
    this.edges.push({ edge, tokenIndex, toTokenIndex, poolIndex });
    this.tokens[tokenIndex].edgeIndexes.push(edgeIndex);
    this.rankedEdgesCache.delete(tokenIndex);
  }

  private selectTopEdgeIndexes(edgeIndexes: number[], limit: number): number[] {
    if (limit <= 0 || edgeIndexes.length === 0) return [];

    const top: number[] = [];
    for (const edgeIndex of edgeIndexes) {
      const edge = this.edges[edgeIndex].edge;
      if (edge.liquidity <= 0n || edge.rateDenominator <= 0n) continue;

      if (top.length < limit) {
        top.push(edgeIndex);
        this.moveEdgeIndexIntoRank(top, top.length - 1);
        continue;
      }

      if (this.compareEdgeRank(edge, this.edges[top[top.length - 1]].edge) < 0) continue;
      top[top.length - 1] = edgeIndex;
      this.moveEdgeIndexIntoRank(top, top.length - 1);
    }

    return top;
  }

  private moveEdgeIndexIntoRank(edgeIndexes: number[], index: number): void {
    while (
      index > 0 &&
      this.compareEdgeRank(this.edges[edgeIndexes[index]].edge, this.edges[edgeIndexes[index - 1]].edge) > 0
    ) {
      const previous = edgeIndexes[index - 1];
      edgeIndexes[index - 1] = edgeIndexes[index];
      edgeIndexes[index] = previous;
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

  private edgeId(protocol: 'v2' | 'v3', poolIndex: number, direction: SwapDirection): MarketEdgeId {
    return `${protocol}:${poolIndex}:${direction}`;
  }

  private carbonEdgeId(strategy: CarbonStrategy, orderIndex: 0 | 1): MarketEdgeId {
    return `carbon:${strategy.controller.toLowerCase()}:${strategy.id.toString()}:${orderIndex}`;
  }

  private carbonGroupEdgeId(controller: Address, from: Address, to: Address): MarketEdgeId {
    return `carbon-group:${controller.toLowerCase()}:${from.toLowerCase()}:${to.toLowerCase()}`;
  }

  private tokenIndex(token: Address): number {
    const index = this.tokenRegistry.getOrAdd(token);
    this.tokens[index] ??= { address: token, edgeIndexes: [] };
    return index;
  }

  private poolIndex(pool: Address | string): number {
    return this.poolRegistry.getOrAdd(pool);
  }
}
