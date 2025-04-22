import { maxHops, MAX_ENTRIES_PER_TOKEN, DEBUG, minProfit, maxIterations, minProfits, ADDRESSES, NERK, enableV3Pools } from './constants';
import { type Address } from 'viem';
import type { V3PoolInfo } from './getinfo';

export type PairInfo = {
  pairAddress: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  fee: number;
};

interface Edge {
  to: Address;
  pairAddress: Address;
  direction: 'token0ToToken1' | 'token1ToToken0';
  fee: number;
  reserveIn: bigint;
  reserveOut: bigint;
}

interface V3Edge {
  to: Address;
  poolAddress: Address;
  direction: 'token0ToToken1' | 'token1ToToken0';
  fee: number;
  tick: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
}

interface DPEntry {
  amountOut: number;
  path: Address[];
  pairs: Address[];
  directions: ('token0ToToken1' | 'token1ToToken0')[];
  edges: (Edge | V3Edge)[];
}

interface DPTable {
  [step: number]: Map<Address, DPEntry[]>;
}

export class ArbitrageGraph {
  private graph: Map<Address, Edge[]> = new Map();
  private tokens: Set<Address> = new Set();
  private pairs: Map<Address, PairInfo> = new Map();
  private edgeIndex: Map<string, Edge> = new Map();
  private v3Graph: Map<Address, V3Edge[]> = new Map();
  private v3EdgeIndex: Map<string, V3Edge> = new Map();
  private tokenToHighestReservePair: Map<Address, { pairAddress: Address; reserves: bigint; fee: number }> = new Map();

  private createEdgeKey(fromToken: Address, pairAddress: Address): string {
    return `${fromToken}-${pairAddress}`;
  }

  private createV3EdgeKey(fromToken: Address, poolAddress: Address): string {
    return `${fromToken}-${poolAddress}`;
  }

  addPair(pair: PairInfo): void {
    const res0 = Number(pair.reserve0);
    const res1 = Number(pair.reserve1);
    if (res0 === 0 || res1 === 0) return;
    this.tokens.add(pair.token0);
    this.tokens.add(pair.token1);
    this.pairs.set(pair.pairAddress, pair);
    this.updateGraphEdges(pair);
  }

  private updateGraphEdges(pair: PairInfo): void {
    const res0 = Number(pair.reserve0);
    const res1 = Number(pair.reserve1);
    if (res0 === 0 || res1 === 0) return;

    const best0 = this.tokenToHighestReservePair.get(pair.token0);
    if (!best0 || pair.reserve0 > best0.reserves) {
      this.tokenToHighestReservePair.set(pair.token0, { pairAddress: pair.pairAddress, reserves: pair.reserve0, fee: pair.fee });
    }
    const best1 = this.tokenToHighestReservePair.get(pair.token1);
    if (!best1 || pair.reserve1 > best1.reserves) {
      this.tokenToHighestReservePair.set(pair.token1, { pairAddress: pair.pairAddress, reserves: pair.reserve1, fee: pair.fee });
    }

    // V2 edges
    for (const [direction, [inRes, outRes]] of Object.entries({ token0ToToken1: [pair.reserve0, pair.reserve1], token1ToToken0: [pair.reserve1, pair.reserve0] } as const)) {
      const from = direction === 'token0ToToken1' ? pair.token0 : pair.token1;
      const to = direction === 'token0ToToken1' ? pair.token1 : pair.token0;
      const key = this.createEdgeKey(from, pair.pairAddress);
      const existing = this.edgeIndex.get(key);
      const edge: Edge = { to, pairAddress: pair.pairAddress, direction: direction as any, fee: pair.fee, reserveIn: inRes, reserveOut: outRes };
      if (existing) {
        Object.assign(existing, edge);
      } else {
        this.edgeIndex.set(key, edge);
        if (!this.graph.has(from)) this.graph.set(from, []);
        this.graph.get(from)!.push(edge);
      }
    }
  }

  // Helper function to update pair reserves without re-building the entire graph
  updatePairReserves(pairAddress: Address, reserve0: bigint, reserve1: bigint): void {
    this.updatePairReservesBatch([{ pairAddress, reserve0, reserve1 }]);
  }

