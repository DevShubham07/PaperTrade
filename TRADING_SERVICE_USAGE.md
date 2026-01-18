# Polymarket Trading Service - Usage Guide

## Overview

The `PolymarketTradingService` is a comprehensive, modular trading service that provides all order types and cancellation methods for Polymarket CLOB. It's designed to be reusable across all your bot implementations.

## Quick Start

```typescript
import { PolymarketTradingService } from './services/polymarketTradingService';

// Initialize the service
const tradingService = new PolymarketTradingService();
await tradingService.initialize();

// Place a GTC order
const response = await tradingService.placeGTCOrder({
    tokenID: "YOUR_TOKEN_ID",
    price: 0.65,
    size: 10,
    side: 'BUY'
});

console.log(`Order placed! ID: ${response.orderID}`);
```

## Order Types

### 1. GTC (Good-Til-Cancelled) Orders

Orders remain active until filled or cancelled.

```typescript
const response = await tradingService.placeGTCOrder({
    tokenID: "YOUR_TOKEN_ID",
    price: 0.65,
    size: 10,
    side: 'BUY',
    feeRateBps: 0,  // Optional, defaults to 0
    nonce: 1        // Optional
});
```

### 2. GTD (Good-Til-Date) Orders

Orders expire at a specified timestamp. **Note**: There's a 1-minute security threshold. If you want an order to expire in 30 seconds, set expiration to: `now + 1 minute + 30 seconds`.

```typescript
const expiration = Math.floor((Date.now() + 90 * 1000) / 1000); // 90 seconds from now

const response = await tradingService.placeGTDOrder({
    tokenID: "YOUR_TOKEN_ID",
    price: 0.65,
    size: 10,
    side: 'BUY',
    expiration: expiration  // Required for GTD
});
```

### 3. FOK (Fill-Or-Kill) Market Orders

Must be filled immediately in its entirety, otherwise cancelled.

```typescript
const response = await tradingService.placeFOKOrder({
    tokenID: "YOUR_TOKEN_ID",
    amount: 100,  // For BUY: dollar amount, For SELL: number of shares
    side: 'BUY',
    price: 0.65   // Optional reference price
});
```

### 4. FAK (Fill-And-Kill) Market Orders

Executes immediately for as many shares as available, cancels the rest.

```typescript
const response = await tradingService.placeFAKOrder({
    tokenID: "YOUR_TOKEN_ID",
    amount: 100,
    side: 'BUY',
    price: 0.65
});
```

## Batch Orders

Place up to 15 orders in a single batch request. All orders must be of the same type.

```typescript
const responses = await tradingService.placeBatchOrders({
    orders: [
        {
            tokenID: "TOKEN_1",
            price: 0.4,
            size: 100,
            side: 'BUY'
        },
        {
            tokenID: "TOKEN_1",
            price: 0.45,
            size: 100,
            side: 'BUY'
        },
        {
            tokenID: "TOKEN_1",
            price: 0.55,
            size: 100,
            side: 'SELL'
        }
    ],
    orderType: 'GTC'  // All orders must be same type
});
```

## Order Cancellation

### Cancel Single Order

```typescript
const result = await tradingService.cancelOrder("ORDER_ID");
console.log(`Canceled: ${result.canceled}`);
console.log(`Not canceled: ${result.not_canceled}`);
```

### Cancel Multiple Orders

```typescript
const result = await tradingService.cancelOrders([
    "ORDER_ID_1",
    "ORDER_ID_2",
    "ORDER_ID_3"
]);
```

### Cancel All Orders

```typescript
const result = await tradingService.cancelAllOrders();
console.log(`Canceled ${result.canceled.length} orders`);
```

### Cancel Market Orders

Cancel all orders for a specific market or token.

```typescript
// Cancel by market (condition ID)
const result = await tradingService.cancelMarketOrders({
    market: "CONDITION_ID"
});

// Cancel by token ID
const result = await tradingService.cancelMarketOrders({
    asset_id: "TOKEN_ID"
});
```

## Order Queries

### Get Order Details

```typescript
const order = await tradingService.getOrder("ORDER_ID");
console.log(`Status: ${order.status}`);
console.log(`Price: ${order.price}`);
console.log(`Size: ${order.original_size}`);
```

### Get All Open Orders

```typescript
// Get all open orders
const orders = await tradingService.getOpenOrders();

// Filter by market
const orders = await tradingService.getOpenOrders({
    market: "CONDITION_ID"
});

// Filter by token
const orders = await tradingService.getOpenOrders({
    asset_id: "TOKEN_ID"
});
```

### Get Trade History

