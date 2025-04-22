import { maxHops, MAX_ENTRIES_PER_TOKEN, DEBUG, minProfit, maxIterations, minProfits, ADDRESSES, NERK, enableV3Pools, type PoolInfo } from './constants';
import { type Address } from 'viem';
import { V3SwapMath, type SwapDirection } from './utils/V3SwapMath';

interface Edge {
  to: Address;
  pairAddress: Address;
  direction: 'token0ToToken1' | 'token1ToToken0';
  fee: number;
  reserveIn: bigint;
  reserveOut: bigint;
}

// Native V3 edge type
interface V3Edge {
  to: Address;
  poolAddress: Address;
  direction: 'token0ToToken1' | 'token1ToToken0';
  fee: number;
  tick: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
}

// Key for edge lookup, combining source token and pair address
type EdgeKey = `${string}-${string}`;

// Key for V3 edge lookup: fromToken-poolAddress
type V3EdgeKey = `${string}-${string}`;

interface DPEntry {
  amountOut: number;
  path: Address[];
  pairs: Address[];
  directions: ('token0ToToken1' | 'token1ToToken0')[];
}

interface DPTable {
  [step: number]: Map<Address, DPEntry[]>;
}

export class ArbitrageGraph {
  private graph: Map<Address, Edge[]> = new Map();
  private tokens: Set<Address> = new Set();
  // private pairs: Map<Address, PairInfo> = new Map();
  // Secondary index for O(1) edge lookups
  private edgeIndex: Map<EdgeKey, Edge> = new Map();
  private v3Graph: Map<Address, V3Edge[]> = new Map();
  private v3EdgeIndex: Map<V3EdgeKey, V3Edge> = new Map();
  // Track highest reserve pairs for each token for instant lookup
  private tokenToHighestReservePair: Map<Address, { pairAddress: Address; reserves: bigint; fee: number }> = new Map();
  private pools = new Map<Address,PoolInfo>();

  private createEdgeKey(fromToken: Address, pairAddress: Address): EdgeKey {
    return `${fromToken}-${pairAddress}`;
  }

  private createV3EdgeKey(fromToken: Address, poolAddress: Address): V3EdgeKey {
    return `${fromToken}-${poolAddress}`;
  }

  addPair(pool: Extract<PoolInfo, { type: 'V2' }>): void {
    const [res0, res1] = [Number(pool.reserve0), Number(pool.reserve1)];
    if (res0 === 0 || res1 === 0) return;

    this.tokens.add(pool.token0);
    this.tokens.add(pool.token1);
    this.pools.set(pool.pairAddress, pool);

    this.updateGraphEdges(pool); 
  }

  // Helper function to update graph edges for a given pair
  private updateGraphEdges(pool: Extract<PoolInfo, { type: 'V2' }>): void {
    const [res0, res1] = [Number(pool.reserve0), Number(pool.reserve1)];
    if (res0 === 0 || res1 === 0) return;

    // Update highest reserve tracking for token0
    const currentBest0 = this.tokenToHighestReservePair.get(pool.token0);
    if (!currentBest0 || pool.reserve0 > currentBest0.reserves) {
      this.tokenToHighestReservePair.set(pool.token0, {
        pairAddress: pool.pairAddress,
        reserves: pool.reserve0,
        fee: pool.fee
      });
    }

    // Update highest reserve tracking for token1
    const currentBest1 = this.tokenToHighestReservePair.get(pool.token1);
    if (!currentBest1 || pool.reserve1 > currentBest1.reserves) {
      this.tokenToHighestReservePair.set(pool.token1, {
        pairAddress: pool.pairAddress,
        reserves: pool.reserve1,
        fee: pool.fee
      });
    }

    // Token0 -> Token1 edge
    const edge0Key = this.createEdgeKey(pool.token0, pool.pairAddress);
    const edge0To1 = this.edgeIndex.get(edge0Key);

    if (edge0To1) {
      // Update existing edge
      edge0To1.reserveIn = pool.reserve0;
      edge0To1.reserveOut = pool.reserve1;
      edge0To1.fee = pool.fee;
    } else {
      // Create new edge
      const newEdge: Edge = {
        to: pool.token1,
        pairAddress: pool.pairAddress,
        direction: 'token0ToToken1',
        fee: pool.fee,
        reserveIn: pool.reserve0,
        reserveOut: pool.reserve1,
      };
      
      if (!this.graph.has(pool.token0)) {
        this.graph.set(pool.token0, []);
      }
      this.graph.get(pool.token0)!.push(newEdge);
      this.edgeIndex.set(edge0Key, newEdge);
    }

    // Token1 -> Token0 edge
    const edge1Key = this.createEdgeKey(pool.token1, pool.pairAddress);
    const edge1To0 = this.edgeIndex.get(edge1Key);

    if (edge1To0) {
      // Update existing edge
      edge1To0.reserveIn = pool.reserve1;
      edge1To0.reserveOut = pool.reserve0;
      edge1To0.fee = pool.fee;
    } else {
      // Create new edge
      const newEdge: Edge = {
        to: pool.token0,
        pairAddress: pool.pairAddress,
        direction: 'token1ToToken0',
        fee: pool.fee,
        reserveIn: pool.reserve1,
        reserveOut: pool.reserve0,
      };
      
      if (!this.graph.has(pool.token1)) {
        this.graph.set(pool.token1, []);
      }
      this.graph.get(pool.token1)!.push(newEdge);
      this.edgeIndex.set(edge1Key, newEdge);
    }
  }

