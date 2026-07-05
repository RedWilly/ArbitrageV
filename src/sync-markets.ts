import { createPublicClient, http } from 'viem';
import { sei } from 'viem/chains';
import { CONTRACTS, NETWORK, V3_POOLS } from './constants';
import { discoverV2PoolMetadata } from './getinfo';
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
  const carbonPairs = await discoverCarbonPairs(client);
  const db = openMarketDb();

  try {
    replaceStoredPools(db, [
      ...v2Pools.map(toStoredV2Pool),
      ...v3Pools.map(toStoredV3Pool),
    ]);
    replaceStoredCarbonPairs(db, carbonPairs);
  } finally {
    db.close();
  }

  console.log(`Stored ${v2Pools.length} V2 pools, ${v3Pools.length} V3 pools, and ${carbonPairs.length} Carbon pairs`);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
