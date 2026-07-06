import { encodeAbiParameters, type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, TOKENS } from '../constants';
import { type CarbonStrategy } from '../market/carbon';
import { MarketGraph } from '../market-graph/market-graph';
import { sizeRoute } from '../market-graph/route-sizer';
import { type ArbitrageSearchPolicy, type FlashPoolCandidate } from '../market-graph/types';
import { type PairInfo, type ReserveUpdate } from '../market/v2-types';
import {
  type V3BitmapWord,
  type V3BitmapWordUpdate,
  type V3PoolConfig,
  type V3PoolInfo,
  type V3PoolUpdate,
  type V3Tick,
  type V3TickUpdate,
} from '../market/v3-types';
import { CircularArbitrageStrategy } from '../strategies/circular-arbitrage';
import {
  type ArbitrageOpportunity,
  type ArbitrageSearchResult,
  type CandidateRoute,
  type FindOpportunitiesRequest,
} from './opportunity-types';

export class OpportunityEngine {
  private readonly graph: MarketGraph;
  private readonly strategy: CircularArbitrageStrategy;

  constructor(
    private readonly policy: ArbitrageSearchPolicy = ARBITRAGE_SEARCH_POLICY,
    graph = new MarketGraph(policy)
  ) {
    this.graph = graph;
    this.strategy = new CircularArbitrageStrategy(this.graph, policy);
  }

  addPair(pair: PairInfo): void {
    this.graph.addPair(pair);
  }

  updateReserves(updates: ReserveUpdate[]): void {
    this.graph.updateReserves(updates);
  }

  addV3Pool(pool: V3PoolConfig): void {
    this.graph.addV3Pool(pool);
  }

  updateV3PoolStates(updates: V3PoolUpdate[]): void {
    this.graph.updateV3PoolStates(updates);
  }

  updateV3Ticks(updates: V3TickUpdate[]): void {
    this.graph.updateV3Ticks(updates);
  }

  updateV3BitmapWords(updates: V3BitmapWordUpdate[]): void {
    this.graph.updateV3BitmapWords(updates);
  }

  setCarbonStrategies(strategies: readonly CarbonStrategy[]): void {
    this.graph.setCarbonStrategies(strategies);
  }

  getV3PoolAddresses(): Address[] {
    return this.graph.getV3PoolAddresses();
  }

  getV3Pools(): V3PoolInfo[] {
    return this.graph.getV3Pools();
  }

  getV3InitializedTicks(poolAddress: Address): V3Tick[] {
    return this.graph.getV3InitializedTicks(poolAddress);
  }

  getV3BitmapWords(poolAddress: Address): V3BitmapWord[] {
    return this.graph.getV3BitmapWords(poolAddress);
  }

  findOpportunities(request: FindOpportunitiesRequest): ArbitrageSearchResult {
    const opportunities: ArbitrageOpportunity[] = [];

    this.strategy.visitCandidates(request, candidate => {
      const opportunity = this.sizeCandidate(candidate);
      const originToken = opportunity.path[0];
      const token = TOKENS.find(addr => addr.address === originToken);

      if (!token) {
        throw new Error(`No token config found for ${originToken}. Please update TOKENS in constants.ts.`);
      }

      if (opportunity.profit <= token.minProfit) return;
      this.insertRankedOpportunity(opportunities, opportunity);
    });

    return {
      paths: opportunities.map(opportunity => opportunity.path),
      pairs: opportunities.map(opportunity => opportunity.pairs),
      protocols: opportunities.map(opportunity => opportunity.protocols ?? []),
      profits: opportunities.map(opportunity => opportunity.profit),
      optimalAmounts: opportunities.map(opportunity => opportunity.optimalInput),
      fees: opportunities.map(opportunity => opportunity.fees),
      routeData: opportunities.map(opportunity => opportunity.routeData),
    };
  }

  findBestFlashPoolForToken(
    token: Address,
    amountIn: bigint,
    excludePools: Address[] = []
  ): FlashPoolCandidate | null {
    return this.graph.findBestFlashPoolForToken(token, amountIn, excludePools);
  }

  getTokens(): Address[] {
    return this.graph.getTokens();
  }

  getPairAddresses(): Address[] {
    return this.graph.getPairAddresses();
  }

  getAllPairs(): PairInfo[] {
    return this.graph.getAllPairs();
  }

  clear(): void {
    this.graph.clear();
  }

  private sizeCandidate(candidate: CandidateRoute): ArbitrageOpportunity {
    const { profit, optimalInput, complete } = sizeRoute(this.graph, this.policy, {
      path: candidate.path,
      pools: candidate.pairs,
      edgeIds: candidate.edgeIds,
      edgeIndexes: candidate.edgeIndexes,
      protocols: candidate.protocols,
    });
    const fees: number[] = [];
    const routeData: `0x${string}`[] = [];

    candidate.edgeIds.forEach((edgeId, index) => {
      const edge = candidate.edgeIndexes
        ? this.graph.edgeAt(candidate.edgeIndexes[index])
        : this.graph.edge(edgeId);
      if (!edge) throw new Error(`Missing market edge ${edgeId}`);
      fees.push(edge.fee);
      routeData.push(edge.protocol === 'carbon'
        ? encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }],
          [edge.strategyId, edge.rawFrom, edge.rawTo]
        )
        : '0x');
    });

    return {
      ...candidate,
      profit: complete ? profit : 0n,
      optimalInput: complete ? optimalInput : 0n,
      fees,
      routeData,
    };
  }

  private insertRankedOpportunity(
    opportunities: ArbitrageOpportunity[],
    opportunity: ArbitrageOpportunity
  ): void {
    let index = opportunities.length;

    while (index > 0 && opportunity.profit > opportunities[index - 1].profit) {
      index--;
    }

    if (index >= this.policy.maxOpportunities) return;

    opportunities.splice(index, 0, opportunity);
    opportunities.length = Math.min(opportunities.length, this.policy.maxOpportunities);
  }
}
