/**
 * Polymarket Trading Service
 * Comprehensive, modular trading service with all order types and cancellation methods
 * Reusable across all bot implementations
 */

import { 
    ClobClient, 
    Side, 
    OrderType, 
    UserOrder, 
    UserMarketOrder,
    PostOrdersArgs,
    OrderResponse,
    OpenOrder,
    Trade
} from "@polymarket/clob-client";
import type { SignedOrder } from "@polymarket/order-utils";
import { createClobClient } from "../clobClientFactory";

// Cancel response type (not exported from clob-client)
export interface CancelOrdersResponse {
    canceled: string[];
    not_canceled: Record<string, any>;
}

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface LimitOrderParams {
    tokenID: string;
    price: number;
    size: number;
    side: 'BUY' | 'SELL';
    feeRateBps?: number;
    nonce?: number;
    expiration?: number;
    taker?: string;
}

export interface MarketOrderParams {
    tokenID: string;
    amount: number; // For BUY: dollar amount, For SELL: number of shares
    side: 'BUY' | 'SELL';
    price?: number; // Optional reference price
    feeRateBps?: number;
    nonce?: number;
    taker?: string;
}

export interface BatchOrderParams {
    orders: Array<{
        tokenID: string;
        price: number;
        size: number;
        side: 'BUY' | 'SELL';
        feeRateBps?: number;
        nonce?: number;
        expiration?: number;
        taker?: string;
    }>;
    orderType: 'GTC' | 'GTD' | 'FOK' | 'FAK';
}

export interface CancelMarketOrdersParams {
    market?: string; // Condition ID
    asset_id?: string; // Token ID
}

// ==========================================
// TRADING SERVICE CLASS
// ==========================================

export class PolymarketTradingService {
    private clobClient: ClobClient | null = null;
    private initialized: boolean = false;

    /**
     * Initialize the trading service (must be called before use)
     */
    async initialize(): Promise<void> {
        if (this.initialized && this.clobClient) {
            return;
        }

        this.clobClient = await createClobClient();
        this.initialized = true;
    }

    /**
     * Ensure client is initialized
     */
    private async ensureInitialized(): Promise<void> {
        if (!this.initialized || !this.clobClient) {
            await this.initialize();
        }
    }

    // ==========================================
    // SINGLE ORDER METHODS
    // ==========================================

    /**
     * Place a GTC (Good-Til-Cancelled) limit order
     * Order remains active until filled or cancelled
     */
    async placeGTCOrder(params: LimitOrderParams): Promise<OrderResponse> {
        await this.ensureInitialized();
        
        const response = await this.clobClient!.createAndPostOrder({
            tokenID: params.tokenID,
            price: params.price,
            size: params.size,
            side: params.side === 'BUY' ? Side.BUY : Side.SELL,
            feeRateBps: params.feeRateBps ?? 0,
            nonce: params.nonce,
            expiration: params.expiration,
            taker: params.taker,
        }, undefined, OrderType.GTC);

        return response;
    }

    /**
     * Place a GTD (Good-Til-Date) limit order
     * Order expires at the specified timestamp
     * Note: There's a 1-minute security threshold. If you want order to expire in 30 seconds,
     * set expiration to: now + 1 minute + 30 seconds
     */
    async placeGTDOrder(params: LimitOrderParams & { expiration: number }): Promise<OrderResponse> {
        await this.ensureInitialized();

        const response = await this.clobClient!.createAndPostOrder({
            tokenID: params.tokenID,
            price: params.price,
            size: params.size,
            side: params.side === 'BUY' ? Side.BUY : Side.SELL,
            feeRateBps: params.feeRateBps ?? 0,
            nonce: params.nonce,
            expiration: params.expiration,
            taker: params.taker,
        }, undefined, OrderType.GTD);

        return response;
    }

    /**
     * Place a FOK (Fill-Or-Kill) market order
     * Must be filled immediately in its entirety, otherwise cancelled
     */
    async placeFOKOrder(params: MarketOrderParams): Promise<OrderResponse> {
        await this.ensureInitialized();

        const response = await this.clobClient!.createAndPostMarketOrder({
            tokenID: params.tokenID,
            amount: params.amount,
            side: params.side === 'BUY' ? Side.BUY : Side.SELL,
            price: params.price,
            feeRateBps: params.feeRateBps ?? 0,
            nonce: params.nonce,
            taker: params.taker,
            orderType: OrderType.FOK,
        }, undefined, OrderType.FOK);

        return response;
    }

    /**
     * Place a FAK (Fill-And-Kill) market order
     * Executes immediately for as many shares as available, cancels the rest
     */
    async placeFAKOrder(params: MarketOrderParams): Promise<OrderResponse> {
        await this.ensureInitialized();

        const response = await this.clobClient!.createAndPostMarketOrder({
            tokenID: params.tokenID,
            amount: params.amount,
            side: params.side === 'BUY' ? Side.BUY : Side.SELL,
            price: params.price,
            feeRateBps: params.feeRateBps ?? 0,
            nonce: params.nonce,
            taker: params.taker,
            orderType: OrderType.FAK,
        }, undefined, OrderType.FAK);

        return response;
    }

