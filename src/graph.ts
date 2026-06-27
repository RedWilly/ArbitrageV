import { maxHops, MAX_ENTRIES_PER_TOKEN, DEBUG, minProfits, ADDRESSES, NERK } from './constants';
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
  rateNumerator: bigint;
  rateDenominator: bigint;
  path: Address[];
  pairs: Address[];
  directions: ('token0ToToken1' | 'token1ToToken0')[];
}

interface DPTable {
  [step: number]: Map<Address, DPEntry[]>;
}

const FEE_DENOMINATOR = 10000n;
const OPTIMIZATION_ITERATIONS = 160;
const MAX_INPUT_RESERVE_FRACTION = 3n;

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
  const amountInAfterFee = (amountIn * feeMultiplier) / FEE_DENOMINATOR;
  // Calculate output amount using CPMM formula with bigint
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
}

function compareRates(
  aNumerator: bigint,
  aDenominator: bigint,
  bNumerator: bigint,
  bDenominator: bigint
): number {
  const left = aNumerator * bDenominator;
  const right = bNumerator * aDenominator;
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
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
    const dp: DPTable = {};
    const rawOpportunities: Array<{
      path: Address[];
      pairs: Address[];
      directions: ('token0ToToken1' | 'token1ToToken0')[];
    }> = [];

    dp[0] = new Map();
    for (const startToken of startTokens) {
      dp[0].set(startToken, [
        {
          rateNumerator: 1n,
          rateDenominator: 1n,
          path: [startToken],
          pairs: [],
          directions: [],
        },
      ]);
    }

    for (let step = 1; step <= maxDepth; step++) {
      dp[step] = new Map();

      for (const [currentToken, entries] of dp[step - 1].entries()) {
        const edges = this.graph.get(currentToken as Address) || [];

        for (const entry of entries) {
          for (const edge of edges) {
            if (entry.pairs.includes(edge.pairAddress)) continue;

            const feeMultiplier = BigInt(10000 - edge.fee);
            const newEntry: DPEntry = {
              rateNumerator: entry.rateNumerator * edge.reserveOut * feeMultiplier,
              rateDenominator: entry.rateDenominator * edge.reserveIn * FEE_DENOMINATOR,
              path: [...entry.path, edge.to],
              pairs: [...entry.pairs, edge.pairAddress],
              directions: [...entry.directions, edge.direction],
            };

            const targetToken = edge.to;
            if (!dp[step].has(targetToken)) {
              dp[step].set(targetToken, []);
            }

            dp[step].get(targetToken)!.push(newEntry);
            dp[step].get(targetToken)!.sort((a, b) => {
              return compareRates(
                b.rateNumerator,
                b.rateDenominator,
                a.rateNumerator,
                a.rateDenominator
              );
            });
            dp[step].get(targetToken)!.splice(MAX_ENTRIES_PER_TOKEN);

            if (step < 2 || !this.hasProfitableRate(newEntry)) continue;

            const originToken = entry.path[0];
            const isAcceptedEndpoint = !NERK
              ? targetToken === originToken
              : startTokens.includes(originToken) && startTokens.includes(targetToken);

            if (isAcceptedEndpoint) {
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

    const validated = rawOpportunities
      .map(opp => {
        const { maxProfit, optimalInput } = this.calculateMaxProfit(opp);
        return { ...opp, profit: maxProfit, optimalInput };
      })
      .filter(opp => {
        const originToken = opp.path[0];
        const tokenIndex = ADDRESSES.findIndex(addr => addr.address === originToken);

        if (tokenIndex < 0 || tokenIndex >= minProfits.length) {
          const tokenName = tokenIndex >= 0 ? ADDRESSES[tokenIndex].name : originToken;
          throw new Error(`No minimum profit threshold defined for token ${tokenName}. Please update the minProfits array in constants.ts.`);
        }

        return opp.profit > BigInt(minProfits[tokenIndex]);
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
    const pairsInfo = opportunity.pairs.map(pairAddress => {
      const pair = this.pairs.get(pairAddress);
      if (!pair) throw new Error(`Missing pair info for ${pairAddress}`);
      return pair;
    });

    const calculateProfit = (inputAmount: bigint): bigint => {
      try {
        let amount = inputAmount;
        for (let i = 0; i < opportunity.pairs.length; i++) {
          const pair = pairsInfo[i];
          const direction = opportunity.directions[i];
          const reserveIn = direction === 'token0ToToken1' ? pair.reserve0 : pair.reserve1;
          const reserveOut = direction === 'token0ToToken1' ? pair.reserve1 : pair.reserve0;

          if (amount <= 0n || amount >= reserveIn) {
            return -1n;
          }

          amount = bigintSwap(amount, reserveIn, reserveOut, pair.fee);
        }

        return amount - inputAmount;
      } catch {
        return -1n;
      }
    };

    let low = 1n;
    let high = this.getMaxInputBound(opportunity, pairsInfo);

    if (high <= low) {
      return { maxProfit: 0n, optimalInput: 0n };
    }

    for (let i = 0; i < OPTIMIZATION_ITERATIONS && high - low > 3n; i++) {
      const third = (high - low) / 3n;
      if (third === 0n) break;

      const mid1 = low + third;
      const mid2 = high - third;
      const profit1 = calculateProfit(mid1);
      const profit2 = calculateProfit(mid2);

      if (profit1 < profit2) {
        low = mid1 + 1n;
      } else {
        high = mid2 - 1n;
      }
    }

    const finalCandidates = new Set<bigint>([low, high, (low + high) / 2n]);
    for (let offset = 1n; offset <= 5n; offset++) {
      const center = (low + high) / 2n;
      if (center > offset) finalCandidates.add(center - offset);
      finalCandidates.add(center + offset);
    }

    let maxProfit = 0n;
    let optimalInput = 0n;
    for (const input of finalCandidates) {
      if (input < low || input > high) continue;
      const profit = calculateProfit(input);
      if (profit > maxProfit) {
        maxProfit = profit;
        optimalInput = input;
      }
    }

    return { maxProfit, optimalInput };
  }

  private hasProfitableRate(entry: DPEntry): boolean {
    return entry.rateNumerator > entry.rateDenominator;
  }

  private getMaxInputBound(
    opportunity: {
      pairs: Address[];
      directions: ('token0ToToken1' | 'token1ToToken0')[];
    },
    pairsInfo: PairInfo[]
  ): bigint {
    let bound: bigint | null = null;

    for (let i = 0; i < opportunity.pairs.length; i++) {
      const pair = pairsInfo[i];
      const direction = opportunity.directions[i];
      const reserveIn = direction === 'token0ToToken1' ? pair.reserve0 : pair.reserve1;
      const candidate = reserveIn / MAX_INPUT_RESERVE_FRACTION;

      if (candidate <= 0n) {
        return 0n;
      }

      bound = bound === null || candidate < bound ? candidate : bound;
    }

    return bound ?? 0n;
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
