import { V2Market } from '../market/v2-market';
import { type PairInfo, type V2SearchPolicy } from '../market/v2-types';
import { type CandidateRoute } from '../opportunities/opportunity-types';
import { calculateRouteProfit, reservesForDirection } from './v2-swap-math';

export class RouteSizer {
  constructor(
    private readonly market: V2Market,
    private readonly policy: V2SearchPolicy
  ) {}

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

    for (let i = 0; i < this.policy.optimizationIterations && high - low > 3n; i++) {
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
      const candidate = reserveIn / this.policy.maxInputReserveFraction;
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
