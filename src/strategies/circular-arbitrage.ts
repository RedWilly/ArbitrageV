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

type RouteStateStore = {
  tokens: Address[];
  originTokens: Address[];
  previousIndexes: number[];
  viaEdges: Array<AnyMarketEdge | null>;
  depths: number[];
  rateNumerators: bigint[];
  rateDenominators: bigint[];
};

const NO_STATE = -1;

export class CircularArbitrageStrategy implements OpportunityStrategy {
  constructor(
    private readonly graph: MarketGraph,
    private readonly policy: ArbitrageSearchPolicy
  ) {}

  findCandidates(request: FindOpportunitiesRequest): CandidateRoute[] {
    const changedPoolList = request.changedPairs || [];
    const changedPools = new Set(changedPoolList.map(pool => pool.toLowerCase()));
    const candidates: CandidateRoute[] = [];
    const states = this.createStateStore();
    const statesByStep: Record<number, Map<Address, number[]>> = {};

    statesByStep[0] = new Map();
    for (const startToken of request.startTokens) {
      const stateIndex = this.pushState(states, {
        token: startToken,
        originToken: startToken,
        previousIndex: NO_STATE,
        viaEdge: null,
        depth: 0,
        rateNumerator: 1n,
        rateDenominator: 1n,
      });
      statesByStep[0].set(startToken, [stateIndex]);
    }

    for (let step = 1; step <= this.policy.maxRouteEdges; step++) {
      statesByStep[step] = new Map();
      let expanded = false;

      for (const [currentToken, stateIndexes] of statesByStep[step - 1].entries()) {
        const rankedEdges = this.graph.rankedEdges(currentToken, this.policy.beamWidth);

        for (const stateIndex of stateIndexes) {
          for (const edge of rankedEdges) {
            expanded = this.expandEdge(
              states,
              stateIndex,
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
                states,
                stateIndex,
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
    states: RouteStateStore,
    entryIndex: number,
    edge: AnyMarketEdge,
    step: number,
    nextStep: Map<Address, number[]>,
    startTokens: Address[],
    changedPools: Set<string>,
    candidates: CandidateRoute[]
  ): boolean {
    if (!transitionAllowed(this.policy, this.previousProtocol(states, entryIndex), edge.protocol)) return false;
    if (this.hasPool(states, entryIndex, edge.poolAddress)) return false;

    const nextIndex = this.pushState(states, {
      token: edge.to,
      originToken: states.originTokens[entryIndex],
      previousIndex: entryIndex,
      viaEdge: edge,
      depth: states.depths[entryIndex] + 1,
      rateNumerator: states.rateNumerators[entryIndex] * edge.rateNumerator,
      rateDenominator: states.rateDenominators[entryIndex] * edge.rateDenominator,
    });

    this.keepBestState(states, nextStep, edge.to, nextIndex);

    if (step >= 2 && this.isRelevantCandidate(states, nextIndex, startTokens, changedPools)) {
      candidates.push(this.toRoute(states, nextIndex));
    }

    return true;
  }

  private edgeAlreadyIncluded(edges: AnyMarketEdge[], edge: AnyMarketEdge): boolean {
    for (const included of edges) {
      if (included.id === edge.id) return true;
    }
    return false;
  }

  private keepBestState(
    store: RouteStateStore,
    step: Map<Address, number[]>,
    token: Address,
    stateIndex: number
  ): void {
    if (!step.has(token)) {
      step.set(token, []);
    }

    const stateIndexes = step.get(token)!;
    stateIndexes.push(stateIndex);
    this.moveStateIntoRank(store, stateIndexes, stateIndexes.length - 1);
    stateIndexes.splice(this.policy.beamWidth);
  }

  private moveStateIntoRank(store: RouteStateStore, stateIndexes: number[], index: number): void {
    while (index > 0 && this.compareStateRank(store, stateIndexes[index], stateIndexes[index - 1]) > 0) {
      const previous = stateIndexes[index - 1];
      stateIndexes[index - 1] = stateIndexes[index];
      stateIndexes[index] = previous;
      index--;
    }
  }

  private compareStateRank(store: RouteStateStore, a: number, b: number): number {
    return compareFractions(
      store.rateNumerators[a],
      store.rateDenominators[a],
      store.rateNumerators[b],
      store.rateDenominators[b]
    );
  }

  private previousProtocol(states: RouteStateStore, stateIndex: number): MarketProtocol | null {
    return states.viaEdges[stateIndex]?.protocol ?? null;
  }

  private hasPool(states: RouteStateStore, stateIndex: number, poolAddress: Address): boolean {
    for (let current = stateIndex; current !== NO_STATE; current = states.previousIndexes[current]) {
      if (states.viaEdges[current]?.poolAddress === poolAddress) return true;
    }
    return false;
  }

  private hasChangedPool(states: RouteStateStore, stateIndex: number, changedPools: Set<string>): boolean {
    for (let current = stateIndex; current !== NO_STATE; current = states.previousIndexes[current]) {
      const edge = states.viaEdges[current];
      if (edge && changedPools.has(edge.poolAddress.toLowerCase())) return true;
    }
    return false;
  }

  private isRelevantCandidate(
    states: RouteStateStore,
    stateIndex: number,
    startTokens: Address[],
    changedPools: Set<string>
  ): boolean {
    if (states.rateNumerators[stateIndex] <= states.rateDenominators[stateIndex]) return false;

    if (changedPools.size > 0 && !this.hasChangedPool(states, stateIndex, changedPools)) {
      return false;
    }

    const originToken = states.originTokens[stateIndex];
    const targetToken = states.tokens[stateIndex];
    return this.policy.routeMode === 'cross-token'
      ? startTokens.includes(originToken) && startTokens.includes(targetToken)
      : targetToken === originToken;
  }

  private toRoute(states: RouteStateStore, stateIndex: number): CandidateRoute {
    const depth = states.depths[stateIndex];
    const path = new Array<Address>(depth + 1);
    const pairs = new Array<Address>(depth);
    const directions = new Array<CandidateRoute['directions'][number]>(depth);
    const edgeIds = new Array<string>(depth);
    const protocols = new Array<MarketProtocol>(depth);
    let current = stateIndex;

    for (let index = depth; index >= 0; index--) {
      path[index] = states.tokens[current];

      if (index > 0) {
        const edge = states.viaEdges[current]!;
        pairs[index - 1] = edge.poolAddress;
        directions[index - 1] = edge.direction;
        edgeIds[index - 1] = edge.id;
        protocols[index - 1] = edge.protocol;
        current = states.previousIndexes[current];
      }
    }

    return { path, pairs, directions, edgeIds, protocols };
  }

  private createStateStore(): RouteStateStore {
    return {
      tokens: [],
      originTokens: [],
      previousIndexes: [],
      viaEdges: [],
      depths: [],
      rateNumerators: [],
      rateDenominators: [],
    };
  }

  private pushState(
    states: RouteStateStore,
    state: {
      token: Address;
      originToken: Address;
      previousIndex: number;
      viaEdge: AnyMarketEdge | null;
      depth: number;
      rateNumerator: bigint;
      rateDenominator: bigint;
    }
  ): number {
    const index = states.tokens.length;
    states.tokens.push(state.token);
    states.originTokens.push(state.originToken);
    states.previousIndexes.push(state.previousIndex);
    states.viaEdges.push(state.viaEdge);
    states.depths.push(state.depth);
    states.rateNumerators.push(state.rateNumerator);
    states.rateDenominators.push(state.rateDenominator);
    return index;
  }
}
