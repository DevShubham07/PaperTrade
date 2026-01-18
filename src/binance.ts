/**
 * Polymarket Real-Time Data Client Wrapper
 * Fast, real-time Bitcoin spot price feed using Polymarket's real-time data streaming
 */

import { RealTimeDataClient, Message } from '@polymarket/real-time-data-client';

interface CryptoPrice {
    symbol: string;
    timestamp: number;
    value: number;
}

interface CryptoPriceHistorical {
    symbol: string;
    data: Array<{ timestamp: number; value: number }>;
}

export class BinanceSocket {
    private client: RealTimeDataClient | null = null;
    private lastPrice: number = 0;
    private strikePrice: number = 0; // First price from historical data (strike price)
    private isConnected: boolean = false;
    private lastUpdateTime: number = 0;

    constructor() {
        // Connect to Polymarket real-time data streaming for BTCUSDT
        this.connect();
    }

    private connect(): void {
        this.client = new RealTimeDataClient({
            onMessage: (client: RealTimeDataClient, message: Message) => {
                this.handleMessage(message);
            },
            onConnect: (client: RealTimeDataClient) => {
                this.isConnected = true;
                console.log('🔗 Polymarket Real-Time Data WebSocket connected');
                
                // Subscribe to Chainlink BTC/USD prices (market resolves on Chainlink, not Binance!)
                // According to docs: Chainlink uses slash-separated format like "btc/usd"
                // Type should be "*" to get all types including initial data dump
                client.subscribe({
                    subscriptions: [
                        {
                            topic: 'crypto_prices_chainlink',
                            type: '*', // Get all types including initial historical data
                            filters: '{"symbol":"btc/usd"}', // JSON format for Chainlink (slash-separated)
                        },
                    ],
                });
                console.log('📡 Subscribed to: crypto_prices_chainlink:* with filter btc/usd (Chainlink - matches market resolution)');
            },
            onStatusChange: (status) => {
                if (status === 'DISCONNECTED') {
                    this.isConnected = false;
                    console.warn('⚠️ Polymarket WebSocket disconnected');
                } else if (status === 'CONNECTED') {
                    this.isConnected = true;
                }
            },
            autoReconnect: true,
        });

        this.client.connect();
    }

    private handleMessage(message: Message): void {
        try {
            // Handle Chainlink crypto price updates (real-time)
            if (message.topic === 'crypto_prices_chainlink' && message.type === 'update') {
                const priceData = message.payload as any;
                
                // Chainlink uses "btc/usd" format (slash-separated)
                if (priceData && priceData.symbol && priceData.symbol.toLowerCase() === 'btc/usd' && priceData.value > 0) {
                    const newPrice = priceData.value;
                    if (newPrice > 0 && newPrice !== this.lastPrice) {
                        this.lastPrice = newPrice;
                        this.lastUpdateTime = Date.now();
                        console.log(`💰 BTC price updated (Chainlink): $${this.lastPrice.toFixed(2)}`);
                    }
                }
            }
            // Handle initial data dump (historical data on connection)
            // Note: Sometimes comes as "crypto_prices" topic with "btc/usd" symbol (server inconsistency)
            else if (message.topic === 'crypto_prices_chainlink' || 
                     (message.topic === 'crypto_prices' && message.type === 'subscribe')) {
                const payload = message.payload as any;
                
                // Check if it's historical data format (type: "subscribe" sends this)
                // Chainlink uses "btc/usd" format
                if (payload && payload.symbol && payload.symbol.toLowerCase() === 'btc/usd' && Array.isArray(payload.data) && payload.data.length > 0) {
                    // Use the most recent price from historical data (current price)
                    const latestPrice = payload.data[payload.data.length - 1];
                    if (latestPrice && latestPrice.value > 0) {
                        this.lastPrice = latestPrice.value;
                        this.lastUpdateTime = Date.now();
                        console.log(`💰 Initial BTC price from Chainlink historical data: $${this.lastPrice.toFixed(2)}`);
                        
                        // Also store the first price (strike price) for potential use
                        const firstPrice = payload.data[0];
                        if (firstPrice && firstPrice.value > 0) {
                            this.strikePrice = firstPrice.value;
                            console.log(`🎯 Strike price from historical data: $${this.strikePrice.toFixed(2)}`);
                        }
                    }
                }
                // Also check if payload itself is the price data
                else if (payload && payload.symbol && payload.symbol.toLowerCase() === 'btc/usd' && payload.value > 0) {
                    this.lastPrice = payload.value;
                    this.lastUpdateTime = Date.now();
                    console.log(`💰 BTC price from Chainlink payload: $${this.lastPrice.toFixed(2)}`);
                }
            }
            // Log other messages for debugging (but not price updates - too frequent)
            else if (message.topic !== 'crypto_prices_chainlink' || message.type !== 'update') {
                console.log('📨 Received message:', JSON.stringify({
                    topic: message.topic,
                    type: message.type,
                    payload: message.payload
                }, null, 2));
            }
        } catch (error) {
            console.error('❌ Error handling message:', error);
            console.error('Message was:', JSON.stringify(message, null, 2));
        }
    }

    public getBTCPrice(): number {
        if (this.lastPrice === 0) {
            throw new Error('No price data available yet');
        }
        return this.lastPrice;
    }

    public isReady(): boolean {
        // Ready if we have any price
        return this.lastPrice > 0;
    }

    public getStrikePrice(): number {
        // Returns the strike price (first price from historical data) if available
        return this.strikePrice;
    }

    public disconnect(): void {
        if (this.client) {
            this.client.disconnect();
            this.client = null;
        }
        this.isConnected = false;
    }
}
