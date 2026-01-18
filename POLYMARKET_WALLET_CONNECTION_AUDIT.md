# Polymarket Wallet Connection Audit

## Executive Summary

**Status: ❌ INCORRECT IMPLEMENTATION**

Your current implementation is **missing critical L2 authentication credentials** required for placing trades on Polymarket's CLOB. While you have the wallet and funder address configured, you're not initializing the ClobClient with API credentials, which will cause all trading operations to fail.

---

## Current Implementation Analysis

### What You're Doing Now

In multiple files (`src/oracle.ts`, `src/execution.ts`, `src/services/tradingService.ts`, `src/services/orderBookService.ts`), you're initializing ClobClient like this:

```typescript
const wallet = new Wallet(CONFIG.SIGNER_PRIVATE_KEY);
this.clobClient = new ClobClient(
    'https://clob.polymarket.com',
    137, // Polygon Mainnet Chain ID
    wallet,
    undefined, // ❌ creds - MISSING!
    undefined, // ❌ signatureType - MISSING!
    CONFIG.PROXY_ADDRESS // ✅ funderAddress - CORRECT
);
```

### What's Wrong

1. **Missing API Credentials (`creds`)**: You're passing `undefined` for API credentials, but **L2 methods require API credentials** for authentication
2. **Missing Signature Type**: You're passing `undefined` for `signatureType`, but this is required to tell Polymarket whether you're using:
   - `0` = EOA (Externally Owned Account) - direct wallet signing
   - `2` = Deployed Safe proxy wallet - your case (since you have `PROXY_ADDRESS`)
3. **No API Key Creation**: You never call `createOrDeriveApiKey()` to generate the required API credentials

---

## What Polymarket Documentation Requires

### For L2 Methods (Trading Operations)

According to Polymarket's documentation, **all trading operations require L2 authentication**:

```typescript
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet
const signer = new Wallet(process.env.PRIVATE_KEY);

// ✅ STEP 1: Create or derive user API credentials
const tempClient = new ClobClient(HOST, CHAIN_ID, signer);
const apiCreds = await tempClient.createOrDeriveApiKey();

// ✅ STEP 2: Determine signature type
// 0 = EOA (direct wallet)
// 2 = Deployed Safe proxy wallet (your case)
const signatureType = 2; // Since you're using PROXY_ADDRESS

// ✅ STEP 3: Initialize trading client with credentials
const client = new ClobClient(
  HOST, 
  CHAIN_ID, 
  signer, 
  apiCreds,  // ✅ API credentials
  signatureType,  // ✅ Signature type
  process.env.FUNDER_ADDRESS // ✅ Funder address (your PROXY_ADDRESS)
);
```

### Signature Types Explained

- **`0`**: EOA (Externally Owned Account) - Your wallet directly signs transactions
  - Use when: Trading directly from your wallet without a proxy
  - Requires: Wallet to have funds and pay for gas

- **`2`**: Deployed Safe proxy wallet - Transactions go through a proxy contract
  - Use when: You have a deployed Safe proxy wallet (your case)
  - Requires: `FUNDER_ADDRESS` (your `PROXY_ADDRESS`) where funds are deposited
  - Benefits: Can use gas-less transactions via Polymarket's relayer

---

## Required Fixes

### 1. Add API Credentials to Config

Add these to your `.env` file and `src/config.ts`:

```typescript
// In src/config.ts
export interface BotConfig {
    // ... existing fields ...
    
    // Add these new fields:
    CLOB_API_KEY?: string;
    CLOB_SECRET?: string;
    CLOB_PASSPHRASE?: string;
}
```

### 2. Create API Credentials Helper Function

Create a new utility function to initialize the ClobClient correctly:

```typescript
// src/clobClientFactory.ts
import { ClobClient, ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { CONFIG } from "./config";

export async function createClobClient(): Promise<ClobClient> {
    const wallet = new Wallet(CONFIG.SIGNER_PRIVATE_KEY);
    const HOST = "https://clob.polymarket.com";
    const CHAIN_ID = 137;

    // Check if API credentials are already in config
    let apiCreds: ApiKeyCreds | undefined;
    
    if (CONFIG.CLOB_API_KEY && CONFIG.CLOB_SECRET && CONFIG.CLOB_PASSPHRASE) {
        // Use existing credentials
        apiCreds = {
            apiKey: CONFIG.CLOB_API_KEY,
            secret: CONFIG.CLOB_SECRET,
            passphrase: CONFIG.CLOB_PASSPHRASE
        };
    } else {
        // Create or derive new API credentials
        console.log("🔑 Creating/deriving API credentials...");
        const tempClient = new ClobClient(HOST, CHAIN_ID, wallet);
        apiCreds = await tempClient.createOrDeriveApiKey();
        
        // Log credentials so user can save them to .env
        console.log("✅ API Credentials generated:");
        console.log(`   CLOB_API_KEY=${apiCreds.apiKey}`);
        console.log(`   CLOB_SECRET=${apiCreds.secret}`);
        console.log(`   CLOB_PASSPHRASE=${apiCreds.passphrase}`);
        console.log("⚠️  Save these to your .env file to avoid regenerating!");
    }

    // Determine signature type based on whether we have a proxy
    const signatureType = CONFIG.PROXY_ADDRESS && 
                          CONFIG.PROXY_ADDRESS !== '0x0000000000000000000000000000000000000000' 
                          ? 2  // Deployed Safe proxy wallet
                          : 0; // EOA

    // Initialize the trading client
    const client = new ClobClient(
        HOST,
        CHAIN_ID,
        wallet,
        apiCreds,
        signatureType,
        CONFIG.PROXY_ADDRESS
    );

    return client;
}
```

