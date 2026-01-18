/**
 * Wallet Module
 * Handles wallet balance checks and account info via Polygon RPC
 */

import { ethers } from 'ethers';
import { CONFIG } from './config';

// USDC Token Contract on Polygon
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Minimal ERC20 ABI for balance checking
const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
];

export interface WalletBalances {
    address: string;
    proxyAddress: string;
    maticBalance: string;
    usdcBalance: string;
    usdcBalanceRaw: ethers.BigNumber;
}

export class WalletManager {
    private provider: ethers.providers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private usdcContract: ethers.Contract;

    constructor() {
        // Connect to Polygon RPC
        this.provider = new ethers.providers.JsonRpcProvider(CONFIG.POLYGON_RPC_URL);

        // Create wallet from private key
        const privateKey = CONFIG.SIGNER_PRIVATE_KEY.startsWith('0x')
            ? CONFIG.SIGNER_PRIVATE_KEY
            : `0x${CONFIG.SIGNER_PRIVATE_KEY}`;

        this.wallet = new ethers.Wallet(privateKey, this.provider);

        // Create USDC contract instance
        this.usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, this.provider);

        console.log('💳 Wallet Manager initialized');
    }

    /**
     * Get comprehensive wallet balances
     */
    async getBalances(): Promise<WalletBalances> {
        try {
            // Get MATIC balance
            const maticBalanceWei = await this.provider.getBalance(this.wallet.address);
            const maticBalance = ethers.utils.formatEther(maticBalanceWei);

            // Get USDC balance (6 decimals)
            const usdcBalanceRaw = await this.usdcContract.balanceOf(this.wallet.address);
            const usdcBalance = ethers.utils.formatUnits(usdcBalanceRaw, 6);

            return {
                address: this.wallet.address,
                proxyAddress: CONFIG.PROXY_ADDRESS,
                maticBalance: parseFloat(maticBalance).toFixed(4),
                usdcBalance: parseFloat(usdcBalance).toFixed(2),
                usdcBalanceRaw: usdcBalanceRaw
            };

        } catch (error) {
            console.error('❌ Error fetching wallet balances:', error);
            throw error;
        }
    }

    /**
     * Display wallet info in a formatted way
     */
    async displayBalances(): Promise<void> {
        try {
            console.log('');
            console.log('💰 ========================================');
            console.log('💰   WALLET BALANCES');
            console.log('💰 ========================================');

            const balances = await this.getBalances();

            console.log(`📍 EOA Address:   ${balances.address}`);
            console.log(`🔐 Proxy Address: ${balances.proxyAddress}`);
            console.log(`⛽ MATIC Balance:  ${balances.maticBalance} MATIC`);
            console.log(`💵 USDC Balance:   $${balances.usdcBalance} USDC`);
            console.log('💰 ========================================');
            console.log('');

        } catch (error) {
            console.error('❌ Failed to display balances');
        }
    }

    /**
     * Check if wallet has sufficient USDC for trading
     */
    async hasSufficientBalance(): Promise<boolean> {
        try {
            const balances = await this.getBalances();
            const usdcBalance = parseFloat(balances.usdcBalance);

            // Need at least MAX_CAPITAL_PER_TRADE in USDC
            const required = CONFIG.MAX_CAPITAL_PER_TRADE;

            if (usdcBalance < required) {
                console.warn(`⚠️ Insufficient USDC! Have: $${usdcBalance}, Need: $${required}`);
                return false;
            }

            return true;

        } catch (error) {
            console.error('❌ Error checking balance:', error);
            return false;
        }
    }

    /**
     * Get current network info
     */
    async getNetworkInfo(): Promise<void> {
        try {
            const network = await this.provider.getNetwork();
            console.log(`🌐 Network: ${network.name} (Chain ID: ${network.chainId})`);
        } catch (error) {
            console.error('❌ Error fetching network info:', error);
        }
    }

    /**
     * Get wallet address
     */
    getAddress(): string {
        return this.wallet.address;
    }

    /**
     * Get proxy address
     */
    getProxyAddress(): string {
        return CONFIG.PROXY_ADDRESS;
    }
}
