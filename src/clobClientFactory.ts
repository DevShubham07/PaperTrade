/**
 * ClobClient Factory Module
 * Properly initializes ClobClient with L2 authentication credentials
 * Handles API key creation/derivation and signature type detection
 */

import { ClobClient, ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { CONFIG } from "./config";

let cachedClient: ClobClient | null = null;
let cachedApiCreds: ApiKeyCreds | null = null;
let apiCredsPromise: Promise<ApiKeyCreds> | null = null; // Lock to prevent concurrent creation

/**
 * Creates or retrieves API credentials for Polymarket CLOB
 * If credentials exist in config, uses them. Otherwise, generates new ones.
 * Uses a promise lock to prevent concurrent API key creation.
 */
export async function getApiCredentials(): Promise<ApiKeyCreds> {
    // Return cached credentials if available
    if (cachedApiCreds) {
        return cachedApiCreds;
    }

    // If credentials are being created, wait for that promise
    if (apiCredsPromise) {
        return apiCredsPromise;
    }

    // Check if credentials are already in config
    if (CONFIG.CLOB_API_KEY && CONFIG.CLOB_SECRET && CONFIG.CLOB_PASSPHRASE) {
        console.log("🔑 Using existing API credentials from config");
        cachedApiCreds = {
            key: CONFIG.CLOB_API_KEY,
            secret: CONFIG.CLOB_SECRET,
            passphrase: CONFIG.CLOB_PASSPHRASE
        };
        return cachedApiCreds;
    }

    // Generate new API credentials (with lock to prevent concurrent creation)
    console.log("🔑 Creating/deriving API credentials...");
    const wallet = new Wallet(CONFIG.SIGNER_PRIVATE_KEY);
    const tempClient = new ClobClient(
        "https://clob.polymarket.com",
        137,
        wallet
    );

    // Create a promise that will be shared by all concurrent callers
    apiCredsPromise = (async () => {
        try {
            const apiCreds = await tempClient.createOrDeriveApiKey();
            cachedApiCreds = apiCreds;

            // Log credentials so user can save them to .env
            console.log("✅ API Credentials generated successfully!");
            console.log("⚠️  Save these to your .env file to avoid regenerating:");
            console.log(`   CLOB_API_KEY=${apiCreds.key}`);
            console.log(`   CLOB_SECRET=${apiCreds.secret}`);
            console.log(`   CLOB_PASSPHRASE=${apiCreds.passphrase}`);

            return apiCreds;
        } catch (error: any) {
            console.error("❌ Failed to create/derive API credentials:", error.message);
            throw new Error(`API credential generation failed: ${error.message}`);
        } finally {
            // Clear the promise lock after completion
            apiCredsPromise = null;
        }
    })();

    return apiCredsPromise;
}

/**
 * Determines the correct signature type based on configuration
 * @returns 0 for EOA, 2 for deployed Safe proxy wallet
 */
export function getSignatureType(): number {
    // If PROXY_ADDRESS is set and not the default, use signature type 2 (Safe proxy)
    if (CONFIG.PROXY_ADDRESS && 
        CONFIG.PROXY_ADDRESS !== '0x0000000000000000000000000000000000000000') {
        return 2; // Deployed Safe proxy wallet
    }
    return 0; // EOA (Externally Owned Account)
}

let clientPromise: Promise<ClobClient> | null = null; // Lock to prevent concurrent client creation

/**
 * Creates a properly initialized ClobClient with L2 authentication
 * Caches the client instance for reuse
 * Uses a promise lock to prevent concurrent initialization
 */
export async function createClobClient(): Promise<ClobClient> {
    // Return cached client if available
    if (cachedClient) {
        return cachedClient;
    }

    // If client is being created, wait for that promise
    if (clientPromise) {
        return clientPromise;
    }

    // Create a promise that will be shared by all concurrent callers
    clientPromise = (async () => {
        const wallet = new Wallet(CONFIG.SIGNER_PRIVATE_KEY);
        const HOST = "https://clob.polymarket.com";
        const CHAIN_ID = 137;

        // Get API credentials (this also has its own lock)
        const apiCreds = await getApiCredentials();

        // Determine signature type
        const signatureType = getSignatureType();

        console.log(`🔐 Initializing ClobClient with signature type ${signatureType} (${signatureType === 2 ? 'Safe Proxy' : 'EOA'})`);

        // Initialize the trading client
        const client = new ClobClient(
            HOST,
            CHAIN_ID,
            wallet,
            apiCreds,
            signatureType,
            CONFIG.PROXY_ADDRESS !== '0x0000000000000000000000000000000000000000' 
                ? CONFIG.PROXY_ADDRESS 
                : undefined
        );

        cachedClient = client;
        console.log("✅ ClobClient initialized successfully");

        // Clear the promise lock after completion
        clientPromise = null;

        return client;
    })();

    return clientPromise;
}

/**
 * Resets the cached client (useful for testing or re-initialization)
 */
export function resetClobClient(): void {
    cachedClient = null;
    cachedApiCreds = null;
}

