import { type Address } from 'viem';
import { RUNTIME, V3_POOLS } from '../constants';
import {
  type V3Edge,
  type V3BitmapWord,
  type V3BitmapWordUpdate,
  type V3PoolConfig,
  type V3PoolInfo,
  type V3Tick,
  type V3TickUpdate,
  type V3PoolUpdate,
} from './v3-types';

type PoolEdges = {
  token0ToToken1: V3Edge;
  token1ToToken0: V3Edge;
};

type RankedEdgeCache = {
  limit: number;
  edges: V3Edge[];
};

export class V3Market {
  private graph: Map<Address, V3Edge[]> = new Map();
  private tokens: Set<Address> = new Set();
  private pools: Map<Address, V3PoolInfo> = new Map();
  private poolEdges: Map<Address, PoolEdges> = new Map();
  private rankedEdgesCache: Map<Address, RankedEdgeCache> = new Map();

  constructor(configuredPools: readonly V3PoolConfig[] = V3_POOLS) {
    for (const pool of configuredPools) {
      if (pool.enabled) this.addPool(pool);
    }
  }

  addPool(pool: V3PoolConfig): void {
    if (!pool.enabled) return;

    const existing = this.pools.get(pool.address);
    const poolInfo: V3PoolInfo = {
      ...pool,
      state: existing?.state ?? null,
      ticks: existing?.ticks ?? new Map(),
      bitmapWords: existing?.bitmapWords ?? new Map(),
    };

    this.tokens.add(pool.token0);
    this.tokens.add(pool.token1);
    this.pools.set(pool.address, poolInfo);
    this.updateEdges(poolInfo);
  }

  updatePoolStates(updates: V3PoolUpdate[]): void {
    const updatedPools = new Set<V3PoolInfo>();

    for (const update of updates) {
      const pool = this.pools.get(update.poolAddress);
      if (!pool) {
        console.warn(`V3 pool ${update.poolAddress} not found in market. Add it to V3_POOLS first.`);
        continue;
      }

      pool.state = {
        sqrtPriceX96: update.sqrtPriceX96,
        liquidity: update.liquidity,
        tick: update.tick,
      };
      updatedPools.add(pool);

      if (RUNTIME.debug) {
        console.log(`Updated V3 pool ${update.poolAddress}:`, {
          sqrtPriceX96: update.sqrtPriceX96.toString(),
          liquidity: update.liquidity.toString(),
          tick: update.tick,
        });
      }
    }

    for (const pool of updatedPools) {
      this.updateEdges(pool);
    }
  }

  updateTicks(updates: V3TickUpdate[]): void {
    for (const update of updates) {
      const pool = this.pools.get(update.poolAddress);
      if (!pool) {
        console.warn(`V3 pool ${update.poolAddress} not found in market. Add it to V3_POOLS first.`);
        continue;
      }

      for (const tick of update.ticks) {
        if (tick.liquidityGross === 0n && tick.liquidityNet === 0n) {
          pool.ticks.delete(tick.index);
          continue;
        }

        pool.ticks.set(tick.index, tick);
      }
    }
  }

  updateBitmapWords(updates: V3BitmapWordUpdate[]): void {
    for (const update of updates) {
      const pool = this.pools.get(update.poolAddress);
      if (!pool) {
        console.warn(`V3 pool ${update.poolAddress} not found in market. Add it to V3_POOLS first.`);
        continue;
      }

      for (const word of update.words) {
        if (word.bitmap === 0n) {
          pool.bitmapWords.delete(word.wordPosition);
          continue;
        }

        pool.bitmapWords.set(word.wordPosition, word.bitmap);
      }
    }
  }

  initializedTicks(poolAddress: Address): V3Tick[] {
    const pool = this.pools.get(poolAddress);
    if (!pool) return [];
    return Array.from(pool.ticks.values()).sort((a, b) => a.index - b.index);
  }

  bitmapWords(poolAddress: Address): V3BitmapWord[] {
    const pool = this.pools.get(poolAddress);
    if (!pool) return [];
    return Array.from(pool.bitmapWords.entries())
      .map(([wordPosition, bitmap]) => ({ wordPosition, bitmap }))
      .sort((a, b) => a.wordPosition - b.wordPosition);
  }

