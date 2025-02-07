// this works finding the optimal path and the optimal input amount 
//but does not take into consideration the reserve of the pairs
// graph.ts
import { maxHops } from './constants';
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

interface DPEntry {
  amountOut: number;
  path: Address[];
  pairs: Address[];
  directions: ('token0ToToken1' | 'token1ToToken0')[];
}

interface DPTable {
  [step: number]: {
    [token: string]: DPEntry[];
  };
}

const MAX_ENTRIES_PER_TOKEN = 5;
const PROFIT_THRESHOLD = 1.005; // Minimum profit multiplier after fees

export class ArbitrageGraph {
  private graph: { [key: Address]: Edge[] } = {};
  private tokens: Set<Address> = new Set();
  private pairs: Map<Address, PairInfo> = new Map();

  addPair(pair: PairInfo): void {
    const [res0, res1] = [Number(pair.reserve0), Number(pair.reserve1)];
    if (res0 === 0 || res1 === 0) return;

    this.tokens.add(pair.token0);
    this.tokens.add(pair.token1);
    this.pairs.set(pair.pairAddress, pair);

    // Token0 -> Token1 edge
    this.graph[pair.token0] = this.graph[pair.token0] || [];
    this.graph[pair.token0].push({
      to: pair.token1,
      pairAddress: pair.pairAddress,
      direction: 'token0ToToken1',
      fee: pair.fee,
      reserveIn: pair.reserve0,
      reserveOut: pair.reserve1,
    });

    // Token1 -> Token0 edge
    this.graph[pair.token1] = this.graph[pair.token1] || [];
    this.graph[pair.token1].push({
      to: pair.token0,
      pairAddress: pair.pairAddress,
      direction: 'token1ToToken0',
      fee: pair.fee,
      reserveIn: pair.reserve1,
      reserveOut: pair.reserve0,
    });
  }

  findArbitrageOpportunities(
    startToken: Address,
    maxDepth: number = maxHops
  ): { paths: Address[][]; pairs: Address[][]; profits: number[]; optimalAmounts: number[] } {
    const dp: DPTable = {};
    const rawOpportunities: Array<{
      path: Address[];
      pairs: Address[];
      directions: ('token0ToToken1' | 'token1ToToken0')[];
    }> = [];

    // Initialize with starting token
    dp[0] = {
      [startToken]: [
        {
          amountOut: 1.0,
          path: [startToken],
          pairs: [],
          directions: [],
        },
      ],
    };

    for (let step = 1; step <= maxDepth; step++) {
      dp[step] = {};

      for (const [currentToken, entries] of Object.entries(dp[step - 1])) {
        const edges = this.graph[currentToken as Address] || [];

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
            if (!dp[step][targetToken]) {
              dp[step][targetToken] = [];
            }

            // Keep only top entries per token
            dp[step][targetToken].push(newEntry);
            dp[step][targetToken].sort((a, b) => b.amountOut - a.amountOut);
            dp[step][targetToken] = dp[step][targetToken].slice(0, MAX_ENTRIES_PER_TOKEN);

            // Record cycle if returns to start with profit potential
            if (targetToken === startToken && step >= 2) {
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

    // Validate opportunities with actual swap simulation
    const validated = rawOpportunities
      .map(opp => {
        const { maxProfit, optimalInput } = this.calculateMaxProfit(opp);
        return { ...opp, profit: maxProfit, optimalInput };
      })
      .filter(opp => opp.profit > 0)
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 20);

    return {
      paths: validated.map(opp => opp.path),
      pairs: validated.map(opp => opp.pairs),
      profits: validated.map(opp => opp.profit),
      optimalAmounts: validated.map(opp => opp.optimalInput),
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

    const profitFunction = (inputAmount: number): number => {
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

          const feeMultiplier = 1 - pair.fee / 10000;
          const amountInAfterFee = amount * feeMultiplier;
          amount = (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
        }
        return amount - inputAmount;
      } catch {
        return -Infinity;
      }
    };

    // Ternary search to find optimal input
    let left = 0;
    let right = 1e22; // Adjust based on expected input scale
    let maxProfit = 0;
    let optimalInput = 0;

    for (let i = 0; i < 100; i++) {
      const mid1 = left + (right - left) / 3;
      const mid2 = right - (right - left) / 3;
      const profit1 = profitFunction(mid1);
      const profit2 = profitFunction(mid2);

      if (profit1 > maxProfit) {
        maxProfit = profit1;
        optimalInput = mid1;
      }
      if (profit2 > maxProfit) {
        maxProfit = profit2;
        optimalInput = mid2;
      }

      if (profit1 > profit2) right = mid2;
      else left = mid1;
    }

    return { maxProfit, optimalInput };
  }

  getTokens(): Address[] {
    return Array.from(this.tokens);
  }

  clear(): void {
    this.graph = {};
    this.tokens.clear();
    this.pairs.clear();
  }
}