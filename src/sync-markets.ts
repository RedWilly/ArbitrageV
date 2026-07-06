import { createPublicClient, http } from 'viem';
import { sei } from 'viem/chains';
import { CONTRACTS, NETWORK, RUNTIME, V3_POOLS } from './constants';
import { discoverV2PoolMetadata } from './getinfo';
import { filterDiscoveredMarkets, marketTokens } from './market-filter';
import { discoverCarbonPairs } from './market/carbon';
import { openMarketDb, replaceStoredCarbonPairs, replaceStoredPools, toStoredV2Pool, toStoredV3Pool } from './market-db';

async function main(): Promise<void> {
  if (!NETWORK.rpcUrl) throw new Error('RPC_URL is required');
  if (!CONTRACTS.flashQuery) throw new Error('UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS is required');

  const client = createPublicClient({
    chain: { ...sei, id: NETWORK.chainId },
    transport: http(NETWORK.rpcUrl),
  });

  const v2Pools = await discoverV2PoolMetadata(client);
  const v3Pools = V3_POOLS.filter(pool => pool.enabled);
  const carbonPairs = await discoverCarbonPairs(client, {
    allowedTokens: marketTokens(v2Pools, v3Pools),
  });
  const filtered = filterDiscoveredMarkets(v2Pools, v3Pools, carbonPairs);
  if (RUNTIME.debug) {
    console.log('Shared market filter:', {
      v2: `${v2Pools.length} -> ${filtered.v2Pools.length}`,
      v3: `${v3Pools.length} -> ${filtered.v3Pools.length}`,
      carbon: `${carbonPairs.length} -> ${filtered.carbonPairs.length}`,
    });
  }
  const db = openMarketDb();

  try {
    replaceStoredPools(db, [
      ...filtered.v2Pools.map(toStoredV2Pool),
      ...filtered.v3Pools.map(toStoredV3Pool),
    ]);
    replaceStoredCarbonPairs(db, filtered.carbonPairs);
  } finally {
    db.close();
  }

  console.log(`Stored ${filtered.v2Pools.length} V2 pools, ${filtered.v3Pools.length} V3 pools, and ${filtered.carbonPairs.length} Carbon pairs`);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
