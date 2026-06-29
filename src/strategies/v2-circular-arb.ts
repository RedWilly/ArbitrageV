import { type Address } from 'viem';
import { feeMultiplier } from '../values';
import { V2Market } from '../market/v2-market';
import { type Edge, type SwapDirection, type V2SearchPolicy } from '../market/v2-types';
import {
  type CandidateRoute,
  type FindOpportunitiesRequest,
} from '../opportunities/opportunity-types';
import { compareFractions, FEE_DENOMINATOR } from '../pricing/v2-swap-math';
import { type OpportunityStrategy } from './strategy';

type RouteState = {
  token: Address;
  originToken: Address;
  previous: RouteState | null;
  viaPair: Address | null;
  viaDirection: SwapDirection | null;
  depth: number;
  rateNumerator: bigint;
  rateDenominator: bigint;
};

export class V2CircularArbitrageStrategy implements OpportunityStrategy {
  constructor(
    private readonly market: V2Market,
    private readonly policy: V2SearchPolicy
  ) {}

  findCandidates(request: FindOpportunitiesRequest): CandidateRoute[] {
    const changedPairList = request.changedPairs || [];
    const changedPairs = new Set(changedPairList.map(pair => pair.toLowerCase()));
    const candidates: CandidateRoute[] = [];
    const statesByStep: Record<number, Map<Address, RouteState[]>> = {};

    statesByStep[0] = new Map();
    for (const startToken of request.startTokens) {
      statesByStep[0].set(startToken, [{
        token: startToken,
        originToken: startToken,
        previous: null,
        viaPair: null,
        viaDirection: null,
        depth: 0,
        rateNumerator: 1n,
        rateDenominator: 1n,
      }]);
    }

    for (let step = 1; step <= this.policy.maxRouteEdges; step++) {
      statesByStep[step] = new Map();
      let expanded = false;

      for (const [currentToken, entries] of statesByStep[step - 1].entries()) {
        const edges = this.market.rankedEdges(currentToken, this.policy.beamWidth);

        for (const entry of entries) {
          for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
            const edge = edges[edgeIndex];
            expanded = this.expandEdge(
              entry,
              edge,
              step,
              statesByStep[step],
              request.startTokens,
              changedPairs,
              candidates
            ) || expanded;
          }

          for (const pairAddress of changedPairList) {
            const edge = this.market.edgeForTokenPair(currentToken, pairAddress);
            if (!edge || this.edgeAlreadyIncluded(edges, edge)) continue;

            expanded = this.expandEdge(
              entry,
              edge,
              step,
              statesByStep[step],
              request.startTokens,
              changedPairs,
              candidates
            ) || expanded;
          }
        }
      }

      if (!expanded) break;
    }

    return candidates;
  }

  private expandEdge(
    entry: RouteState,
    edge: Edge,
    step: number,
    nextStep: Map<Address, RouteState[]>,
    startTokens: Address[],
    changedPairs: Set<string>,
    candidates: CandidateRoute[]
  ): boolean {
    if (this.hasPair(entry, edge.pairAddress)) return false;

    const next: RouteState = {
      token: edge.to,
      originToken: entry.originToken,
      previous: entry,
      viaPair: edge.pairAddress,
      viaDirection: edge.direction as SwapDirection,
      depth: entry.depth + 1,
      rateNumerator: entry.rateNumerator * edge.reserveOut * feeMultiplier(edge.fee),
      rateDenominator: entry.rateDenominator * edge.reserveIn * FEE_DENOMINATOR,
    };

    this.keepBestState(nextStep, edge.to, next);

    if (step >= 2 && this.isRelevantCandidate(next, startTokens, changedPairs)) {
      candidates.push(this.toRoute(next));
    }

    return true;
  }

  private edgeAlreadyIncluded(edges: Edge[], edge: Edge): boolean {
    for (const included of edges) {
      if (included.pairAddress === edge.pairAddress) return true;
    }
    return false;
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

  private hasPair(state: RouteState, pairAddress: Address): boolean {
    for (let current: RouteState | null = state; current; current = current.previous) {
      if (current.viaPair === pairAddress) return true;
    }
    return false;
  }

  private hasChangedPair(state: RouteState, changedPairs: Set<string>): boolean {
    for (let current: RouteState | null = state; current; current = current.previous) {
      if (current.viaPair && changedPairs.has(current.viaPair.toLowerCase())) return true;
    }
    return false;
  }

  private isRelevantCandidate(
    state: RouteState,
    startTokens: Address[],
    changedPairs: Set<string>
  ): boolean {
    if (state.rateNumerator <= state.rateDenominator) return false;

    if (changedPairs.size > 0 && !this.hasChangedPair(state, changedPairs)) {
      return false;
    }

    const originToken = state.originToken;
    const targetToken = state.token;
    return this.policy.routeMode === 'cross-token'
      ? startTokens.includes(originToken) && startTokens.includes(targetToken)
      : targetToken === originToken;
  }

  private toRoute(state: RouteState): CandidateRoute {
    const path = new Array<Address>(state.depth + 1);
    const pairs = new Array<Address>(state.depth);
    const directions = new Array<SwapDirection>(state.depth);
    let current: RouteState | null = state;

    for (let index = state.depth; index >= 0; index--) {
      path[index] = current!.token;

      if (index > 0) {
        pairs[index - 1] = current!.viaPair!;
        directions[index - 1] = current!.viaDirection!;
        current = current!.previous;
      }
    }

    return { path, pairs, directions };
  }
}