  // handle batch updates 
  updatePairReservesBatch(updates: { pairAddress: Address; reserve0: bigint; reserve1: bigint }[]): void {
    const updatedPairs = new Set<PairInfo>();

    for (const update of updates) {
      const pair = this.pairs.get(update.pairAddress);
      if (!pair) {
        console.warn(`Pair ${update.pairAddress} not found in graph. Consider adding it first.`);
        continue;
      }

      // Update the reserves in the PairInfo
      pair.reserve0 = update.reserve0;
      pair.reserve1 = update.reserve1;
      updatedPairs.add(pair);

      if (DEBUG) {
        console.log(`Updated reserves for pair ${update.pairAddress}: ${update.reserve0}, ${update.reserve1}`);
      }
    }

    // Update graph edges only once for all modified pairs
    for (const pair of updatedPairs) {
      this.updateGraphEdges(pair);
    }
  }
  

  public addV3Pools(pools: V3PoolInfo[]): void {
    if (!enableV3Pools) return;
    for (const pool of pools) {
      for (const [direction, [fromToken, toToken]] of Object.entries({ token0ToToken1: [pool.token0, pool.token1], token1ToToken0: [pool.token1, pool.token0] } as const)) {
        const key = this.createV3EdgeKey(fromToken, pool.poolAddress);
        const edge: V3Edge = { to: toToken, poolAddress: pool.poolAddress, direction: direction as any, fee: pool.fee, tick: pool.tick, liquidity: pool.liquidity, sqrtPriceX96: pool.sqrtPriceX96 };
        const existing = this.v3EdgeIndex.get(key);
        if (existing) {
          Object.assign(existing, edge);
        } else {
          this.v3EdgeIndex.set(key, edge);
          if (!this.v3Graph.has(fromToken)) this.v3Graph.set(fromToken, []);
          this.v3Graph.get(fromToken)!.push(edge);
        }
      }
    }
  }

  public updateV3Pools(pools: V3PoolInfo[]): void {
    if (!enableV3Pools) return;
    for (const pool of pools) {
      for (const fromToken of [pool.token0, pool.token1]) {
        const key = this.createV3EdgeKey(fromToken, pool.poolAddress);
        const edge = this.v3EdgeIndex.get(key);
        if (edge) {
          edge.tick = pool.tick;
          edge.liquidity = pool.liquidity;
          edge.sqrtPriceX96 = pool.sqrtPriceX96;
        }
      }
    }
  }

  findMultiTokenArbitrageOpportunities(startTokens: Address[], maxDepth: number = maxHops) {
    const dp: DPTable = {};
    const raw: DPEntry[] = [];
    dp[0] = new Map();

    for (const tok of startTokens) dp[0].set(tok, [{ amountOut: 1, path: [tok], pairs: [], directions: [], edges: [] }]);

    for (let step = 1; step <= maxDepth; step++) {
      dp[step] = new Map();
      for (const [cur, entries] of dp[step-1].entries()) {
        const v2 = this.graph.get(cur) || [];
        const v3 = enableV3Pools ? this.v3Graph.get(cur) || [] : [];
        for (const ent of entries) {
          for (const edge of [...v2, ...v3]) {
            const id = 'reserveIn' in edge ? edge.pairAddress : edge.poolAddress;
            if (ent.pairs.includes(id)) continue;
            const out = 'reserveIn' in edge
              ? this.getAmountOutV2(ent.amountOut, Number(edge.reserveIn), Number(edge.reserveOut), edge.fee)
              : this.getAmountOutV3(ent.amountOut, edge.sqrtPriceX96, edge.liquidity, edge.fee);
            const newEnt: DPEntry = {
              amountOut: out,
              path: [...ent.path, edge.to],
              pairs: [...ent.pairs, id],
              directions: [...ent.directions, edge.direction],
              edges: [...ent.edges, edge],
            };
            const mapArr = dp[step].get(edge.to) || [];
            mapArr.push(newEnt);
            mapArr.sort((a,b)=>b.amountOut-a.amountOut);
            if (mapArr.length>MAX_ENTRIES_PER_TOKEN) mapArr.splice(MAX_ENTRIES_PER_TOKEN);
            dp[step].set(edge.to, mapArr);
            if (step>=2) {
              const orig = ent.path[0];
              if ((!NERK && edge.to===orig) || (NERK && startTokens.includes(orig) && startTokens.includes(edge.to))) {
                raw.push(newEnt);
              }
            }
          }
        }
      }
    }

    const validated = raw.map(e=>{
      const { maxProfit, optimalInput } = this.calculateMaxProfit(e);
      return { e, profit: maxProfit, optimalInput };
    }).filter(v=>{
      const idx = ADDRESSES.findIndex(a=>a.address===v.e.path[0]);
      if (idx<0||idx>=minProfits.length) throw new Error(`No minProfit for token at idx ${idx}`);
      return v.profit > Number(minProfits[idx]);
    }).sort((a,b)=>b.profit-a.profit).slice(0,20);

    return {
      paths: validated.map(v=>v.e.path),
      pairs: validated.map(v=>v.e.pairs),
      profits: validated.map(v=>v.profit),
      optimalAmounts: validated.map(v=>v.optimalInput),
      fees: validated.map(v=>v.e.pairs.map(p=>this.pairs.get(p)!.fee)),
    };
  }

