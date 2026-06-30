import { type Address } from 'viem';
import { V3Market } from '../market/v3-market';
import { type V3Edge, type V3SwapDirection } from '../market/v3-types';
import { type V2SearchPolicy } from '../market/v2-types';
import {
  type ArbitrageOpportunity,
  type CandidateRoute,
  type FindOpportunitiesRequest,
} from '../opportunities/opportunity-types';
import { V3RouteSizer } from '../pricing/v3-route-sizer';
import { type OpportunityStrategy } from './strategy';

type RouteState = {
  token: Address;
  originToken: Address;
  previous: RouteState | null;
  viaPool: Address | null;
  viaDirection: V3SwapDirection | null;
  depth: number;
};

export class V3CircularArbitrageStrategy implements OpportunityStrategy {
  private readonly sizer: V3RouteSizer;

  constructor(
    private readonly market: V3Market,
    private readonly policy: V2SearchPolicy
  ) {
    this.sizer = new V3RouteSizer(market, policy);
  }

  findOpportunities(request: FindOpportunitiesRequest): ArbitrageOpportunity[] {
    return this.findRoutes(request)
      .map(route => this.sizeRoute(route))
      .filter(opportunity => opportunity !== null);
  }

  private findRoutes(request: FindOpportunitiesRequest): CandidateRoute[] {
    const candidates: CandidateRoute[] = [];
    const statesByStep: Record<number, Map<Address, RouteState[]>> = {};

    statesByStep[0] = new Map();
    for (const startToken of request.startTokens) {
      statesByStep[0].set(startToken, [{
        token: startToken,
        originToken: startToken,
        previous: null,
        viaPool: null,
        viaDirection: null,
        depth: 0,
      }]);
    }

    for (let step = 1; step <= this.policy.maxRouteEdges; step++) {
      statesByStep[step] = new Map();
      let expanded = false;

      for (const [currentToken, entries] of statesByStep[step - 1].entries()) {
        const edges = this.market.rankedEdges(currentToken, this.policy.beamWidth);

        for (const entry of entries) {
          for (const edge of edges) {
            expanded = this.expandEdge(
              entry,
              edge,
              step,
              statesByStep[step],
              request.startTokens,
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
    edge: V3Edge,
    step: number,
    nextStep: Map<Address, RouteState[]>,
    startTokens: Address[],
    candidates: CandidateRoute[]
  ): boolean {
    if (this.hasPool(entry, edge.poolAddress)) return false;

    const next: RouteState = {
      token: edge.to,
      originToken: entry.originToken,
      previous: entry,
      viaPool: edge.poolAddress,
      viaDirection: edge.direction,
      depth: entry.depth + 1,
    };

    this.keepState(nextStep, edge.to, next);

    if (step >= 2 && this.isRelevantCandidate(next, startTokens)) {
      candidates.push(this.toRoute(next));
    }

    return true;
  }

  private keepState(step: Map<Address, RouteState[]>, token: Address, state: RouteState): void {
    if (!step.has(token)) {
      step.set(token, []);
    }

    const states = step.get(token)!;
    states.push(state);
    states.splice(this.policy.beamWidth);
  }

  private hasPool(state: RouteState, poolAddress: Address): boolean {
    for (let current: RouteState | null = state; current; current = current.previous) {
      if (current.viaPool === poolAddress) return true;
    }
    return false;
  }

  private isRelevantCandidate(state: RouteState, startTokens: Address[]): boolean {
    const originToken = state.originToken;
    const targetToken = state.token;
    return this.policy.routeMode === 'cross-token'
      ? startTokens.includes(originToken) && startTokens.includes(targetToken)
      : targetToken === originToken;
  }

  private toRoute(state: RouteState): CandidateRoute {
    const path = new Array<Address>(state.depth + 1);
    const pairs = new Array<Address>(state.depth);
    const directions = new Array<V3SwapDirection>(state.depth);
    let current: RouteState | null = state;

    for (let index = state.depth; index >= 0; index--) {
      path[index] = current!.token;

      if (index > 0) {
        pairs[index - 1] = current!.viaPool!;
        directions[index - 1] = current!.viaDirection!;
        current = current!.previous;
      }
    }

    return { path, pairs, directions };
  }

  private sizeRoute(route: CandidateRoute): ArbitrageOpportunity | null {
    const sized = this.sizer.size({
      path: route.path,
      pools: route.pairs,
      directions: route.directions,
    });

    if (!sized.complete || sized.profit <= 0n || sized.optimalInput <= 0n) {
      return null;
    }

    return {
      ...route,
      profit: sized.profit,
      optimalInput: sized.optimalInput,
      fees: route.pairs.map(poolAddress => {
        const pool = this.market.pool(poolAddress);
        if (!pool) throw new Error(`Missing V3 pool info for ${poolAddress}`);
        return pool.fee;
      }),
      routeKind: 'v3',
    };
  }
}
