import { V3_POOLS } from './config';
import { loadConfiguredV3StartupState } from './runtime';
import { type ProtocolPlugin } from '../protocol-plugin';
import { v3FlashLoanFee } from './execution';
import { V3EventAdapter } from './live';

export const v3Plugin: ProtocolPlugin = {
  id: 'v3',
  contractId: 1,
  flashLoanFee: v3FlashLoanFee,
  count: catalog => catalog.v3Pools.length,
  async discover({ catalog }) {
    catalog.v3Pools = V3_POOLS.filter(pool => pool.enabled);
  },
  async hydrate({ client, catalog, engine }) {
    await loadConfiguredV3StartupState(client, engine, catalog.v3Pools);
  },
  events: context => new V3EventAdapter(context.client, context.engine, context.catalog.v3Pools, context.scan),
};