  rankedEdges(token: Address, limit: number): V3Edge[] {
    const cached = this.rankedEdgesCache.get(token);
    if (cached && cached.limit >= limit) return cached.edges;

    const ranked = this.selectTopEdges(this.graph.get(token) || [], limit);
    this.rankedEdgesCache.set(token, { limit, edges: ranked });
    return ranked;
  }

  edgeForTokenPool(token: Address, poolAddress: Address): V3Edge | null {
    const edges = this.poolEdges.get(poolAddress);
    if (!edges) return null;

    const pool = this.pools.get(poolAddress);
    if (pool?.token0 === token) return edges.token0ToToken1;
    if (pool?.token1 === token) return edges.token1ToToken0;
    return null;
  }

  pool(poolAddress: Address): V3PoolInfo | null {
    return this.pools.get(poolAddress) ?? null;
  }

  poolAddresses(): Address[] {
    return Array.from(this.pools.keys());
  }

  allPools(): V3PoolInfo[] {
    return Array.from(this.pools.values());
  }

  tokensList(): Address[] {
    return Array.from(this.tokens);
  }

  clear(): void {
    this.graph.clear();
    this.tokens.clear();
    this.pools.clear();
    this.poolEdges.clear();
    this.rankedEdgesCache.clear();
  }

  private updateEdges(pool: V3PoolInfo): void {
    const state = pool.state ?? {
      sqrtPriceX96: 0n,
      liquidity: 0n,
      tick: 0,
    };

    const existing = this.poolEdges.get(pool.address);
    if (existing) {
      this.updateEdge(existing.token0ToToken1, state.sqrtPriceX96, state.liquidity, state.tick);
      this.updateEdge(existing.token1ToToken0, state.sqrtPriceX96, state.liquidity, state.tick);
      this.rankedEdgesCache.delete(pool.token0);
      this.rankedEdgesCache.delete(pool.token1);
      return;
    }

    const token0ToToken1: V3Edge = {
      to: pool.token1,
      poolAddress: pool.address,
      direction: 'token0ToToken1',
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      sqrtPriceX96: state.sqrtPriceX96,
      liquidity: state.liquidity,
      tick: state.tick,
    };

    const token1ToToken0: V3Edge = {
      to: pool.token0,
      poolAddress: pool.address,
      direction: 'token1ToToken0',
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      sqrtPriceX96: state.sqrtPriceX96,
      liquidity: state.liquidity,
      tick: state.tick,
    };

    this.poolEdges.set(pool.address, { token0ToToken1, token1ToToken0 });
    this.pushEdge(pool.token0, token0ToToken1);
    this.pushEdge(pool.token1, token1ToToken0);
    this.rankedEdgesCache.delete(pool.token0);
    this.rankedEdgesCache.delete(pool.token1);
  }

  private updateEdge(edge: V3Edge, sqrtPriceX96: bigint, liquidity: bigint, tick: number): void {
    edge.sqrtPriceX96 = sqrtPriceX96;
    edge.liquidity = liquidity;
    edge.tick = tick;
  }

  private pushEdge(token: Address, edge: V3Edge): void {
    const edges = this.graph.get(token);
    if (edges) {
      edges.push(edge);
      return;
    }

    this.graph.set(token, [edge]);
  }

  private selectTopEdges(edges: V3Edge[], limit: number): V3Edge[] {
    if (limit <= 0 || edges.length === 0) return [];

    const top: V3Edge[] = [];
    for (const edge of edges) {
      if (edge.liquidity === 0n) continue;

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

  private moveEdgeIntoRank(edges: V3Edge[], index: number): void {
    while (index > 0 && this.compareEdgeRank(edges[index], edges[index - 1]) > 0) {
      const previous = edges[index - 1];
      edges[index - 1] = edges[index];
      edges[index] = previous;
      index--;
    }
  }

  private compareEdgeRank(a: V3Edge, b: V3Edge): number {
    if (a.liquidity > b.liquidity) return 1;
    if (a.liquidity < b.liquidity) return -1;
    if (a.fee < b.fee) return 1;
    if (a.fee > b.fee) return -1;
    return 0;
  }
}
