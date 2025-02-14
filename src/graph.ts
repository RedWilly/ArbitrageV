import { maxHops, MAX_ENTRIES_PER_TOKEN, DEBUG, minProfit, ADDRESSES, NERK } from './constants';
import { type Address } from 'viem';

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

// Key for edge lookup, combining source token and pair address
type EdgeKey = `${string}-${string}`;

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
  private pairs: Map<Address, PairInfo> = new Map();
  // Secondary index for O(1) edge lookups
  private edgeIndex: Map<EdgeKey, Edge> = new Map();
  // Track highest reserve pairs for each token for instant lookup
  private tokenToHighestReservePair: Map<Address, { pairAddress: Address; reserves: bigint; fee: number }> = new Map();

  private createEdgeKey(fromToken: Address, pairAddress: Address): EdgeKey {
    return `${fromToken}-${pairAddress}`;
  }

  addPair(pair: PairInfo): void {
    const [res0, res1] = [Number(pair.reserve0), Number(pair.reserve1)];
    if (res0 === 0 || res1 === 0) return;

    this.tokens.add(pair.token0);
    this.tokens.add(pair.token1);
    this.pairs.set(pair.pairAddress, pair);

    this.updateGraphEdges(pair); 
  }

  // Helper function to update graph edges for a given pair
  private updateGraphEdges(pair: PairInfo): void {
    const [res0, res1] = [Number(pair.reserve0), Number(pair.reserve1)];
    if (res0 === 0 || res1 === 0) return;

    // Update highest reserve tracking for token0
    const currentBest0 = this.tokenToHighestReservePair.get(pair.token0);
    if (!currentBest0 || pair.reserve0 > currentBest0.reserves) {
      this.tokenToHighestReservePair.set(pair.token0, {
        pairAddress: pair.pairAddress,
        reserves: pair.reserve0,
        fee: pair.fee
      });
    }

    // Update highest reserve tracking for token1
    const currentBest1 = this.tokenToHighestReservePair.get(pair.token1);
    if (!currentBest1 || pair.reserve1 > currentBest1.reserves) {
      this.tokenToHighestReservePair.set(pair.token1, {
        pairAddress: pair.pairAddress,
        reserves: pair.reserve1,
        fee: pair.fee
      });
    }

    // Token0 -> Token1 edge
    const edge0Key = this.createEdgeKey(pair.token0, pair.pairAddress);
    const edge0To1 = this.edgeIndex.get(edge0Key);

    if (edge0To1) {
      // Update existing edge
      edge0To1.reserveIn = pair.reserve0;
      edge0To1.reserveOut = pair.reserve1;
      edge0To1.fee = pair.fee;
    } else {
      // Create new edge
      const newEdge: Edge = {
        to: pair.token1,
        pairAddress: pair.pairAddress,
        direction: 'token0ToToken1',
        fee: pair.fee,
        reserveIn: pair.reserve0,
        reserveOut: pair.reserve1,
      };
      
      if (!this.graph.has(pair.token0)) {
        this.graph.set(pair.token0, []);
      }
      this.graph.get(pair.token0)!.push(newEdge);
      this.edgeIndex.set(edge0Key, newEdge);
    }

    // Token1 -> Token0 edge
    const edge1Key = this.createEdgeKey(pair.token1, pair.pairAddress);
    const edge1To0 = this.edgeIndex.get(edge1Key);

    if (edge1To0) {
      // Update existing edge
      edge1To0.reserveIn = pair.reserve1;
      edge1To0.reserveOut = pair.reserve0;
      edge1To0.fee = pair.fee;
    } else {
      // Create new edge
      const newEdge: Edge = {
        to: pair.token0,
        pairAddress: pair.pairAddress,
        direction: 'token1ToToken0',
        fee: pair.fee,
        reserveIn: pair.reserve1,
        reserveOut: pair.reserve0,
      };
      
      if (!this.graph.has(pair.token1)) {
        this.graph.set(pair.token1, []);
      }
      this.graph.get(pair.token1)!.push(newEdge);
      this.edgeIndex.set(edge1Key, newEdge);
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

  findArbitrageOpportunities(
    startToken: Address,
    maxDepth: number = maxHops
  ): { paths: Address[][]; pairs: Address[][]; profits: number[]; optimalAmounts: number[]; fees: number[][] } {
    const dp: DPTable = {};
    const rawOpportunities: Array<{
      path: Address[];
      pairs: Address[];
      directions: ('token0ToToken1' | 'token1ToToken0')[];
    }> = [];

    // Initialize with starting token
    dp[0] = new Map();
    dp[0].set(startToken, [
      {
        amountOut: 1.0,
        path: [startToken],
        pairs: [],
        directions: [],
      },
    ]);

    for (let step = 1; step <= maxDepth; step++) {
      dp[step] = new Map();

      for (const [currentToken, entries] of dp[step - 1].entries()) {
        const edges = this.graph.get(currentToken as Address) || [];

        for (const entry of entries) {
          for (const edge of edges) {
            // Avoid immediate loops and revisit same pair
            if (entry.pairs.includes(edge.pairAddress)) continue;

            // Calculate output using actual swap formula
            const feeMultiplier = 1 - edge.fee / 10000;
            const amountInAfterFee = entry.amountOut * feeMultiplier;
            const newAmountOut =
              (amountInAfterFee * Number(edge.reserveOut)) /
              (Number(edge.reserveIn) + amountInAfterFee);

            const newEntry: DPEntry = {
              amountOut: newAmountOut,
              path: [...entry.path, edge.to],
              pairs: [...entry.pairs, edge.pairAddress],
              directions: [...entry.directions, edge.direction],
            };

            const targetToken = edge.to;
            if (!dp[step].has(targetToken)) {
              dp[step].set(targetToken, []);
            }

            // Keep only top entries per token
            dp[step].get(targetToken)!.push(newEntry);
            dp[step].get(targetToken)!.sort((a, b) => b.amountOut - a.amountOut);
            dp[step].get(targetToken)!.splice(MAX_ENTRIES_PER_TOKEN);

            // Record opportunities:
            // 1. Always check for circular arbitrage (startToken to startToken)
            // 2. If NERK is true:
            //    a. Check direct arbitrage (startToken to NERK token)
            //    b. Check reverse arbitrage (NERK token to startToken)
            //    c. Check NERK circular arbitrage (NERK token to NERK token)
            if (step >= 2) {
            //if (targetToken === startToken || (NERK && targetToken === ADDRESSES[1].address)) {
              if (targetToken === startToken) {
                // Case 1: Circular arbitrage
                rawOpportunities.push({
                  path: newEntry.path,
                  pairs: newEntry.pairs,
                  directions: newEntry.directions,
                });
              // New cases start here - codestamp
              } else if (NERK) {
                const nerkToken = ADDRESSES[1].address;
                if (
                  // Case 2a: Direct arbitrage (startToken to NERK)
                  (startToken !== nerkToken && targetToken === nerkToken) ||
                  // Case 2b: Reverse arbitrage (NERK to startToken)
                  (startToken === nerkToken && targetToken !== nerkToken) ||
                  // Case 2c: NERK circular arbitrage (NERK to NERK)
                  (startToken === nerkToken && targetToken === nerkToken)
                ) {
                  rawOpportunities.push({
                    path: newEntry.path,
                    pairs: newEntry.pairs,
                    directions: newEntry.directions,
                  });
                }
                // End of new cases - codestamp
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
      .filter(opp => opp.profit > Number(minProfit))  // Filter based on minProfit threshold
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 20);

    return {
      paths: validated.map(opp => opp.path),
      pairs: validated.map(opp => opp.pairs),
      profits: validated.map(opp => opp.profit),
      optimalAmounts: validated.map(opp => opp.optimalInput),
      fees: validated.map(opp => 
        opp.pairs.map(pairAddress => {
          const pair = this.pairs.get(pairAddress);
          if (!pair) throw new Error(`Missing pair info for ${pairAddress}`);
          return pair.fee;
        })
      ),
    };
  }

  private calculateMaxProfit(opportunity: {
    path: Address[];
    pairs: Address[];
    directions: ('token0ToToken1' | 'token1ToToken0')[];
  }): { maxProfit: number; optimalInput: number } {
      const pairsInfo = opportunity.pairs.map(pairAddress => {
          const pair = this.pairs.get(pairAddress);
          if (!pair) throw new Error(`Missing pair info for ${pairAddress}`);
          return pair;
      });

      //const { calculateProfit, calculateJacobian } = this.createProfitFunctions(opportunity, pairsInfo);
      const { calculateProfit, calculateJacobian, calculateHessian } = this.createProfitFunctions(opportunity, pairsInfo);
    //Newton's Method
    let inputAmount = 9e18; // Initial guess (1 ether)
    const tolerance = 1e-8;
    const maxIterations = 100;

    let maxProfit = -Infinity;
    let optimalInput = 0;

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
    pairsInfo: PairInfo[]
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

    // Calculate profit for the entire arbitrage loop
    const calculateProfit = (inputAmount: number): number => {
      try {
        let amount = inputAmount;
        for (let i = 0; i < opportunity.pairs.length; i++) {
          const pair = pairsInfo[i];
          const direction = opportunity.directions[i];
          
          let reserveIn, reserveOut;
          if (direction === 'token0ToToken1') {
            reserveIn = Number(pair.reserve0);
            reserveOut = Number(pair.reserve1);
          } else {
            reserveIn = Number(pair.reserve1);
            reserveOut = Number(pair.reserve0);
          }

          // Check if input exceeds reserves
          if (amount > reserveIn) {
            return -Infinity;
          }

          amount = swap(amount, reserveIn, reserveOut, pair.fee);
        }
        return amount - inputAmount; // our profit
      } catch {
        return -Infinity;
      }
    };

      // Calculate Jacobian of the profit function (first derivative)
      const calculateJacobian = (inputAmount: number): number => {
          let derivative = 1.0; // Start with 1.0 (derivative of input)

          let amount = inputAmount;

          for (let i = 0; i < opportunity.pairs.length; i++) {
              const pair = pairsInfo[i];
              const direction = opportunity.directions[i];

              let reserveIn, reserveOut;
              if (direction === 'token0ToToken1') {
                  reserveIn = Number(pair.reserve0);
                  reserveOut = Number(pair.reserve1);
              } else {
                  reserveIn = Number(pair.reserve1);
                  reserveOut = Number(pair.reserve0);
              }
               if (amount > reserveIn) {
                  return 0; // Infeasible
              }
              derivative *= swapDerivative(amount, reserveIn, reserveOut, pair.fee);
              amount = swap(amount, reserveIn, reserveOut, pair.fee);
          }
          return derivative - 1; // Subtract 1 (derivative of initial input amount)
      };

      // Calculate Hessian of the profit function (second derivative)
      const calculateHessian = (inputAmount: number): number => {
          let hessian = 0;
          let amount = inputAmount;

          // First derivative for each swap
          const swapDerivatives = pairsInfo.map((pair, i) => {
              const direction = opportunity.directions[i];
              let reserveIn, reserveOut;
              if (direction === 'token0ToToken1') {
                  reserveIn = Number(pair.reserve0);
                  reserveOut = Number(pair.reserve1);
              } else {
                  reserveIn = Number(pair.reserve1);
                  reserveOut = Number(pair.reserve0);
              }
              return swapDerivative(amount, reserveIn, reserveOut, pair.fee);
          });

          // Second derivative for each swap
          const swapSecondDerivatives = pairsInfo.map((pair, i) => {
              const direction = opportunity.directions[i];
              let reserveIn, reserveOut;
              if (direction === 'token0ToToken1') {
                  reserveIn = Number(pair.reserve0);
                  reserveOut = Number(pair.reserve1);
              } else {
                  reserveIn = Number(pair.reserve1);
                  reserveOut = Number(pair.reserve0);
              }
              return swapSecondDerivative(amount, reserveIn, reserveOut, pair.fee);
          });
          for (let i = 0; i < opportunity.pairs.length; i++) {
              const pair = pairsInfo[i];
              const direction = opportunity.directions[i];

              let reserveIn, reserveOut;
              if (direction === 'token0ToToken1') {
                  reserveIn = Number(pair.reserve0);
                  reserveOut = Number(pair.reserve1);
              } else {
                  reserveIn = Number(pair.reserve1);
                  reserveOut = Number(pair.reserve0);
              }
               if (amount > reserveIn) {
                 return 0;  // Or handle infeasibility differently
                }
              let term = swapSecondDerivatives[i];
              for (let j = 0; j < opportunity.pairs.length; j++) {
                if (i !== j) {
                  term *= swapDerivatives[j]
                }
              }
              hessian += term
               amount = swap(amount, reserveIn, reserveOut, pair.fee);

          }
           return hessian;
      };

    return { calculateProfit, calculateJacobian, calculateHessian };
  }

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
    return Array.from(this.pairs.keys());
  }

  // Get all pairs with their info
  getAllPairs(): PairInfo[] {
    return Array.from(this.pairs.values());
  }

  clear(): void {
    this.graph.clear();
    this.tokens.clear();
    this.pairs.clear();
    this.tokenToHighestReservePair.clear();
    this.edgeIndex.clear();
  }
}