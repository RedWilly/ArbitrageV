import { createPublicClient, http, webSocket, createWalletClient, type Account, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { cronos } from 'viem/chains';
import { RPC_URL, WSS_URL, PRIVATE_KEY, CHAIN_ID, WSS_ENABLED } from './constants';

// Network configuration type
export type NetworkConfig = {
  client: ReturnType<typeof createPublicClient>;
  wsClient?: ReturnType<typeof createPublicClient>; // Optional WebSocket client
  walletClient: ReturnType<typeof createWalletClient>;
  account: Account;
};

/**
 * Initialize network connections and wallet
 * @returns NetworkConfig object containing initialized clients and account
 * @throws Error if environment variables are not set
 */
export async function initializeNetwork(): Promise<NetworkConfig> {
  // Validate environment variables
  if (!RPC_URL || !PRIVATE_KEY) {
    throw new Error('Missing required environment variables: RPC_URL or PRIVATE_KEY');
  }

  // Initialize account from private key
  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  const chainConfig = {
    ...cronos,
    id: CHAIN_ID as number,
  };

  // Create public client for reading from the blockchain
  const client = createPublicClient({
    chain: chainConfig,
    transport: http(RPC_URL),
  });

  // Create wallet client for sending transactions
  const walletClient = createWalletClient({
    chain: chainConfig,
    transport: http(RPC_URL),
    account,
  });

  // Create WebSocket client if enabled and WSS_URL is available
  let wsClient: ReturnType<typeof createPublicClient> | undefined;
  
  if (WSS_ENABLED && WSS_URL) {
    try {
      wsClient = createPublicClient({
        chain: chainConfig,
        transport: webSocket(WSS_URL),
      });
      console.log('WebSocket client initialized successfully');
    } catch (error) {
      console.error('Failed to initialize WebSocket client:', error);
      console.warn('Falling back to HTTP client for events');
    }
  }

  return {
    client,
    wsClient,
    walletClient,
    account,
  };
}