### 3. Update All ClobClient Initializations

Replace all direct ClobClient initializations with the factory function:

**Before:**
```typescript
// src/execution.ts
constructor() {
    const wallet = new Wallet(CONFIG.SIGNER_PRIVATE_KEY);
    this.clobClient = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet,
        undefined,
        undefined,
        CONFIG.PROXY_ADDRESS
    );
}
```

**After:**
```typescript
// src/execution.ts
constructor() {
    // Note: This must be async or use a factory pattern
    // See "Async Initialization Pattern" below
}
```

**Better Pattern - Make constructor async or use init method:**

```typescript
// src/execution.ts
export class ExecutionGateway {
    private clobClient: ClobClient | null = null;

    // Factory method for async initialization
    static async create(): Promise<ExecutionGateway> {
        const instance = new ExecutionGateway();
        instance.clobClient = await createClobClient();
        return instance;
    }

    // Or use an init method
    async initialize(): Promise<void> {
        if (!this.clobClient) {
            this.clobClient = await createClobClient();
        }
    }
}
```

---

## Files That Need Updates

1. ✅ **`src/config.ts`** - Add API credential fields
2. ✅ **`src/clobClientFactory.ts`** - Create new factory function (NEW FILE)
3. ✅ **`src/oracle.ts`** - Update ClobClient initialization
4. ✅ **`src/execution.ts`** - Update ClobClient initialization
5. ✅ **`src/services/tradingService.ts`** - Update ClobClient initialization
6. ✅ **`src/services/orderBookService.ts`** - Update ClobClient initialization

---

## Error You'll Encounter Without This Fix

When you try to place orders, you'll get:

```
Error: L2_AUTH_NOT_AVAILABLE
```

This error means: "You forgot to call createOrDeriveApiKey(). Make sure you initialize the client with API credentials"

---

## Testing Your Fix

After implementing the fixes:

1. **First Run**: The code will generate API credentials and log them
2. **Save Credentials**: Copy the logged credentials to your `.env` file
3. **Subsequent Runs**: The code will use the saved credentials (faster startup)

### Test Order Placement

```typescript
// Test that orders can be placed
const client = await createClobClient();
const response = await client.createAndPostOrder({
    tokenID: "YOUR_TOKEN_ID",
    price: 0.65,
    size: 10,
    side: Side.BUY,
});
console.log(`Order placed! ID: ${response.orderID}`);
```

---

## Additional Considerations

### Balance and Allowance

Make sure your `PROXY_ADDRESS` (funder address) has:
- **For BUY orders**: USDC balance and allowance
- **For SELL orders**: Outcome tokens (conditional tokens) balance and allowance

Check balances:
```typescript
const balance = await client.getBalanceAllowance({
    asset_type: AssetType.COLLATERAL, // For USDC
    // or
    asset_type: AssetType.CONDITIONAL, // For outcome tokens
    token_id: "YOUR_TOKEN_ID" // Optional for conditional tokens
});
```

### Order Types

Your code uses `createAndPostOrder()` which defaults to **GTC (Good-Til-Cancelled)** orders. This is correct for your use case.

Available order types:
- **GTC**: Good-Til-Cancelled (default) - Active until filled or cancelled
- **GTD**: Good-Til-Date - Active until specified expiration
- **FOK**: Fill-Or-Kill - Must fill immediately or be cancelled
- **FAK**: Fill-And-Kill - Fill as much as possible immediately, cancel the rest

---

## Summary Checklist

- [ ] Add `CLOB_API_KEY`, `CLOB_SECRET`, `CLOB_PASSPHRASE` to config
- [ ] Create `src/clobClientFactory.ts` with proper initialization
- [ ] Update all ClobClient initializations to use factory
- [ ] Handle async initialization (factory pattern or init method)
- [ ] Set `signatureType = 2` (since you're using proxy wallet)
- [ ] Test order placement after fix
- [ ] Save generated API credentials to `.env` file

---

## Quick Reference: Correct Initialization

```typescript
// ✅ CORRECT WAY
const wallet = new Wallet(PRIVATE_KEY);
const tempClient = new ClobClient(HOST, CHAIN_ID, wallet);
const apiCreds = await tempClient.createOrDeriveApiKey();
const signatureType = 2; // For proxy wallet
const client = new ClobClient(
    HOST, 
    CHAIN_ID, 
    wallet, 
    apiCreds,      // ✅ Required
    signatureType, // ✅ Required
    FUNDER_ADDRESS // ✅ Your PROXY_ADDRESS
);

// ❌ WRONG WAY (what you have now)
const client = new ClobClient(
    HOST, 
    CHAIN_ID, 
    wallet, 
    undefined,     // ❌ Missing
    undefined,     // ❌ Missing
    PROXY_ADDRESS  // ✅ Correct
);
```

---

## Questions?

If you encounter issues:
1. Check that `PROXY_ADDRESS` is correct (find it at polymarket.com/settings)
2. Verify wallet has sufficient balance for gas (if not using relayer)
3. Ensure `PROXY_ADDRESS` has USDC/tokens deposited
4. Check that API credentials are valid (regenerate if needed)