    /**
     * Place a limit order with custom order type
     * Use this for maximum flexibility
     */
    async placeLimitOrder(
        params: LimitOrderParams, 
        orderType: 'GTC' | 'GTD' = 'GTC'
    ): Promise<OrderResponse> {
        if (orderType === 'GTD' && !params.expiration) {
            throw new Error('GTD orders require an expiration timestamp');
        }

        if (orderType === 'GTD') {
            return this.placeGTDOrder(params as LimitOrderParams & { expiration: number });
        } else {
            return this.placeGTCOrder(params);
        }
    }

    /**
     * Place a market order with custom order type
     */
    async placeMarketOrder(
        params: MarketOrderParams,
        orderType: 'FOK' | 'FAK' = 'FOK'
    ): Promise<OrderResponse> {
        if (orderType === 'FOK') {
            return this.placeFOKOrder(params);
        } else {
            return this.placeFAKOrder(params);
        }
    }

    /**
     * Create and sign an order without posting it
     * Useful for batch operations or custom order management
     */
    async createOrder(params: LimitOrderParams): Promise<SignedOrder> {
        await this.ensureInitialized();

        const order = await this.clobClient!.createOrder({
            tokenID: params.tokenID,
            price: params.price,
            size: params.size,
            side: params.side === 'BUY' ? Side.BUY : Side.SELL,
            feeRateBps: params.feeRateBps ?? 0,
            nonce: params.nonce,
            expiration: params.expiration,
            taker: params.taker,
        });

        return order;
    }

    /**
     * Create and sign a market order without posting it
     */
    async createMarketOrder(params: MarketOrderParams): Promise<SignedOrder> {
        await this.ensureInitialized();

        const order = await this.clobClient!.createMarketOrder({
            tokenID: params.tokenID,
            amount: params.amount,
            side: params.side === 'BUY' ? Side.BUY : Side.SELL,
            price: params.price,
            feeRateBps: params.feeRateBps ?? 0,
            nonce: params.nonce,
            taker: params.taker,
        });

        return order;
    }

    /**
     * Post a pre-signed order
     */
    async postOrder(
        signedOrder: SignedOrder,
        orderType: 'GTC' | 'GTD' | 'FOK' | 'FAK' = 'GTC'
    ): Promise<OrderResponse> {
        await this.ensureInitialized();

        const typeMap: Record<string, OrderType> = {
            'GTC': OrderType.GTC,
            'GTD': OrderType.GTD,
            'FOK': OrderType.FOK,
            'FAK': OrderType.FAK,
        };

        const response = await this.clobClient!.postOrder(signedOrder, typeMap[orderType]);
        return response;
    }

    // ==========================================
    // BATCH ORDER METHODS
    // ==========================================

    /**
     * Place multiple orders in a single batch (up to 15 orders)
     * All orders must be of the same type
     */
    async placeBatchOrders(params: BatchOrderParams): Promise<OrderResponse[]> {
        await this.ensureInitialized();

        if (params.orders.length > 15) {
            throw new Error('Batch orders limited to 15 orders maximum');
        }

        const typeMap: Record<string, OrderType> = {
            'GTC': OrderType.GTC,
            'GTD': OrderType.GTD,
            'FOK': OrderType.FOK,
            'FAK': OrderType.FAK,
        };

        const postOrdersArgs: PostOrdersArgs[] = await Promise.all(
            params.orders.map(async (order) => {
                const signedOrder = await this.clobClient!.createOrder({
                    tokenID: order.tokenID,
                    price: order.price,
                    size: order.size,
                    side: order.side === 'BUY' ? Side.BUY : Side.SELL,
                    feeRateBps: order.feeRateBps ?? 0,
                    nonce: order.nonce,
                    expiration: order.expiration,
                    taker: order.taker,
                });

                return {
                    order: signedOrder,
                    orderType: typeMap[params.orderType],
                };
            })
        );

        const responses = await this.clobClient!.postOrders(postOrdersArgs);
        return responses;
    }

    /**
     * Post multiple pre-signed orders in a batch
     */
    async postBatchOrders(
        orders: Array<{ order: SignedOrder; orderType: 'GTC' | 'GTD' | 'FOK' | 'FAK' }>
    ): Promise<OrderResponse[]> {
        await this.ensureInitialized();

        if (orders.length > 15) {
            throw new Error('Batch orders limited to 15 orders maximum');
        }

        const typeMap: Record<string, OrderType> = {
            'GTC': OrderType.GTC,
            'GTD': OrderType.GTD,
            'FOK': OrderType.FOK,
            'FAK': OrderType.FAK,
        };

        const postOrdersArgs: PostOrdersArgs[] = orders.map(({ order, orderType }) => ({
            order,
            orderType: typeMap[orderType],
        }));

        const responses = await this.clobClient!.postOrders(postOrdersArgs);
        return responses;
    }

