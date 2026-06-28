import { type Address } from 'viem';
import { MarketGraph } from './market-graph';
import { compareFractions, FEE_DENOMINATOR } from './v2-math';
import { type CandidateRoute, type SwapDirection, type V2SearchPolicy } from './types';

type RouteState = CandidateRoute & {
  rateNumerator: bigint;
  rateDenominator: bigint;
};

type CandidateSearchRequest = {
  startTokens: Address[];
  changedPairs?: Address[];
};

export class CandidateFinder {
  constructor(
    private readonly market: MarketGraph,
    private readonly policy: V2SearchPolicy
  ) {}

  findCandidates(request: CandidateSearchRequest): CandidateRoute[] {
    const changedPairs = new Set((request.changedPairs || []).map(pair => pair.toLowerCase()));
    const candidates: CandidateRoute[] = [];
    const statesByStep: Record<number, Map<Address, RouteState[]>> = {};

    statesByStep[0] = new Map();
    for (const startToken of request.startTokens) {
      statesByStep[0].set(startToken, [{
        rateNumerator: 1n,
        rateDenominator: 1n,
        path: [startToken],
        pairs: [],
        directions: [],
      }]);
    }

    for (let step = 1; step <= this.policy.maxRouteEdges; step++) {
      statesByStep[step] = new Map();
      let expanded = false;

      for (const [currentToken, entries] of statesByStep[step - 1].entries()) {
        const edges = this.market.rankedEdges(currentToken, this.policy.beamWidth);

        for (const entry of entries) {
          for (const edge of edges) {
            if (entry.pairs.includes(edge.pairAddress)) continue;

            expanded = true;
            const next: RouteState = {
              rateNumerator: entry.rateNumerator * edge.reserveOut * BigInt(10000 - edge.fee),
              rateDenominator: entry.rateDenominator * edge.reserveIn * FEE_DENOMINATOR,
              path: [...entry.path, edge.to],
              pairs: [...entry.pairs, edge.pairAddress],
              directions: [...entry.directions, edge.direction as SwapDirection],
            };

            this.keepBestState(statesByStep[step], edge.to, next);

            if (step >= 2 && this.isRelevantCandidate(next, request.startTokens, changedPairs)) {
              candidates.push({
                path: next.path,
                pairs: next.pairs,
                directions: next.directions,
              });
            }
          }
        }
      }

      if (!expanded) break;
    }

    return candidates;
  }

  private keepBestState(step: Map<Address, RouteState[]>, token: Address, state: RouteState): void {
    if (!step.has(token)) {
      step.set(token, []);
    }

    const states = step.get(token)!;
    states.push(state);
    states.sort((a, b) => {
      return compareFractions(
        b.rateNumerator,
        b.rateDenominator,
        a.rateNumerator,
        a.rateDenominator
      );
    });
    states.splice(this.policy.beamWidth);
  }

  private isRelevantCandidate(
    state: RouteState,
    startTokens: Address[],
    changedPairs: Set<string>
  ): boolean {
    if (state.rateNumerator <= state.rateDenominator) return false;

    if (changedPairs.size > 0 && !state.pairs.some(pair => changedPairs.has(pair.toLowerCase()))) {
      return false;
    }

    const originToken = state.path[0];
    const targetToken = state.path[state.path.length - 1];
    return this.policy.routeMode === 'cross-token'
      ? startTokens.includes(originToken) && startTokens.includes(targetToken)
      : targetToken === originToken;
  }
}
