import { discoverV2PoolMetadata, getKnownPairsInfo } from '../getinfo';
import { type ProtocolPlugin } from './protocol-plugin';

export const v2Plugin: ProtocolPlugin = {
  id: 'v2',
  count: catalog => catalog.v2Pools.length,
  async discover({ client, catalog }) {
    catalog.v2Pools = await discoverV2PoolMetadata(client);
  },
  async hydrate({ client, catalog, engine }) {
    const pairs = await getKnownPairsInfo(client, catalog.v2Pools);
    for (const pair of pairs) engine.addPair(pair);
  },
};