    // ==========================================
    // ORDER CANCELLATION METHODS
    // ==========================================

    /**
     * Cancel a single order by order ID
     */
    async cancelOrder(orderID: string): Promise<CancelOrdersResponse> {
        await this.ensureInitialized();

        const response = await this.clobClient!.cancelOrder({ orderID });
        return response;
    }

    /**
     * Cancel multiple orders by order IDs
     */
    async cancelOrders(orderIDs: string[]): Promise<CancelOrdersResponse> {
        await this.ensureInitialized();

        const response = await this.clobClient!.cancelOrders(orderIDs);
        return response;
    }

    /**
     * Cancel all open orders
     */
    async cancelAllOrders(): Promise<CancelOrdersResponse> {
        await this.ensureInitialized();

        const response = await this.clobClient!.cancelAll();
        return response;
    }

    /**
     * Cancel all orders for a specific market
     * Can filter by market (condition ID) or asset_id (token ID)
     */
    async cancelMarketOrders(params: CancelMarketOrdersParams): Promise<CancelOrdersResponse> {
        await this.ensureInitialized();

        const response = await this.clobClient!.cancelMarketOrders({
            market: params.market,
            asset_id: params.asset_id,
        });

        return response;
    }

    // ==========================================
    // ORDER QUERY METHODS
    // ==========================================

    /**
     * Get details for a specific order
     */
    async getOrder(orderID: string): Promise<OpenOrder> {
        await this.ensureInitialized();

        const order = await this.clobClient!.getOrder(orderID);
        return order;
    }

    /**
     * Get all open orders
     * @param params Optional filters (id, market, asset_id)
     * @param onlyFirstPage If true, returns only first page of results
     */
    async getOpenOrders(params?: {
        id?: string;
        market?: string;
        asset_id?: string;
    }, onlyFirstPage: boolean = false): Promise<OpenOrder[]> {
        await this.ensureInitialized();

        const orders = await this.clobClient!.getOpenOrders(params, onlyFirstPage);
        return orders;
    }

    /**
     * Get trade history
     * @param params Optional filters
     * @param onlyFirstPage If true, returns only first page of results
     */
    async getTrades(params?: {
        id?: string;
        maker_address?: string;
        market?: string;
        asset_id?: string;
        before?: string;
        after?: string;
    }, onlyFirstPage: boolean = false): Promise<Trade[]> {
        await this.ensureInitialized();

        const trades = await this.clobClient!.getTrades(params, onlyFirstPage);
        return trades;
    }

    // ==========================================
    // BALANCE AND ALLOWANCE METHODS
    // ==========================================

    /**
     * Get balance and allowance for tokens
     */
    async getBalanceAllowance(params: {
        asset_type: 'COLLATERAL' | 'CONDITIONAL';
        token_id?: string;
    }): Promise<{ balance: string; allowance: string }> {
        await this.ensureInitialized();

        const { AssetType } = await import("@polymarket/clob-client");
        const assetType = params.asset_type === 'COLLATERAL' 
            ? AssetType.COLLATERAL 
            : AssetType.CONDITIONAL;

        const response = await this.clobClient!.getBalanceAllowance({
            asset_type: assetType,
            token_id: params.token_id,
        });

        return response;
    }

    /**
     * Update cached balance and allowance
     */
    async updateBalanceAllowance(params: {
        asset_type: 'COLLATERAL' | 'CONDITIONAL';
        token_id?: string;
    }): Promise<void> {
        await this.ensureInitialized();

        const { AssetType } = await import("@polymarket/clob-client");
        const assetType = params.asset_type === 'COLLATERAL' 
            ? AssetType.COLLATERAL 
            : AssetType.CONDITIONAL;

        await this.clobClient!.updateBalanceAllowance({
            asset_type: assetType,
            token_id: params.token_id,
        });
    }

    // ==========================================
    // UTILITY METHODS
    // ==========================================

    /**
     * Get the underlying ClobClient instance
     * Use with caution - prefer using service methods
     */
    async getClient(): Promise<ClobClient> {
        await this.ensureInitialized();
        return this.clobClient!;
    }
}

// ==========================================
// SINGLETON INSTANCE (Optional)
// ==========================================

let tradingServiceInstance: PolymarketTradingService | null = null;

/**
 * Get or create the singleton trading service instance
 */
export async function getTradingService(): Promise<PolymarketTradingService> {
    if (!tradingServiceInstance) {
        tradingServiceInstance = new PolymarketTradingService();
        await tradingServiceInstance.initialize();
    }
    return tradingServiceInstance;
}