  // Helper function to update pair reserves without re-building the entire graph
  updatePairReserves(pairAddress: Address, reserve0: bigint, reserve1: bigint): void {
    this.updatePairReservesBatch([{ pairAddress, reserve0, reserve1 }]);
  }

  // handle batch updates 
  updatePairReservesBatch(updates: { pairAddress: Address; reserve0: bigint; reserve1: bigint }[]): void {
    const updatedPairs = new Set<Extract<PoolInfo, { type: 'V2' }>>();

    for (const update of updates) {
      const pool = this.pools.get(update.pairAddress);
      if (!pool || pool.type !== 'V2') {
        console.warn(`Pair ${update.pairAddress} not found in graph. Consider adding it first.`);
        continue;
      }

      // Update the reserves in the PoolInfo
      pool.reserve0 = update.reserve0;
      pool.reserve1 = update.reserve1;
      updatedPairs.add(pool);

      if (DEBUG) {
        console.log(`Updated reserves for pair ${update.pairAddress}: ${update.reserve0}, ${update.reserve1}`);
      }
    }

    // Update graph edges only once for all modified pairs
    for (const pool of updatedPairs) {
      this.updateGraphEdges(pool);
    }
  }

  // Add V3 pools as native V3Edges
  public addV3Pools(pools: Extract<PoolInfo, { type: 'V3' }>[]): void {
    if (!enableV3Pools) return;
    for (const pool of pools) {
      // Store V3 pool info for profit calculations
      this.pools.set(pool.poolAddress, pool);
      // forward edge
      const key01 = this.createV3EdgeKey(pool.token0, pool.poolAddress);
      if (this.v3EdgeIndex.has(key01)) {
        // update existing
        const ex = this.v3EdgeIndex.get(key01)!;
        ex.tick = pool.tick;
        ex.liquidity = pool.liquidity;
        ex.sqrtPriceX96 = pool.sqrtPriceX96;
      } else {
        const e01: V3Edge = { to: pool.token1, poolAddress: pool.poolAddress, direction: 'token0ToToken1', fee: pool.fee, tick: pool.tick, liquidity: pool.liquidity, sqrtPriceX96: pool.sqrtPriceX96 };
        this.v3EdgeIndex.set(key01, e01);
        if (!this.v3Graph.has(pool.token0)) this.v3Graph.set(pool.token0, []);
        this.v3Graph.get(pool.token0)!.push(e01);
      }

      // backward edge
      const key10 = this.createV3EdgeKey(pool.token1, pool.poolAddress);
      if (this.v3EdgeIndex.has(key10)) {
        const ex = this.v3EdgeIndex.get(key10)!;
        ex.tick = pool.tick;
        ex.liquidity = pool.liquidity;
        ex.sqrtPriceX96 = pool.sqrtPriceX96;
      } else {
        const e10: V3Edge = { to: pool.token0, poolAddress: pool.poolAddress, direction: 'token1ToToken0', fee: pool.fee, tick: pool.tick, liquidity: pool.liquidity, sqrtPriceX96: pool.sqrtPriceX96 };
        this.v3EdgeIndex.set(key10, e10);
        if (!this.v3Graph.has(pool.token1)) this.v3Graph.set(pool.token1, []);
        this.v3Graph.get(pool.token1)!.push(e10);
      }
    }
  }

