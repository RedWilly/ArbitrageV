import { configuredV3PoolMetadata } from './metadata';
import { loadConfiguredV3StartupState } from './runtime';
import { type ProtocolPlugin } from '../protocol-plugin';
import { v3FlashLoanFee } from './execution';
import { V3EventAdapter } from './runtime';

export const v3Plugin: ProtocolPlugin = {
  id: 'v3',
  contractId: 1,
  flashLoanFee: v3FlashLoanFee,
  count: catalog => catalog.v3Pools.length,
  async discover({ catalog }) {
    catalog.v3Pools = configuredV3PoolMetadata();
  },
  async hydrate({ client, catalog, engine }) {
    await loadConfiguredV3StartupState(client, engine, catalog.v3Pools);
  },
  events: context => new V3EventAdapter(context.client, context.engine, context.catalog.v3Pools, context.scan),
};
