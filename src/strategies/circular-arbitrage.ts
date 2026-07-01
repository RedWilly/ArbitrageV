import { type Address } from 'viem';
import { MarketGraph } from '../market-graph/market-graph';
import { type AnyMarketEdge, type ArbitrageSearchPolicy, type MarketProtocol } from '../market-graph/types';
import { transitionAllowed } from '../market-graph/types';
import {
  type CandidateRoute,
  type FindOpportunitiesRequest,
} from '../opportunities/opportunity-types';
import { compareFractions } from '../pricing/v2-swap-math';
import { type OpportunityStrategy } from './strategy';

type RouteState = {
  token: Address;
  originToken: Address;
  previous: RouteState | null;
  viaEdge: AnyMarketEdge | null;
  depth: number;
  rateNumerator: bigint;
  rateDenominator: bigint;
};

export class CircularArbitrageStrategy implements OpportunityStrategy {
  constructor(
    private readonly graph: MarketGraph,
    private readonly policy: ArbitrageSearchPolicy
  ) {}

  findCandidates(request: FindOpportunitiesRequest): CandidateRoute[] {
    const changedPoolList = request.changedPairs || [];
    const changedPools = new Set(changedPoolList.map(pool => pool.toLowerCase()));
    const candidates: CandidateRoute[] = [];
    const statesByStep: Record<number, Map<Address, RouteState[]>> = {};

    statesByStep[0] = new Map();
    for (const startToken of request.startTokens) {
      statesByStep[0].set(startToken, [{
        token: startToken,
        originToken: startToken,
        previous: null,
        viaEdge: null,
        depth: 0,
        rateNumerator: 1n,
        rateDenominator: 1n,
      }]);
    }

    for (let step = 1; step <= this.policy.maxRouteEdges; step++) {
      statesByStep[step] = new Map();
      let expanded = false;

      for (const [currentToken, entries] of statesByStep[step - 1].entries()) {
        const rankedEdges = this.graph.rankedEdges(currentToken, this.policy.beamWidth);

        for (const entry of entries) {
          for (const edge of rankedEdges) {
            expanded = this.expandEdge(
              entry,
              edge,
              step,
              statesByStep[step],
              request.startTokens,
              changedPools,
              candidates
            ) || expanded;
          }

          for (const poolAddress of changedPoolList) {
            const affectedEdges = this.graph.edgesForTokenPool(currentToken, poolAddress);
            for (const edge of affectedEdges) {
              if (this.edgeAlreadyIncluded(rankedEdges, edge)) continue;

              expanded = this.expandEdge(
                entry,
                edge,
                step,
                statesByStep[step],
                request.startTokens,
                changedPools,
                candidates
              ) || expanded;
            }
          }
        }
      }

      if (!expanded) break;
    }

    return candidates;
  }

  private expandEdge(
    entry: RouteState,
    edge: AnyMarketEdge,
    step: number,
    nextStep: Map<Address, RouteState[]>,
    startTokens: Address[],
    changedPools: Set<string>,
    candidates: CandidateRoute[]
  ): boolean {
    if (!transitionAllowed(this.policy, this.previousProtocol(entry), edge.protocol)) return false;
    if (this.hasPool(entry, edge.poolAddress)) return false;

    const next: RouteState = {
      token: edge.to,
      originToken: entry.originToken,
      previous: entry,
      viaEdge: edge,
      depth: entry.depth + 1,
      rateNumerator: entry.rateNumerator * edge.rateNumerator,
      rateDenominator: entry.rateDenominator * edge.rateDenominator,
    };

    this.keepBestState(nextStep, edge.to, next);

    if (step >= 2 && this.isRelevantCandidate(next, startTokens, changedPools)) {
      candidates.push(this.toRoute(next));
    }

    return true;
  }

  private edgeAlreadyIncluded(edges: AnyMarketEdge[], edge: AnyMarketEdge): boolean {
    for (const included of edges) {
      if (included.id === edge.id) return true;
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

  private previousProtocol(state: RouteState): MarketProtocol | null {
    return state.viaEdge?.protocol ?? null;
  }

  private hasPool(state: RouteState, poolAddress: Address): boolean {
    for (let current: RouteState | null = state; current; current = current.previous) {
      if (current.viaEdge?.poolAddress === poolAddress) return true;
    }
    return false;
  }

  private hasChangedPool(state: RouteState, changedPools: Set<string>): boolean {
    for (let current: RouteState | null = state; current; current = current.previous) {
      if (current.viaEdge && changedPools.has(current.viaEdge.poolAddress.toLowerCase())) return true;
    }
    return false;
  }

  private isRelevantCandidate(
    state: RouteState,
    startTokens: Address[],
    changedPools: Set<string>
  ): boolean {
    if (state.rateNumerator <= state.rateDenominator) return false;

    if (changedPools.size > 0 && !this.hasChangedPool(state, changedPools)) {
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
    const directions = new Array<CandidateRoute['directions'][number]>(state.depth);
    const edgeIds = new Array<string>(state.depth);
    const protocols = new Array<MarketProtocol>(state.depth);
    let current: RouteState | null = state;

    for (let index = state.depth; index >= 0; index--) {
      path[index] = current!.token;

      if (index > 0) {
        const edge = current!.viaEdge!;
        pairs[index - 1] = edge.poolAddress;
        directions[index - 1] = edge.direction;
        edgeIds[index - 1] = edge.id;
        protocols[index - 1] = edge.protocol;
        current = current!.previous;
      }
    }

    return { path, pairs, directions, edgeIds, protocols };
  }
}
