/**
 * Polymarket Real-Time Data Client
 * WebSocket client for fetching real-time crypto prices from Polymarket
 */

import WebSocket from 'ws';

export interface Message {
    topic: string;
    type: string;
    payload: CryptoPrice | CryptoPriceHistorical;
}

export interface CryptoPrice {
    symbol: string;
    timestamp: number;
    value: number;
}

export interface CryptoPriceHistorical {
    symbol: string;
    data: Array<{ timestamp: number; value: number }>;
}

export interface Subscription {
    topic: string;
    type: string;
    filters?: string;
    clob_auth?: {
        key: string;
        secret: string;
        passphrase: string;
    };
}

export interface SubscribeRequest {
    subscriptions: Subscription[];
}

export interface RealTimeDataClientConfig {
    onMessage?: (message: Message) => void;
    onConnect?: (client: RealTimeDataClient) => void;
    onError?: (error: Error) => void;
    onDisconnect?: () => void;
    wsUrl?: string;
}

/**
 * Real-Time Data Client for Polymarket WebSocket service
 */
export class RealTimeDataClient {
    private ws: WebSocket | null = null;
    private config: RealTimeDataClientConfig;
    private wsUrl: string;
    private reconnectInterval: NodeJS.Timeout | null = null;
    private isConnected: boolean = false;

    constructor(config: RealTimeDataClientConfig) {
        this.config = config;
        // WebSocket URL for Polymarket real-time data streaming (RTDS)
        // Official endpoint: wss://ws-live-data.polymarket.com
        this.wsUrl = config.wsUrl || 'wss://ws-live-data.polymarket.com';
    }

    /**
     * Connect to the WebSocket server
     */
    connect(): void {
        try {
            this.ws = new WebSocket(this.wsUrl);

            this.ws.on('open', () => {
                this.isConnected = true;
                console.log('🔗 Polymarket Real-Time Data WebSocket connected');
                
                if (this.config.onConnect) {
                    this.config.onConnect(this);
                }
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                try {
                    const rawMessage = data.toString();
                    // Debug: log first few messages to understand format
                    if (rawMessage) {
                        const message = JSON.parse(rawMessage);
                        // Log the message structure for debugging
                        console.log('📨 Received message:', JSON.stringify(message, null, 2));
                        
                        if (this.config.onMessage) {
                            this.config.onMessage(message as Message);
                        }
                    }
                } catch (error) {
                    console.error('❌ Error parsing WebSocket message:', error);
                    console.error('Raw message:', data.toString());
                }
            });

            this.ws.on('error', (error: Error) => {
                console.error('❌ Polymarket WebSocket error:', error);
                this.isConnected = false;
                
                if (this.config.onError) {
                    this.config.onError(error);
                }
            });

            this.ws.on('close', () => {
                console.warn('⚠️ Polymarket WebSocket closed. Reconnecting in 5s...');
                this.isConnected = false;
                
                if (this.config.onDisconnect) {
                    this.config.onDisconnect();
                }
                
                // Auto-reconnect
                this.reconnectInterval = setTimeout(() => this.connect(), 5000);
            });

        } catch (error) {
            console.error('❌ Failed to connect to Polymarket WebSocket:', error);
            this.reconnectInterval = setTimeout(() => this.connect(), 5000);
        }
    }

    /**
     * Subscribe to topics
     */
    subscribe(request: SubscribeRequest): void {
        if (!this.ws || !this.isConnected) {
            console.warn('⚠️ WebSocket not connected. Subscription will be sent after connection.');
            // Store subscription to send after connection
            const originalConnect = this.config.onConnect;
            this.config.onConnect = (client: RealTimeDataClient) => {
                if (originalConnect) {
                    originalConnect(client);
                }
                // Send subscription after connection
                setTimeout(() => {
                    this.subscribe(request);
                }, 100);
            };
            return;
        }

        try {
            const subscribeMessage = JSON.stringify(request);
            this.ws.send(subscribeMessage);
            console.log('📡 Subscribed to:', request.subscriptions.map(s => `${s.topic}:${s.type}`).join(', '));
        } catch (error) {
            console.error('❌ Error sending subscription:', error);
        }
    }

    /**
     * Unsubscribe from topics (same as subscribe, but typically removes the subscription)
     */
    unsubscribe(request: SubscribeRequest): void {
        // Unsubscribe is typically the same as subscribe in WebSocket protocols
        // Some implementations may require a different message format
        this.subscribe(request);
    }

    /**
     * Disconnect from the WebSocket server
     */
    disconnect(): void {
        if (this.reconnectInterval) {
            clearTimeout(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        
        this.isConnected = false;
        console.log('🔌 Polymarket Real-Time Data WebSocket disconnected');
    }

    /**
     * Check if connected
     */
    getConnected(): boolean {
        return this.isConnected;
    }
}