  /**
   * Update V3 pools' dynamic data without rebuilding graph
   */
  public updateV3Pools(pools: Extract<PoolInfo, { type: 'V3' }>[]): void {
    if (!enableV3Pools) return;
    for (const pool of pools) {
      // Update stored V3 pool info
      this.pools.set(pool.poolAddress, pool);
      const key01 = this.createV3EdgeKey(pool.token0, pool.poolAddress);
      if (this.v3EdgeIndex.has(key01)) {
        const ex = this.v3EdgeIndex.get(key01)!;
        ex.tick = pool.tick;
        ex.liquidity = pool.liquidity;
        ex.sqrtPriceX96 = pool.sqrtPriceX96;
      }
      const key10 = this.createV3EdgeKey(pool.token1, pool.poolAddress);
      if (this.v3EdgeIndex.has(key10)) {
        const ex = this.v3EdgeIndex.get(key10)!;
        ex.tick = pool.tick;
        ex.liquidity = pool.liquidity;
        ex.sqrtPriceX96 = pool.sqrtPriceX96;
      }
    }
  }

  findMultiTokenArbitrageOpportunities(
    startTokens: Address[],
    maxDepth: number = maxHops
  ): { paths: Address[][]; pairs: Address[][]; profits: number[]; optimalAmounts: number[]; fees: number[][] } {
    // Initialize a result object with empty arrays
    const result = {
      paths: [] as Address[][],
      pairs: [] as Address[][],
      profits: [] as number[],
      optimalAmounts: [] as number[],
      fees: [] as number[][],
    };

    // Use a single DP table for all start tokens
    const dp: DPTable = {};
    const rawOpportunities: Array<{
      path: Address[];
      pairs: Address[];
      directions: ('token0ToToken1' | 'token1ToToken0')[];
    }> = [];

    // Initialize with starting tokens
    dp[0] = new Map();
    
    // Add all starting tokens to the initial step of the DP table
    for (const startToken of startTokens) {
      dp[0].set(startToken, [
        {
          amountOut: 1.0,
          path: [startToken],
          pairs: [],
          directions: [],
        },
      ]);
    }

    // Process all steps of the DP table just once
    for (let step = 1; step <= maxDepth; step++) {
      dp[step] = new Map();

      for (const [currentToken, entries] of dp[step - 1].entries()) {
        const v2Edges = this.graph.get(currentToken as Address) || [];
        const v3Edges = enableV3Pools ? this.v3Graph.get(currentToken as Address) || [] : [];
        const edges = [...v2Edges, ...v3Edges];

        for (const entry of entries) {
          for (const edge of edges) {
            // Avoid immediate loops and revisit same pair
            if (entry.pairs.includes('reserveIn' in edge ? edge.pairAddress : edge.poolAddress)) continue;

            // Calculate output using native pricing functions
            const newAmountOut = 'reserveIn' in edge
              ? this.getAmountOutV2(entry.amountOut, Number(edge.reserveIn), Number(edge.reserveOut), edge.fee)
              : this.getAmountOutV3(entry.amountOut, edge.sqrtPriceX96, edge.liquidity, edge.fee, edge.direction);

            // unify pairAddress for V2 and poolAddress for V3
            const poolId = 'reserveIn' in edge ? edge.pairAddress : edge.poolAddress;
            const newEntry: DPEntry = { amountOut: newAmountOut, path: [...entry.path, edge.to], pairs: [...entry.pairs, poolId], directions: [...entry.directions, edge.direction] };

            const targetToken = edge.to;
            if (!dp[step].has(targetToken)) {
              dp[step].set(targetToken, []);
            }

            // Keep only top entries per token
            dp[step].get(targetToken)!.push(newEntry);
            dp[step].get(targetToken)!.sort((a, b) => b.amountOut - a.amountOut);
            dp[step].get(targetToken)!.splice(MAX_ENTRIES_PER_TOKEN);

            // Check for arbitrage opportunities with all starting tokens
            if (step >= 2) {
              const originToken = entry.path[0]; // The actual starting token for this path
              
              // When NERK is false, only accept circular arbitrage back to the original token
              if (!NERK) {
                if (targetToken === originToken) {
                  rawOpportunities.push({
                    path: newEntry.path,
                    pairs: newEntry.pairs,
                    directions: newEntry.directions,
                  });
                }
              } else {
                // If NERK is true, include any arbitrage where origin and target tokens are both in the startTokens list
                if (startTokens.includes(originToken) && startTokens.includes(targetToken)) {
                  rawOpportunities.push({
                    path: newEntry.path,
                    pairs: newEntry.pairs,
                    directions: newEntry.directions,
                  });
                }
              }
            }
          }
        }
      }
    }

    // Validate opportunities with actual swap simulation
    const validated = rawOpportunities
      .map(opp => {
        const { maxProfit, optimalInput } = this.calculateMaxProfit(opp);
        return { ...opp, profit: maxProfit, optimalInput };
      })
      .filter(opp => {
        // Find the index of the starting token in ADDRESSES
        const originToken = opp.path[0];
        const tokenIndex = ADDRESSES.findIndex(addr => addr.address === originToken);
        
        // Throw an error if no specific profit threshold is defined for this token
        if (tokenIndex < 0 || tokenIndex >= minProfits.length) {
          const tokenName = tokenIndex >= 0 ? ADDRESSES[tokenIndex].name : originToken;
          throw new Error(`No minimum profit threshold defined for token ${tokenName}. Please update the minProfits array in constants.ts.`);
        }
        
        const tokenMinProfit = minProfits[tokenIndex];
        return opp.profit > Number(tokenMinProfit);
      })
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 20);

