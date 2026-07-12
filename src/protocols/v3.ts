import { V3_POOLS } from '../constants';
import { loadConfiguredV3StartupState } from '../market/v3-loader';
import { type ProtocolPlugin } from './protocol-plugin';

export const v3Plugin: ProtocolPlugin = {
  id: 'v3',
  count: catalog => catalog.v3Pools.length,
  async discover({ catalog }) {
    catalog.v3Pools = V3_POOLS.filter(pool => pool.enabled);
  },
  async hydrate({ client, catalog, engine }) {
    await loadConfiguredV3StartupState(client, engine, catalog.v3Pools);
  },
};
