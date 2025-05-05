import { maxHops, MAX_ENTRIES_PER_TOKEN, DEBUG, minProfit, maxIterations, minProfits, ADDRESSES, NERK } from './constants';
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
  amountOut: bigint;
  path: Address[];
  pairs: Address[];
  directions: ('token0ToToken1' | 'token1ToToken0')[];
}

interface DPTable {
  [step: number]: Map<Address, DPEntry[]>;
}

// Helper function for bigint swap calculations
function bigintSwap(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  fee: number
): bigint {
  // Convert fee to bigint basis points (10000 = 100%)
  const feeMultiplier = BigInt(10000 - fee);
  // Calculate amount after fee with precision (multiply first, then divide)
  const amountInAfterFee = (amountIn * feeMultiplier) / BigInt(10000);
  // Calculate output amount using CPMM formula with bigint
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
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
    // Keep as bigint instead of converting to number
    const [res0, res1] = [pair.reserve0, pair.reserve1];
    if (res0 === 0n || res1 === 0n) return;

    this.tokens.add(pair.token0);
    this.tokens.add(pair.token1);
    this.pairs.set(pair.pairAddress, pair);

    this.updateGraphEdges(pair); 
  }

  // Helper function to update graph edges for a given pair
  private updateGraphEdges(pair: PairInfo): void {
    const [res0, res1] = [BigInt(pair.reserve0), BigInt(pair.reserve1)];
    if (res0 === 0n || res1 === 0n) return;

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



  findMultiTokenArbitrageOpportunities(
    startTokens: Address[],
    maxDepth: number = maxHops
  ): { paths: Address[][]; pairs: Address[][]; profits: bigint[]; optimalAmounts: bigint[]; fees: number[][] } {
    // Initialize a result object with empty arrays
    const result = {
      paths: [] as Address[][],
      pairs: [] as Address[][],
      profits: [] as bigint[],
      optimalAmounts: [] as bigint[],
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
          amountOut: 1n,
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
        const edges = this.graph.get(currentToken as Address) || [];

        for (const entry of entries) {
          for (const edge of edges) {
            // Avoid immediate loops and revisit same pair
            if (entry.pairs.includes(edge.pairAddress)) continue;

            // Calculate output using actual swap formula with bigint
            const newAmountOut = bigintSwap(
              entry.amountOut,
              edge.reserveIn,
              edge.reserveOut,
              edge.fee
            );

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
            // Sort using bigint comparison
            dp[step].get(targetToken)!.sort((a, b) => {
              if (b.amountOut > a.amountOut) return 1;
              if (b.amountOut < a.amountOut) return -1;
              return 0;
            });
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
        // Convert tokenMinProfit to bigint for comparison
        return opp.profit > BigInt(tokenMinProfit);
      })
      .sort((a, b) => {
        if (b.profit > a.profit) return 1;
        if (b.profit < a.profit) return -1;
        return 0;
      })
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
  }): { maxProfit: bigint; optimalInput: bigint } {
    const startToken = opportunity.path[0];
    const tokenInfo = ADDRESSES.find(addr => addr.address === startToken);
    if (!tokenInfo) throw new Error(`Token info not found for ${startToken}`);
    
    const pairsInfo = opportunity.pairs.map(pairAddress => {
      const pair = this.pairs.get(pairAddress);
      if (!pair) throw new Error(`Missing pair info for ${pairAddress}`);
      return pair;
    });
  
    const { calculateProfit, calculateJacobian, calculateHessian } = 
      this.createProfitFunctions(opportunity, pairsInfo);
    
    // Initialize with reasonable starting amount considering decimals
    const decimalFactor = 10n ** BigInt(tokenInfo.decimal);
    let currentInput = decimalFactor; // Start with 1 unit of token
    let maxProfit = -1n;
    let optimalInput = 0n;
  
    // Newton's Method with enhanced convergence checks
    for (let i = 0; i < maxIterations; i++) {
      const profit = calculateProfit(currentInput);
      const jacobian = calculateJacobian(currentInput);
      const hessian = calculateHessian(currentInput);
  
      // Track best solution found (regardless of convergence)
      if (profit > maxProfit && currentInput > 0n) {
        maxProfit = profit;
        optimalInput = currentInput;
      }
  
      // 1. Primary Convergence Check (Jacobian zero)
      if (jacobian === 0n) {
        // if (DEBUG) console.log(`Converged: Zero gradient at iteration ${i}`);
        break;
      }
  
      // 2. Handle Zero Hessian (undefined curvature)
      if (hessian === 0n) {
        // Fall back to gradient-based adjustment
        const stepSize = currentInput / 100n; // 1% of current value
        currentInput = jacobian > 0n 
          ? currentInput + stepSize // Move upward if gradient positive
          : currentInput - stepSize; // Move downward if gradient negative
        continue;
      }
  
      // Normal Newton-Raphson step
      const delta = jacobian / hessian;
      const newInput = currentInput - delta;
  
      // 3. Secondary Convergence Check (Minimal movement)
      const absDelta = delta > 0n ? delta : -delta;
      if (absDelta < (currentInput / 10000n)) { // 0.01% relative change
        if (DEBUG) console.log(`Converged: Minimal change at iteration ${i}`);
        break;
      }
  
      // Apply bounds protection
      const maxBound = decimalFactor * 1000n; // 1000 tokens max
      const minBound = decimalFactor / 1000n; // 0.001 tokens min
      currentInput = newInput > maxBound ? maxBound :
                    newInput < minBound ? minBound :
                    newInput;
    }
  
    return { 
      maxProfit: maxProfit > 0n ? maxProfit : 0n,
      optimalInput 
    };
  }

  private createProfitFunctions(
    opportunity: {
      path: Address[];
      pairs: Address[];
      directions: ('token0ToToken1' | 'token1ToToken0')[];
    },
    pairsInfo: PairInfo[]
  ): {
      calculateProfit: (inputAmount: bigint) => bigint;
      calculateJacobian: (inputAmount: bigint) => bigint;
      calculateHessian: (inputAmount: bigint) => bigint;
  } {
    // Swap function (CPMM formula) using bigint
    const swap = (
      amountIn: bigint,
      reserveIn: bigint,
      reserveOut: bigint,
      fee: number
    ): bigint => {
      // Convert fee to bigint basis points (10000 = 100%)
      const feeMultiplier = BigInt(10000 - fee);
      // Calculate amount after fee with precision (multiply first, then divide)
      const amountInAfterFee = (amountIn * feeMultiplier) / BigInt(10000);
      // Calculate output amount using CPMM formula with bigint
      return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
    };

      // Derivative of swap function using bigint
    const swapDerivative = (
      amountIn: bigint,
      reserveIn: bigint,
      reserveOut: bigint,
      fee: number
    ): bigint => {
      const feeMultiplier = BigInt(10000 - fee);
      const numerator = feeMultiplier * reserveIn * reserveOut * BigInt(10000);
      const denominator = (reserveIn * BigInt(10000) + feeMultiplier * amountIn) ** BigInt(2);
      return numerator / denominator;
    };

    // Second derivative of swap function using bigint
    const swapSecondDerivative = (
      amountIn: bigint,
      reserveIn: bigint,
      reserveOut: bigint,
      fee: number
    ): bigint => {
      const feeMultiplier = BigInt(10000 - fee);
      const numerator = BigInt(-2) * feeMultiplier ** BigInt(2) * reserveIn * reserveOut * BigInt(10000) ** BigInt(2);
      const denominator = (reserveIn * BigInt(10000) + feeMultiplier * amountIn) ** BigInt(3);
      return numerator / denominator;
    };

    // Calculate profit for the entire arbitrage loop using bigint
    const calculateProfit = (inputAmount: bigint): bigint => {
      try {
        let amount = inputAmount;
        for (let i = 0; i < opportunity.pairs.length; i++) {
          const pair = pairsInfo[i];
          const direction = opportunity.directions[i];
          
          let reserveIn, reserveOut;
          if (direction === 'token0ToToken1') {
            reserveIn = pair.reserve0;
            reserveOut = pair.reserve1;
          } else {
            reserveIn = pair.reserve1;
            reserveOut = pair.reserve0;
          }
          
          // Check if input exceeds reserves
          if (amount > reserveIn) {
            return -1n; // Use -1n instead of -Infinity for bigint
          }

          amount = swap(amount, reserveIn, reserveOut, pair.fee);
        }
        return amount - inputAmount; // our profit
      } catch {
        return -1n; // Use -1n instead of -Infinity for bigint
      }
    };

      // Calculate Jacobian of the profit function (first derivative)
      const calculateJacobian = (inputAmount: bigint): bigint => {
          let derivative = 1n; // Start with 1.0 (derivative of input)

          let amount = inputAmount;

          for (let i = 0; i < opportunity.pairs.length; i++) {
              const pair = pairsInfo[i];
              const direction = opportunity.directions[i];

              let reserveIn, reserveOut;
              if (direction === 'token0ToToken1') {
                  reserveIn = pair.reserve0;
                  reserveOut = pair.reserve1;
              } else {
                  reserveIn = pair.reserve1;
                  reserveOut = pair.reserve0;
              }
              
              if (amount > reserveIn) {
                  return 0n; // Infeasible
              }
              derivative *= swapDerivative(amount, reserveIn, reserveOut, pair.fee);
              amount = swap(amount, reserveIn, reserveOut, pair.fee);
          }
          return derivative - 1n; // Subtract 1 (derivative of initial input amount)
      };

      // Calculate Hessian of the profit function (second derivative)
      const calculateHessian = (inputAmount: bigint): bigint => {
          let hessian = 0n;
          let amount = inputAmount;

          // First derivative for each swap
          const swapDerivatives = pairsInfo.map((pair, i) => {
              const direction = opportunity.directions[i];
              let reserveIn, reserveOut;
              if (direction === 'token0ToToken1') {
                  reserveIn = pair.reserve0;
                  reserveOut = pair.reserve1;
              } else {
                  reserveIn = pair.reserve1;
                  reserveOut = pair.reserve0;
              }
              return swapDerivative(amount, reserveIn, reserveOut, pair.fee);
          });

          // Second derivative for each swap
          const swapSecondDerivatives = pairsInfo.map((pair, i) => {
              const direction = opportunity.directions[i];
              let reserveIn, reserveOut;
              if (direction === 'token0ToToken1') {
                  reserveIn = pair.reserve0;
                  reserveOut = pair.reserve1;
              } else {
                  reserveIn = pair.reserve1;
                  reserveOut = pair.reserve0;
              }
              return swapSecondDerivative(amount, reserveIn, reserveOut, pair.fee);
          });
          for (let i = 0; i < opportunity.pairs.length; i++) {
              const pair = pairsInfo[i];
              const direction = opportunity.directions[i];

              let reserveIn, reserveOut;
              if (direction === 'token0ToToken1') {
                  reserveIn = pair.reserve0;
                  reserveOut = pair.reserve1;
              } else {
                  reserveIn = pair.reserve1;
                  reserveOut = pair.reserve0;
              }
              if (amount > reserveIn) {
                 return 0n;  // Or handle infeasibility differently
                }
              let term = swapSecondDerivatives[i];
              for (let j = 0; j < opportunity.pairs.length; j++) {
                if (i !== j) {
                  // Ensure proper bigint multiplication
                  term = term * swapDerivatives[j];
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
