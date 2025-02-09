// graph.ts ==>
import { maxHops, MAX_ENTRIES_PER_TOKEN, DEBUG } from './constants';
import { type Address } from 'viem';

export type PairInfo = {
  pairAddress: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  fee: number;
  buyFeeBps: number;
  sellFeeBps: number;
};

interface Edge {
  to: Address;
  pairAddress: Address;
  direction: 'token0ToToken1' | 'token1ToToken0';
  fee: number;
  reserveIn: bigint;
  reserveOut: bigint;
  buyFeeBps: number;
  sellFeeBps: number;
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

// const MAX_ENTRIES_PER_TOKEN = 5;
// const PROFIT_THRESHOLD = 1.005; // Minimum profit multiplier after fees

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

    this.updateGraphEdges(pair);  // Use a helper function to update graph edges
  }

  // Helper function to update graph edges for a given pair
  private updateGraphEdges(pair: PairInfo): void {
    const [res0, res1] = [Number(pair.reserve0), Number(pair.reserve1)];
    if (res0 === 0 || res1 === 0) return;

    // Token0 -> Token1 edge
    this.graph[pair.token0] = this.graph[pair.token0] || [];
    const edge0To1 = this.graph[pair.token0].find(
        edge => edge.to === pair.token1 && edge.pairAddress === pair.pairAddress
    );
    if (edge0To1) {
        edge0To1.reserveIn = pair.reserve0;
        edge0To1.reserveOut = pair.reserve1;
        edge0To1.fee = pair.fee;
        edge0To1.buyFeeBps = pair.buyFeeBps;
        edge0To1.sellFeeBps = pair.sellFeeBps;
    } else {
        this.graph[pair.token0].push({
            to: pair.token1,
            pairAddress: pair.pairAddress,
            direction: 'token0ToToken1',
            fee: pair.fee,
            reserveIn: pair.reserve0,
            reserveOut: pair.reserve1,
            buyFeeBps: pair.buyFeeBps,
            sellFeeBps: pair.sellFeeBps,
        });
    }

    // Token1 -> Token0 edge
    this.graph[pair.token1] = this.graph[pair.token1] || [];
    const edge1To0 = this.graph[pair.token1].find(
        edge => edge.to === pair.token0 && edge.pairAddress === pair.pairAddress
    );

    if (edge1To0) {
        edge1To0.reserveIn = pair.reserve1;
        edge1To0.reserveOut = pair.reserve0;
        edge1To0.fee = pair.fee;
        edge1To0.buyFeeBps = pair.sellFeeBps;  // Note: Reversed for opposite direction
        edge1To0.sellFeeBps = pair.buyFeeBps;  // Note: Reversed for opposite direction
    } else {
        this.graph[pair.token1].push({
            to: pair.token0,
            pairAddress: pair.pairAddress,
            direction: 'token1ToToken0',
            fee: pair.fee,
            reserveIn: pair.reserve1,
            reserveOut: pair.reserve0,
            buyFeeBps: pair.sellFeeBps,  // Note: Reversed for opposite direction
            sellFeeBps: pair.buyFeeBps,  // Note: Reversed for opposite direction
        });
    }
  }

  // Helper function to update pair reserves without re-building the entire graph
  updatePairReserves(pairAddress: Address, reserve0: bigint, reserve1: bigint): void {
    const pair = this.pairs.get(pairAddress);
    if (!pair) {
      console.warn(`Pair ${pairAddress} not found in graph.  Consider adding it first.`);
      return;
    }

    // Update the reserves in the PairInfo
    pair.reserve0 = reserve0;
    pair.reserve1 = reserve1;

    // IMPORTANT: Update the edges in the graph
    this.updateGraphEdges({ ...pair, reserve0, reserve1 });
    if (DEBUG) {
      console.log(`Updated reserves for pair ${pairAddress}: ${reserve0}, ${reserve1}`);
    }
  }

  findArbitrageOpportunities(
    startToken: Address,
    maxDepth: number = maxHops
  ): { paths: Address[][]; pairs: Address[][]; profits: number[]; optimalAmounts: number[]; amountsOut: number[][] } {
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
        const { maxProfit, optimalInput, amountsOut } = this.calculateMaxProfit(opp);
        return { ...opp, profit: maxProfit, optimalInput, amountsOut };
      })
      .filter(opp => opp.profit > 0)
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 20);

    return {
      paths: validated.map(opp => opp.path),
      pairs: validated.map(opp => opp.pairs),
      profits: validated.map(opp => opp.profit),
      optimalAmounts: validated.map(opp => opp.optimalInput),
      amountsOut: validated.map(opp => opp.amountsOut)
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
    calculateProfit: (inputAmount: number) => { profit: number; amountsOut: number[] };
    calculateJacobian: (inputAmount: number) => number;
    calculateHessian: (inputAmount: number) => number;
  } {
    // Swap function (CPMM formula with tax)
    const swap = (
      amountIn: number,
      reserveIn: number,
      reserveOut: number,
      fee: number,
      buyFeeBps: number,
      sellFeeBps: number,
      isForward: boolean  // true for buy, false for sell
    ): number => {
      const dexFeeMultiplier = 1 - fee / 10000;
      const taxFeeBps = isForward ? buyFeeBps : sellFeeBps;
      const taxMultiplier = 1 - taxFeeBps / 10000;
      const amountInAfterFees = amountIn * dexFeeMultiplier * taxMultiplier;
      return (amountInAfterFees * reserveOut) / (reserveIn + amountInAfterFees);
    };

    // Calculate profit for the entire arbitrage loop
    const calculateProfit = (inputAmount: number): { profit: number; amountsOut: number[] } => {
      let currentAmount = inputAmount;
      const amountsOut: number[] = [inputAmount];  // Include initial amount

      for (let i = 0; i < pairsInfo.length; i++) {
        const pair = pairsInfo[i];
        const direction = opportunity.directions[i];
        const isForward = direction === 'token0ToToken1';

        const [reserveIn, reserveOut] = isForward
          ? [Number(pair.reserve0), Number(pair.reserve1)]
          : [Number(pair.reserve1), Number(pair.reserve0)];

        const [buyFee, sellFee] = isForward
          ? [pair.buyFeeBps, pair.sellFeeBps]
          : [pair.sellFeeBps, pair.buyFeeBps];

        currentAmount = swap(
          currentAmount,
          reserveIn,
          reserveOut,
          pair.fee,
          buyFee,
          sellFee,
          isForward
        );
        
        amountsOut.push(currentAmount);
      }

      return { 
        profit: currentAmount - inputAmount,
        amountsOut 
      };
    };

    // Derivative of swap function
    const swapDerivative = (
      amountIn: number,
      reserveIn: number,
      reserveOut: number,
      fee: number,
      buyFeeBps: number,
      sellFeeBps: number,
      isForward: boolean
    ): number => {
      const dexFeeMultiplier = 1 - fee / 10000;
      const taxFeeBps = isForward ? buyFeeBps : sellFeeBps;
      const taxMultiplier = 1 - taxFeeBps / 10000;
      const totalFeeMultiplier = dexFeeMultiplier * taxMultiplier;
      return (totalFeeMultiplier * reserveIn * reserveOut) / ((reserveIn + totalFeeMultiplier * amountIn) ** 2);
    };

    // Second derivative of swap function
    const swapSecondDerivative = (
      amountIn: number,
      reserveIn: number,
      reserveOut: number,
      fee: number,
      buyFeeBps: number,
      sellFeeBps: number,
      isForward: boolean
    ): number => {
      const dexFeeMultiplier = 1 - fee / 10000;
      const taxFeeBps = isForward ? buyFeeBps : sellFeeBps;
      const taxMultiplier = 1 - taxFeeBps / 10000;
      const totalFeeMultiplier = dexFeeMultiplier * taxMultiplier;
      const denominator = reserveIn + totalFeeMultiplier * amountIn;
      return (-2 * totalFeeMultiplier * totalFeeMultiplier * reserveIn * reserveOut) / (denominator ** 3);
    };

    // Calculate Jacobian of the profit function (first derivative)
    const calculateJacobian = (inputAmount: number): number => {
      let derivative = 1;
      let currentAmount = inputAmount;

      for (let i = 0; i < pairsInfo.length; i++) {
        const pair = pairsInfo[i];
        const direction = opportunity.directions[i];
        const isForward = direction === 'token0ToToken1';

        const [reserveIn, reserveOut] = isForward
          ? [Number(pair.reserve0), Number(pair.reserve1)]
          : [Number(pair.reserve1), Number(pair.reserve0)];

        const [buyFee, sellFee] = isForward
          ? [pair.buyFeeBps, pair.sellFeeBps]
          : [pair.sellFeeBps, pair.buyFeeBps];

        derivative *= swapDerivative(
          currentAmount,
          reserveIn,
          reserveOut,
          pair.fee,
          buyFee,
          sellFee,
          isForward
        );

        currentAmount = swap(
          currentAmount,
          reserveIn,
          reserveOut,
          pair.fee,
          buyFee,
          sellFee,
          isForward
        );
      }

      return derivative - 1;
    };

    // Calculate Hessian of the profit function (second derivative)
    const calculateHessian = (inputAmount: number): number => {
      let secondDerivative = 0;
      let currentAmount = inputAmount;
      let cumulativeFirstDerivative = 1;

      for (let i = 0; i < pairsInfo.length; i++) {
        const pair = pairsInfo[i];
        const direction = opportunity.directions[i];
        const isForward = direction === 'token0ToToken1';

        const [reserveIn, reserveOut] = isForward
          ? [Number(pair.reserve0), Number(pair.reserve1)]
          : [Number(pair.reserve1), Number(pair.reserve0)];

        const [buyFee, sellFee] = isForward
          ? [pair.buyFeeBps, pair.sellFeeBps]
          : [pair.sellFeeBps, pair.buyFeeBps];

        const firstDerivative = swapDerivative(
          currentAmount,
          reserveIn,
          reserveOut,
          pair.fee,
          buyFee,
          sellFee,
          isForward
        );

        secondDerivative += cumulativeFirstDerivative * swapSecondDerivative(
          currentAmount,
          reserveIn,
          reserveOut,
          pair.fee,
          buyFee,
          sellFee,
          isForward
        );

        cumulativeFirstDerivative *= firstDerivative;
        currentAmount = swap(
          currentAmount,
          reserveIn,
          reserveOut,
          pair.fee,
          buyFee,
          sellFee,
          isForward
        );
      }

      return secondDerivative;
    };

    return { calculateProfit, calculateJacobian, calculateHessian };
  }

  private calculateMaxProfit(opportunity: {
    path: Address[];
    pairs: Address[];
    directions: ('token0ToToken1' | 'token1ToToken0')[];
  }): { maxProfit: number; optimalInput: number; amountsOut: number[] } {
    const pairsInfo = opportunity.pairs.map(pairAddress => {
      const pair = this.pairs.get(pairAddress);
      if (!pair) throw new Error(`Missing pair info for ${pairAddress}`);
      return pair;
    });

    const { calculateProfit, calculateJacobian, calculateHessian } = this.createProfitFunctions(opportunity, pairsInfo);

    //Newton's Method
    let inputAmount = 9e18; // Initial guess (1 ETH)
    const tolerance = 1e-8;
    const maxIterations = 100;

    let maxProfit = -Infinity;
    let optimalInput = 0;
    let bestAmountsOut: number[] = [];

    for (let i = 0; i < maxIterations; i++) {
      const { profit, amountsOut } = calculateProfit(inputAmount);
      const jacobian = calculateJacobian(inputAmount);
      const hessian = calculateHessian(inputAmount);

      if (hessian === 0) {
        console.warn("Hessian is zero, cannot invert.");
        break;
      }

      const delta = jacobian / hessian;
      const newInputAmount = inputAmount - delta;

      if (Math.abs(newInputAmount - inputAmount) < tolerance) {
        break;
      }
      inputAmount = Math.max(0, newInputAmount);

      if (profit > maxProfit) {
        maxProfit = profit;
        optimalInput = inputAmount;
        bestAmountsOut = amountsOut;
      }
    }

    return { maxProfit, optimalInput, amountsOut: bestAmountsOut };
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
    this.graph = {};
    this.tokens.clear();
    this.pairs.clear();
  }
}