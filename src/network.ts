import { createPublicClient, http, webSocket, createWalletClient, type Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sei } from 'viem/chains';
import { NETWORK, RUNTIME } from './constants';

export type NetworkConfig = {
  client: ReturnType<typeof createPublicClient>;
  wsClient?: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: Account;
};

export async function initializeNetwork(): Promise<NetworkConfig> {
  if (!NETWORK.rpcUrl || !NETWORK.privateKey) {
    throw new Error('Missing required environment variables: RPC_URL or PRIVATE_KEY');
  }

  const account = privateKeyToAccount(NETWORK.privateKey as `0x${string}`);

  const chainConfig = {
    ...sei,
    id: NETWORK.chainId,
  };

  const client = createPublicClient({
    chain: chainConfig,
    transport: http(NETWORK.rpcUrl),
  });

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
