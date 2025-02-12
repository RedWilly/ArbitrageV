import { createPublicClient, http, createWalletClient, type Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { shibarium } from 'viem/chains';
import { RPC_URL, PRIVATE_KEY, CHAIN_ID } from './constants';

// Network configuration type
export type NetworkConfig = {
  client: ReturnType<typeof createPublicClient>;
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
    ...shibarium,
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

  return {
    client,
    walletClient,
    account,
  };
}