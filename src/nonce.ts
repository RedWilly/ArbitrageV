import { type Address } from 'viem';
import { DEBUG } from './constants';

export class NonceManager {
    private currentNonce: number | null = null;
    private readonly accountAddress: Address;

    constructor(account: Address | { address: Address }) {
        // Handle both Address string and Account object
        this.accountAddress = typeof account === 'string' ? account : account.address;
    }

    async initialize(client: any): Promise<void> {
        try {
            // Get initial nonce from blockchain
            this.currentNonce = Number(await client.getTransactionCount({
                address: this.accountAddress
            }));

            if (DEBUG) {
                console.log(`Initialized nonce manager with nonce: ${this.currentNonce}`);
            }
        } catch (error) {
            console.error('Failed to initialize nonce manager:', error);
            throw error;
        }
    }

    getAndIncrement(): number {
        if (this.currentNonce === null) {
            throw new Error('Nonce manager not initialized. Call initialize() first.');
        }

        const nonce = this.currentNonce;
        this.currentNonce++;

        if (DEBUG) {
            console.log(`Using nonce: ${nonce}, next nonce will be: ${this.currentNonce}`);
        }

        return nonce;
    }

    getCurrentNonce(): number {
        if (this.currentNonce === null) {
            throw new Error('Nonce manager not initialized. Call initialize() first.');
        }
        return this.currentNonce;
    }

    // Reset nonce (useful if we need to sync with chain)
    async reset(client: any): Promise<void> {
        await this.initialize(client);
    }
}

// Singleton instance
let nonceManager: NonceManager | null = null;

export function createNonceManager(account: Address | { address: Address }): NonceManager {
    if (!nonceManager) {
        nonceManager = new NonceManager(account);
    }
    return nonceManager;
}
