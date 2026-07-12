import { type MarketSnapshot } from '../market-db';
import { type MarketProtocol } from '../market-graph/types';
import { type OpportunityEngine } from '../opportunities/opportunity-engine';

export type MarketReadClient = {
  readContract(parameters: any): Promise<unknown>;
};

export type MarketDiscoveryContext = {
  client: MarketReadClient;
  catalog: MarketSnapshot;
};

export type MarketHydrationContext = MarketDiscoveryContext & {
  engine: OpportunityEngine;
};

export interface ProtocolPlugin {
  readonly id: MarketProtocol;
  count(catalog: MarketSnapshot): number;
  discover(context: MarketDiscoveryContext): Promise<void>;
  hydrate(context: MarketHydrationContext): Promise<void>;
}