  private getAmountOutV2(amountIn: number, reserveIn: number, reserveOut: number, fee: number): number {
    const amt = amountIn * (1 - fee/10000);
    return (amt * reserveOut)/(reserveIn + amt);
  }

  private getAmountOutV3(amountIn: number, sqrtPriceX96: bigint, liquidity: bigint, fee: number): number {
    const price = (Number(sqrtPriceX96)/2**96)**2;
    return amountIn * price * (1 - fee/10000);
  }

  private calculateMaxProfit(entry: DPEntry): { maxProfit:number; optimalInput:number } {
    const start = entry.path[0];
    const info = ADDRESSES.find(a=>a.address===start);
    if (!info) throw new Error(`Token info not found for ${start}`);
    const { calculateProfit, calculateJacobian, calculateHessian } = this.createProfitFunctions(entry.edges);
    let input = 10**info.decimal;
    let maxP=-Infinity, opt=0;
    for (let i=0;i<maxIterations;i++) {
      const p = calculateProfit(input);
      const j = calculateJacobian(input);
      const h = calculateHessian(input);
      if (h===0) break;
      const delta = j/h;
      const next = input - delta;
      if (Math.abs(next-input)<1e-8) break;
      input = Math.max(0,next);
      if (p>maxP){ maxP=p; opt=input; }
    }
    return { maxProfit: maxP, optimalInput: opt };
  }

  private createProfitFunctions(edges: (Edge|V3Edge)[]) {
    const swap = (amt:number, edge: Edge|V3Edge) => {
      if ('reserveIn' in edge) {
        return this.getAmountOutV2(amt, Number(edge.reserveIn), Number(edge.reserveOut), edge.fee);
      }
      return this.getAmountOutV3(amt, edge.sqrtPriceX96, edge.liquidity, edge.fee);
    };
    const deriv = (edge: Edge|V3Edge) => {
      const feeM = 1-edge.fee/10000;
      if ('reserveIn' in edge) {
        const rIn=Number(edge.reserveIn), rOut=Number(edge.reserveOut);
        return (feeM * rIn * rOut)/((rIn)**2);
      }
      const price = (Number(edge.sqrtPriceX96)/2**96)**2;
      return price * feeM;
    };
    const secDeriv = (edge: Edge|V3Edge) => 'reserveIn' in edge ? 0 : 0;
    const calculateProfit = (x:number) => {
      let amt = x;
      for (const e of edges) amt = swap(amt,e);
      return amt - x;
    };
    const calculateJacobian = (x:number) => edges.reduce((acc,e)=>acc*deriv(e),1) - 1;
    const calculateHessian = (x:number) => {
      let h=0;
      const d = edges.map(e=>deriv(e));
      const sd = edges.map(e=>secDeriv(e));
      for (let i=0;i<edges.length;i++) {
        let term = sd[i];
        for (let j=0;j<edges.length;j++) if(i!==j) term*=d[j];
        h+=term;
      }
      return h;
    };
    return { calculateProfit, calculateJacobian, calculateHessian };
  }

  getTokens(): Address[] { return [...this.tokens]; }
  getPairAddresses(): Address[] { return [...this.pairs.keys()]; }
  getAllPairs(): PairInfo[] { return [...this.pairs.values()]; }
  clear(): void {
    this.graph.clear(); this.tokens.clear(); this.pairs.clear(); this.edgeIndex.clear();
    this.v3Graph.clear(); this.v3EdgeIndex.clear(); this.tokenToHighestReservePair.clear();
  }
}
