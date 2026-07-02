import { createPublicClient, http, webSocket, createWalletClient, type Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sei } from 'viem/chains';
import { NETWORK, RUNTIME } from './constants';

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
  if (!NETWORK.rpcUrl || !NETWORK.privateKey) {
    throw new Error('Missing required environment variables: RPC_URL or PRIVATE_KEY');
  }

  // Initialize account from private key
  const account = privateKeyToAccount(NETWORK.privateKey as `0x${string}`);

  const chainConfig = {
    ...sei,
    id: NETWORK.chainId,
  };

  // Create public client for reading from the blockchain
  const client = createPublicClient({
    chain: chainConfig,
    transport: http(NETWORK.rpcUrl),
  });

  // Create wallet client for sending transactions
  const walletClient = createWalletClient({
    chain: chainConfig,
    transport: http(NETWORK.rpcUrl),
    account,
  });

  const config = {
    client,
    walletClient,
    account,
  };

  // Create WebSocket client if enabled and WSS_URL is available
  if (RUNTIME.websocketEnabled && NETWORK.wsUrl) {
    try {
      const wsClient = createPublicClient({
        chain: chainConfig,
        transport: webSocket(NETWORK.wsUrl),
      });
      console.log('WebSocket client initialized successfully');
      return {
        ...config,
        wsClient,
      };
    } catch (error) {
      console.error('Failed to initialize WebSocket client:', error);
      console.warn('Falling back to HTTP client for events');
    }
  }

  return config;
}

