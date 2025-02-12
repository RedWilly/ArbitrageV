import { type Address, createPublicClient, http, parseAbiItem, formatUnits, parseGwei } from 'viem';
import { ArbitrageGraph } from './graph';
import { ARB_CONTRACT, DEBUG, BASE_FEE, MAX_FEE, MAX_PRIORITY_FEE } from './constants';
import ArbABI from './ABI/Arb.json';
import { type NetworkConfig } from './network';
import { NonceManager, createNonceManager } from './nonce';

interface ArbitrageOpportunity {
    path: Address[];
    pairs: Address[];
    fees: number[];
    optimalAmount: bigint;
    expectedProfit: bigint;
}

// Keeps track of executed pairs to avoid conflicts
class OpportunityManager {
    private usedPairs: Set<string> = new Set();
    private networkConfig: NetworkConfig;
    private nonceManager: NonceManager;

    constructor(networkConfig: NetworkConfig) {
        this.networkConfig = networkConfig;
        this.nonceManager = createNonceManager(networkConfig.account);
    }

    async initialize(): Promise<void> {
        // Initialize nonce manager
        await this.nonceManager.initialize(this.networkConfig.client);
    }

    // Check if an opportunity conflicts with already executed pairs
    private hasConflict(pairs: Address[]): boolean {
        return pairs.some(pair => this.usedPairs.has(pair.toLowerCase()));
    }
    // Mark pairs as used after execution
    private markPairsAsUsed(pairs: Address[]): void {
        pairs.forEach(pair => this.usedPairs.add(pair.toLowerCase()));
    }

    // Process and execute a batch of opportunities
    async processOpportunities(
        graph: ArbitrageGraph,
        opportunities: ArbitrageOpportunity[]
    ): Promise<void> {
        // Sort opportunities by expected profit (descending)
        const sortedOpps = [...opportunities].sort((a, b) => 
            Number(b.expectedProfit - a.expectedProfit)
        );

        if (DEBUG) {
            console.log(`Processing ${sortedOpps.length} opportunities in profit order`);
        }

        for (const opp of sortedOpps) {
            // Skip if any pairs conflict
            if (this.hasConflict(opp.pairs)) {
                if (DEBUG) {
                    console.log('Skipping opportunity due to pair conflict:', {
                        pairs: opp.pairs,
                        usedPairs: Array.from(this.usedPairs)
                    });
                }
                continue;
            }
            try {
                // Execute the opportunity
                await this.executeArbitrageOpportunity(graph, opp);

                // Mark pairs as used only after successful execution
                this.markPairsAsUsed(opp.pairs);
                if (DEBUG) {
                    console.log('Successfully executed opportunity:', {
                        profit: formatUnits(opp.expectedProfit, 18),
                        pairs: opp.pairs
                    });
                }
            } catch (error) {
                if (DEBUG) {
                    console.error('Failed to execute opportunity:', error);
                }
            }
        }
        
        // Clear used pairs after processing batch
        this.usedPairs.clear();
    }

    private async executeArbitrageOpportunity(
        graph: ArbitrageGraph,
        opportunity: ArbitrageOpportunity
    ): Promise<void> {
        const startToken = opportunity.path[0];
        const endToken = opportunity.path[opportunity.path.length - 1];
        const isCircular = startToken.toLowerCase() === endToken.toLowerCase();

        if (isCircular) {
            await this.executeWithFlashswap(graph, opportunity);
        } else {
            await this.executeDirectly(opportunity);
        }
    }

