import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, TOKENS } from '../constants';
import { MarketGraph } from '../market-graph/market-graph';
import { MarketRouteSizer } from '../market-graph/route-sizer';
import { type ArbitrageSearchPolicy, type FlashPoolCandidate } from '../market-graph/types';
import { V2Market } from '../market/v2-market';
import { type PairInfo, type ReserveUpdate } from '../market/v2-types';
import { V3Market } from '../market/v3-market';
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
  private readonly sizer: MarketRouteSizer;

  constructor(
    private readonly policy: ArbitrageSearchPolicy = ARBITRAGE_SEARCH_POLICY,
    market: V2Market | MarketGraph = new V2Market(),
    v3Market = new V3Market()
  ) {
    this.graph = market instanceof MarketGraph
      ? market
      : new MarketGraph(policy, market, v3Market);
    this.strategy = new CircularArbitrageStrategy(this.graph, policy);
    this.sizer = new MarketRouteSizer(this.graph, policy);
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
    const opportunities = this.strategy.findCandidates(request)
      .map(candidate => this.sizeCandidate(candidate))
      .filter(opportunity => {
        const originToken = opportunity.path[0];
        const token = TOKENS.find(addr => addr.address === originToken);

        if (!token) {
          throw new Error(`No token config found for ${originToken}. Please update TOKENS in constants.ts.`);
        }

        return opportunity.profit > token.minProfit;
      })
      .sort((a, b) => {
        if (b.profit > a.profit) return 1;
        if (b.profit < a.profit) return -1;
        return 0;
      })
      .slice(0, this.policy.maxOpportunities);

    return {
      paths: opportunities.map(opportunity => opportunity.path),
      pairs: opportunities.map(opportunity => opportunity.pairs),
      protocols: opportunities.map(opportunity => opportunity.protocols ?? []),
      profits: opportunities.map(opportunity => opportunity.profit),
      optimalAmounts: opportunities.map(opportunity => opportunity.optimalInput),
      fees: opportunities.map(opportunity => opportunity.fees),
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
    if (!candidate.edgeIds || !candidate.protocols) {
      throw new Error('Candidate route is missing unified market edge metadata.');
    }

    const { profit, optimalInput, complete } = this.sizer.size({
      path: candidate.path,
      pools: candidate.pairs,
      directions: candidate.directions,
      edgeIds: candidate.edgeIds,
      protocols: candidate.protocols,
    });
    const fees = candidate.edgeIds.map(edgeId => {
      const edge = this.graph.edge(edgeId);
      if (!edge) throw new Error(`Missing market edge ${edgeId}`);
      return edge.fee;
    });

    return {
      ...candidate,
      profit: complete ? profit : 0n,
      optimalInput: complete ? optimalInput : 0n,
      fees,
    };
  }
}