    return {
      paths: validated.map(opp => opp.path),
      pairs: validated.map(opp => opp.pairs),
      profits: validated.map(opp => opp.profit),
      optimalAmounts: validated.map(opp => opp.optimalInput),
      fees: validated.map(opp => 
        opp.pairs.map(pairAddress => {
          const pair = this.pools.get(pairAddress);
          if (!pair) throw new Error(`Missing pair info for ${pairAddress}`);
          return pair.fee;
        })
      ),
    };
  }

  private getAmountOutV2(amountIn: number, reserveIn: number, reserveOut: number, fee: number): number {
    const amtInWithFee = amountIn * (1 - fee / 10000);
    return (amtInWithFee * reserveOut) / (reserveIn + amtInWithFee);
  }

  private getAmountOutV3(amountIn: number, sqrtPriceX96: bigint, liquidity: bigint, fee: number, direction: SwapDirection): number {
    const feeAdjIn = amountIn * (1 - fee / 10000);
    const sqrtFloatBefore = V3SwapMath.sqrtPriceX96ToFloat(sqrtPriceX96);
    const sqrtFloatAfter = direction === 'token0ToToken1'
      ? sqrtFloatBefore + feeAdjIn / Number(liquidity)
      : sqrtFloatBefore - feeAdjIn / Number(liquidity);
    const afterX96 = V3SwapMath.floatToSqrtPriceX96(sqrtFloatAfter);
    const outBig = V3SwapMath.getAmountOut(direction, liquidity, sqrtPriceX96, afterX96);
    return Number(outBig);
  }

  private calculateMaxProfit(opportunity: {
    path: Address[];
    pairs: Address[];
    directions: ('token0ToToken1' | 'token1ToToken0')[];
  }): { maxProfit: number; optimalInput: number } {
    // Get starting token's decimal from ADDRESSES
    const startToken = opportunity.path[0];
    const tokenInfo = ADDRESSES.find(addr => addr.address === startToken);
    if (!tokenInfo) throw new Error(`Token info not found for ${startToken}`);
    
    // const pairsInfo = opportunity.pairs.map(pairAddress => {
    //     const pair = this.pairs.get(pairAddress);
    //     if (!pair) throw new Error(`Missing pair info for ${pairAddress}`);
    //     return pair;
    // });
    const poolInfos = opportunity.pairs.map(addr => {
      const pool = this.pools.get(addr)
      if (!pool) throw new Error(`Missing pool info for ${addr}`)
      return pool
    })

    const { calculateProfit, calculateJacobian, calculateHessian } = this.createProfitFunctions(opportunity, poolInfos);
    
    // Adjust initial guess based on token decimals
    let inputAmount = 10 ** tokenInfo.decimal; // Use token's decimal places
    const tolerance = 1e-8;
    let maxProfit = -Infinity;
    let optimalInput = 0;

    //Newton's Method
    for (let i = 0; i < maxIterations; i++) {
        const profit = calculateProfit(inputAmount);
        const jacobian = calculateJacobian(inputAmount);
        const hessian = calculateHessian(inputAmount);

        // Check if the Hessian is invertible (non-zero determinant).
        if (hessian === 0) {
            // console.warn("Hessian is zero, cannot invert.");
            break;
        }

        const delta = jacobian / hessian;
        const newInputAmount = inputAmount - delta;

        // Check for convergence
        if (Math.abs(newInputAmount - inputAmount) < tolerance) {
            break;
        }
        inputAmount = Math.max(0, newInputAmount);
        if (profit > maxProfit) {
          maxProfit = profit;
          optimalInput = inputAmount;
      }
    }

    return { maxProfit, optimalInput };
  }

  private createProfitFunctions(
    opportunity: {
      path: Address[];
      pairs: Address[];
      directions: ('token0ToToken1' | 'token1ToToken0')[];
    },
    poolInfos: PoolInfo[]
  ): {
      calculateProfit: (inputAmount: number) => number;
      calculateJacobian: (inputAmount: number) => number;
      calculateHessian: (inputAmount: number) => number;
  } {
    // Swap function (CPMM formula)
    const swap = (
      amountIn: number,
      reserveIn: number,
      reserveOut: number,
      fee: number
    ): number => {
      const feeMultiplier = 1 - fee / 10000;
      const amountInAfterFee = amountIn * feeMultiplier;
      return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
    };

      // Derivative of swap function
      const swapDerivative = (
          amountIn: number,
          reserveIn: number,
          reserveOut: number,
          fee: number
      ): number => {
          const feeMultiplier = 1 - fee / 10000;
          return (feeMultiplier * reserveIn * reserveOut) / ((reserveIn + feeMultiplier * amountIn) ** 2);
      };

       // Second derivative of swap function
       const swapSecondDerivative = (
          amountIn: number,
          reserveIn: number,
          reserveOut: number,
          fee: number
      ): number => {
          const feeMultiplier = 1 - fee / 10000;
          return (-2 * feeMultiplier ** 2 * reserveIn * reserveOut) / ((reserveIn + feeMultiplier * amountIn) ** 3);
      };

    // Profit function (supports V2 and V3)
    const calculateProfit = (inputAmount: number): number => {
      let amount = inputAmount;
      for (let i = 0; i < opportunity.pairs.length; i++) {
        const pool = poolInfos[i];
        const direction = opportunity.directions[i];
        if (pool.type === 'V2') {
          const reserveIn = direction === 'token0ToToken1'
            ? Number(pool.reserve0)
            : Number(pool.reserve1);
          const reserveOut = direction === 'token0ToToken1'
            ? Number(pool.reserve1)
            : Number(pool.reserve0);
          if (amount > reserveIn) return -Infinity;
          amount = swap(amount, reserveIn, reserveOut, pool.fee);
        } else {
          // V3 concentrated liquidity swap via V3SwapMath
          const feeAdjIn = amount * (1 - pool.fee / 10000);
          const sqrtFloatBefore = V3SwapMath.sqrtPriceX96ToFloat(pool.sqrtPriceX96);
          const sqrtFloatAfter = direction === 'token0ToToken1'
            ? sqrtFloatBefore + feeAdjIn / Number(pool.liquidity)
            : sqrtFloatBefore - feeAdjIn / Number(pool.liquidity);
          const afterX96 = V3SwapMath.floatToSqrtPriceX96(sqrtFloatAfter);
          const outBig = V3SwapMath.getAmountOut(direction as SwapDirection, pool.liquidity, pool.sqrtPriceX96, afterX96);
          amount = Number(outBig);
        }
      }
      return amount - inputAmount;
    };

      // First derivative (supports V2 and V3)
      const calculateJacobian = (inputAmount: number): number => {
        let derivative = 1;
        let amount = inputAmount;
        for (let i = 0; i < opportunity.pairs.length; i++) {
          const pool = poolInfos[i];
          const direction = opportunity.directions[i];
          if (pool.type === 'V2') {
            const reserveIn = direction === 'token0ToToken1'
              ? Number(pool.reserve0)
              : Number(pool.reserve1);
            const reserveOut = direction === 'token0ToToken1'
              ? Number(pool.reserve1)
              : Number(pool.reserve0);
            if (amount > reserveIn) return 0;
            derivative *= swapDerivative(amount, reserveIn, reserveOut, pool.fee);
            amount = swap(amount, reserveIn, reserveOut, pool.fee);
          } else {
            // V3 first derivative via V3SwapMath
            const feeAdjIn = amount * (1 - pool.fee / 10000);
            const sqrtFloatBefore = V3SwapMath.sqrtPriceX96ToFloat(pool.sqrtPriceX96);
            const sqrtFloatAfter = direction === 'token0ToToken1'
              ? sqrtFloatBefore + feeAdjIn / Number(pool.liquidity)
              : sqrtFloatBefore - feeAdjIn / Number(pool.liquidity);
            const afterX96 = V3SwapMath.floatToSqrtPriceX96(sqrtFloatAfter);
            const deriv = V3SwapMath.getAmountOutFirstDerivative(
              direction as SwapDirection,
              pool.liquidity,
              pool.sqrtPriceX96,
              afterX96,
              pool.fee
            );
            derivative *= deriv;
            amount = Number(
              V3SwapMath.getAmountOut(
                direction as SwapDirection,
                pool.liquidity,
                pool.sqrtPriceX96,
                afterX96
              )
            );
          }
        }
        return derivative - 1;
      };

      // Second derivative (supports V2 and V3)
      const calculateHessian = (inputAmount: number): number => {
        let hessian = 0;
        let amount = inputAmount;
        const derivs: number[] = [];
        const secondDerivs: number[] = [];
        for (let i = 0; i < opportunity.pairs.length; i++) {
          const pool = poolInfos[i];
          const direction = opportunity.directions[i];
          if (pool.type === 'V2') {
            const reserveIn = direction === 'token0ToToken1'
              ? Number(pool.reserve0)
              : Number(pool.reserve1);
            const reserveOut = direction === 'token0ToToken1'
              ? Number(pool.reserve1)
              : Number(pool.reserve0);
            derivs[i] = swapDerivative(amount, reserveIn, reserveOut, pool.fee);
            secondDerivs[i] = swapSecondDerivative(amount, reserveIn, reserveOut, pool.fee);
            amount = swap(amount, reserveIn, reserveOut, pool.fee);
          } else {
            // V3 swap derivatives via V3SwapMath
            const feeAdjInH = amount * (1 - pool.fee / 10000);
            const sqrtFloatBeforeH = V3SwapMath.sqrtPriceX96ToFloat(pool.sqrtPriceX96);
            const sqrtFloatAfterH = direction === 'token0ToToken1'
              ? sqrtFloatBeforeH + feeAdjInH / Number(pool.liquidity)
              : sqrtFloatBeforeH - feeAdjInH / Number(pool.liquidity);
            const afterX96H = V3SwapMath.floatToSqrtPriceX96(sqrtFloatAfterH);
            derivs[i] = V3SwapMath.getAmountOutFirstDerivative(
              direction as SwapDirection,
              pool.liquidity,
              pool.sqrtPriceX96,
              afterX96H,
              pool.fee
            );
            secondDerivs[i] = V3SwapMath.getAmountOutSecondDerivative(
              direction as SwapDirection,
              pool.liquidity,
              afterX96H,
              pool.fee
            );
            amount = Number(
              V3SwapMath.getAmountOut(
                direction as SwapDirection,
                pool.liquidity,
                pool.sqrtPriceX96,
                afterX96H
              )
            );
          }
        }
        for (let i = 0; i < opportunity.pairs.length; i++) {
          let term = secondDerivs[i] || 0;
          for (let j = 0; j < opportunity.pairs.length; j++) {
            if (i !== j) term *= derivs[j];
          }
          hessian += term;
        }
        return hessian;
      };

    return { calculateProfit, calculateJacobian, calculateHessian };
  }

  /**
   * Import and add V3 pools into the graph as synthetic pairs
   */

  // Fast lookup for pair with highest reserves
  findBestPairForToken(
    token: Address,
    amountIn: bigint,
    excludePairs: Address[] = []
  ): { pairAddress: Address; fee: number } | null {
    const bestPair = this.tokenToHighestReservePair.get(token);
    if (!bestPair) return null;

    // Check if pair is excluded
    if (excludePairs.includes(bestPair.pairAddress)) return null;

    // Check if reserves are sufficient (3x amountIn)
    if (bestPair.reserves < amountIn * BigInt(3)) return null;

    return {
      pairAddress: bestPair.pairAddress,
      fee: bestPair.fee
    };
  }

  getTokens(): Address[] {
    return Array.from(this.tokens);
  }

  // Get all pair addresses in the graph
  getPairAddresses(): Address[] {
    return Array.from(this.pools.keys());
  }

  // Get all pairs with their info
  getAllPairs(): PoolInfo[] {
    return Array.from(this.pools.values());
  }

  clear(): void {
    this.tokens.clear();
    this.pools.clear();
    this.edgeIndex.clear();
    this.v3Graph.clear();
    this.v3EdgeIndex.clear();
    this.tokenToHighestReservePair.clear();
  }
}