    private async executeWithFlashswap(
        graph: ArbitrageGraph,
        opportunity: ArbitrageOpportunity
    ): Promise<void> {
        if (!ARB_CONTRACT || !ARB_CONTRACT.match(/^0x[a-fA-F0-9]{40}$/)) {
            throw new Error('Invalid ARB_CONTRACT address');
        }

        const startToken = opportunity.path[0];

        // Find the best pair for flashswap
        const flashLoanPair = graph.findBestPairForToken(
            startToken,
            opportunity.optimalAmount,
            opportunity.pairs
        );

        if (!flashLoanPair) {
            throw new Error(`No suitable flashswap pair found for token ${startToken}`);
        }

        if (DEBUG) {
            console.log('Executing arbitrage with flashswap:', {
                flashLoanPair: flashLoanPair.pairAddress,
                startToken,
                borrowAmount: opportunity.optimalAmount.toString(),
                pairs: opportunity.pairs,
                fees: opportunity.fees,
                repayFee: flashLoanPair.fee,
                expectedProfit: formatUnits(opportunity.expectedProfit, 18)
            });
        }

        // Simulate first
        const { request } = await this.networkConfig.client.simulateContract({
            address: ARB_CONTRACT as Address,
            abi: ArbABI,
            functionName: 'executeArbitrage',
            args: [
                flashLoanPair.pairAddress,    // flashLoanPair
                startToken,                   // startToken
                opportunity.optimalAmount,    // borrowAmount
                opportunity.pairs,            // arbPairs
                opportunity.fees,             // arbFees
                flashLoanPair.fee             // repayFee
            ],
            account: this.networkConfig.account
        });

        // Get next nonce
        const nonce = this.nonceManager.getAndIncrement();

        // Prepare transaction parameters with EIP-1559 gas settings
        const txRequest = {
            ...request,
            nonce,
            maxFeePerGas: parseGwei(String(MAX_FEE)),
            maxPriorityFeePerGas: parseGwei(String(MAX_PRIORITY_FEE)),
            type: 'eip1559' as const
        };

        // Send transaction
        const hash = await this.networkConfig.walletClient.writeContract(txRequest);
        
        if (DEBUG) {
            console.log('Transaction sent:', {
                hash,
                nonce,
                type: 'flashswap',
                gas: `${BASE_FEE} Gwei`,
                maxFeePerGas: `${MAX_FEE} Gwei`,
                maxPriorityFeePerGas: `${MAX_PRIORITY_FEE} Gwei`
            });
        }
    }

    private async executeDirectly(
        opportunity: ArbitrageOpportunity
    ): Promise<void> {
        if (DEBUG) {
            console.log('Executing arbitrage directly:', {
                startToken: opportunity.path[0],
                startAmount: opportunity.optimalAmount.toString(),
                pairs: opportunity.pairs,
                fees: opportunity.fees,
                expectedProfit: formatUnits(opportunity.expectedProfit, 18)
            });
        }

        // Simulate first
        const { request } = await this.networkConfig.client.simulateContract({
            address: ARB_CONTRACT as Address,
            abi: ArbABI,
            functionName: 'executeArbitrageDirect',
            args: [
                opportunity.path[0],          // startToken
                opportunity.optimalAmount,    // startAmount
                opportunity.pairs,            // arbPairs
                opportunity.fees              // arbFees
            ],
            account: this.networkConfig.account
        });

        // Get next nonce
        const nonce = this.nonceManager.getAndIncrement();

        // Prepare transaction parameters with EIP-1559 gas settings
        const txRequest = {
            ...request,
            nonce,
            maxFeePerGas: parseGwei(String(MAX_FEE)),
            maxPriorityFeePerGas: parseGwei(String(MAX_PRIORITY_FEE)),
            type: 'eip1559' as const
        };

        // Send transaction
        const hash = await this.networkConfig.walletClient.writeContract(txRequest);

        if (DEBUG) {
            console.log('Transaction sent:', {
                hash,
                nonce,
                type: 'direct',
                gas: `${BASE_FEE} Gwei`,
                maxFeePerGas: `${MAX_FEE} Gwei`,
                maxPriorityFeePerGas: `${MAX_PRIORITY_FEE} Gwei`
            });
        }
    }
}

// Create and export the opportunity manager factory
export function createOpportunityManager(networkConfig: NetworkConfig): OpportunityManager {
    return new OpportunityManager(networkConfig);
}
