import { discoverCarbonPairs, type CarbonStrategyStore } from '../market/carbon';
import { marketTokens } from '../market-filter';
import { type ProtocolPlugin } from './protocol-plugin';

export function createCarbonPlugin(store?: CarbonStrategyStore): ProtocolPlugin {
  return {
    id: 'carbon',
    count: catalog => catalog.carbonPairs.length,
    async discover({ client, catalog }) {
      catalog.carbonPairs = await discoverCarbonPairs(client, {
        allowedTokens: marketTokens(catalog.v2Pools, catalog.v3Pools),
      });
    },
    async hydrate() {
      await store?.loadAll();
    },
  };
}
