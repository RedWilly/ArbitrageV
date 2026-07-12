import { type Address, type PublicClient } from 'viem';
import { type MarketSnapshot } from '../market-db';
import { type MarketProtocol } from '../market-graph/types';
import { type OpportunityEngine } from '../opportunities/opportunity-engine';
import { type ProtocolEventAdapter } from '../runtime/protocol-event-adapter';

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

export type MarketEventContext = {
  client: PublicClient<any, any, any>;
  catalog: MarketSnapshot;
  engine: OpportunityEngine;
  scan: (changedPairs: readonly string[], releasedPairs?: readonly Address[]) => Promise<void>;
};

export interface ProtocolPlugin {
  readonly id: MarketProtocol;
  readonly contractId: number;
  readonly flashLoanFee?: (fee: number, amount: bigint) => bigint;
  readonly flashRepayFee?: (fee: number) => bigint;
  count(catalog: MarketSnapshot): number;
  discover(context: MarketDiscoveryContext): Promise<void>;
  hydrate(context: MarketHydrationContext): Promise<void>;
  events(context: MarketEventContext): ProtocolEventAdapter | null;
}
