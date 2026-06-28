import { MarketGraph } from './market-graph';
import { V2_SEARCH_POLICY } from './search-policy';
import { calculateRouteProfit, reservesForDirection } from './v2-math';
import { type CandidateRoute, type PairInfo } from './types';

export class TradeSizer {
  constructor(private readonly market: MarketGraph) {}

  size(route: CandidateRoute): { profit: bigint; optimalInput: bigint } {
    const pairs = route.pairs.map(pairAddress => {
      const pair = this.market.pair(pairAddress);
      if (!pair) throw new Error(`Missing pair info for ${pairAddress}`);
      return pair;
    });

    let low = 1n;
    let high = this.maxInputBound(route, pairs);

    if (high <= low) {
      return { profit: 0n, optimalInput: 0n };
    }

    for (let i = 0; i < V2_SEARCH_POLICY.optimizationIterations && high - low > 3n; i++) {
      const third = (high - low) / 3n;
      if (third === 0n) break;

      const mid1 = low + third;
      const mid2 = high - third;
      const profit1 = calculateRouteProfit(mid1, pairs, route.directions);
      const profit2 = calculateRouteProfit(mid2, pairs, route.directions);

      if (profit1 < profit2) {
        low = mid1 + 1n;
      } else {
        high = mid2 - 1n;
      }
    }

    return this.bestFinalCandidate(route, pairs, low, high);
  }

  private maxInputBound(route: CandidateRoute, pairs: PairInfo[]): bigint {
    let bound: bigint | null = null;

    for (let i = 0; i < pairs.length; i++) {
      const { reserveIn } = reservesForDirection(pairs[i], route.directions[i]);
      const candidate = reserveIn / V2_SEARCH_POLICY.maxInputReserveFraction;
      if (candidate <= 0n) return 0n;
      bound = bound === null || candidate < bound ? candidate : bound;
    }

    return bound ?? 0n;
  }

  private bestFinalCandidate(
    route: CandidateRoute,
    pairs: PairInfo[],
    low: bigint,
    high: bigint
  ): { profit: bigint; optimalInput: bigint } {
    const center = (low + high) / 2n;
    const candidates = new Set<bigint>([low, center, high]);

    for (let offset = 1n; offset <= 5n; offset++) {
      if (center > offset) candidates.add(center - offset);
      candidates.add(center + offset);
    }

    let profit = 0n;
    let optimalInput = 0n;

    for (const input of candidates) {
      if (input < low || input > high) continue;
      const candidateProfit = calculateRouteProfit(input, pairs, route.directions);
      if (candidateProfit > profit) {
        profit = candidateProfit;
        optimalInput = input;
      }
    }

    return { profit, optimalInput };
  }
}