```typescript
// Get all trades
const trades = await tradingService.getTrades();

// Filter by market
const trades = await tradingService.getTrades({
    market: "CONDITION_ID"
});

// Filter by date range
const trades = await tradingService.getTrades({
    before: "2024-01-01T00:00:00Z",
    after: "2024-01-01T00:00:00Z"
});
```

## Balance and Allowance

### Get Balance and Allowance

```typescript
// Check USDC balance (collateral)
const collateral = await tradingService.getBalanceAllowance({
    asset_type: 'COLLATERAL'
});
console.log(`USDC Balance: ${collateral.balance}`);
console.log(`USDC Allowance: ${collateral.allowance}`);

// Check conditional token balance
const conditional = await tradingService.getBalanceAllowance({
    asset_type: 'CONDITIONAL',
    token_id: "TOKEN_ID"
});
console.log(`Token Balance: ${conditional.balance}`);
```

### Update Cached Balance

```typescript
await tradingService.updateBalanceAllowance({
    asset_type: 'COLLATERAL'
});
```

## Advanced Usage

### Create Order Without Posting

Create and sign an order without immediately posting it. Useful for batch operations.

```typescript
// Create limit order
const signedOrder = await tradingService.createOrder({
    tokenID: "TOKEN_ID",
    price: 0.65,
    size: 10,
    side: 'BUY'
});

// Post it later
const response = await tradingService.postOrder(signedOrder, 'GTC');
```

### Create Market Order Without Posting

```typescript
const signedOrder = await tradingService.createMarketOrder({
    tokenID: "TOKEN_ID",
    amount: 100,
    side: 'BUY'
});

// Post as FOK
const response = await tradingService.postOrder(signedOrder, 'FOK');
```

### Post Multiple Pre-signed Orders

```typescript
const orders = [
    { order: signedOrder1, orderType: 'GTC' as const },
    { order: signedOrder2, orderType: 'GTC' as const },
    { order: signedOrder3, orderType: 'GTC' as const }
];

const responses = await tradingService.postBatchOrders(orders);
```

## Error Handling

All methods throw errors that should be caught:

```typescript
try {
    const response = await tradingService.placeGTCOrder({
        tokenID: "TOKEN_ID",
        price: 0.65,
        size: 10,
        side: 'BUY'
    });
} catch (error: any) {
    if (error.message.includes('L2_AUTH_NOT_AVAILABLE')) {
        console.error('API credentials not initialized');
    } else if (error.message.includes('insufficient balance')) {
        console.error('Not enough funds');
    } else {
        console.error('Order failed:', error.message);
    }
}
```

## Common Error Messages

- **`L2_AUTH_NOT_AVAILABLE`**: API credentials not initialized. Make sure `initialize()` was called.
- **`INVALID_ORDER_NOT_ENOUGH_BALANCE`**: Insufficient balance or allowance
- **`INVALID_ORDER_MIN_TICK_SIZE`**: Price doesn't meet minimum tick size requirements
- **`INVALID_ORDER_MIN_SIZE`**: Order size below minimum threshold
- **`FOK_ORDER_NOT_FILLED_ERROR`**: FOK order couldn't be fully filled

## Singleton Pattern

For convenience, you can use the singleton instance:

```typescript
import { getTradingService } from './services/polymarketTradingService';

const tradingService = await getTradingService();
// Service is already initialized
```

## Complete Example

```typescript
import { PolymarketTradingService } from './services/polymarketTradingService';

async function tradeExample() {
    const tradingService = new PolymarketTradingService();
    await tradingService.initialize();

    // Check balance
    const balance = await tradingService.getBalanceAllowance({
        asset_type: 'COLLATERAL'
    });
    console.log(`USDC Balance: ${balance.balance}`);

    // Place a buy order
    const buyResponse = await tradingService.placeGTCOrder({
        tokenID: "YOUR_TOKEN_ID",
        price: 0.65,
        size: 10,
        side: 'BUY'
    });
    console.log(`Buy order placed: ${buyResponse.orderID}`);

    // Check open orders
    const openOrders = await tradingService.getOpenOrders();
    console.log(`Open orders: ${openOrders.length}`);

    // Cancel order if needed
    if (openOrders.length > 0) {
        await tradingService.cancelOrder(openOrders[0].id);
    }

    // Place a market order
    const marketResponse = await tradingService.placeFOKOrder({
        tokenID: "YOUR_TOKEN_ID",
        amount: 50,
        side: 'SELL'
    });
    console.log(`Market order executed: ${marketResponse.orderID}`);
}

tradeExample();
```

## Integration with Existing Code

The service is already integrated into:
- `src/execution.ts` - ExecutionGateway
- `src/services/tradingService.ts` - TradingService
- `src/oracle.ts` - DataOracle
- `src/services/orderBookService.ts` - OrderBookService

All these services now use the proper ClobClient initialization with L2 authentication.

