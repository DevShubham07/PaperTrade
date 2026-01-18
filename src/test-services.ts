/**
 * Test script for modularized services
 * Tests fetching market data, spot price, strike price, and token prices
 */

import { SpotPriceService } from './services/spotPriceService';
import { MarketInfoService } from './services/marketInfoService';
import { OrderBookService } from './services/orderBookService';

async function testServices() {
    console.log('🧪 Testing Modularized Services...\n');

    // Initialize services
    const spotPriceService = new SpotPriceService();
    const marketInfoService = new MarketInfoService();
    const orderBookService = new OrderBookService();

    // Wait for spot price to be ready
    console.log('⏳ Waiting for spot price service...');
    await new Promise(resolve => {
        const checkReady = setInterval(() => {
            if (spotPriceService.isReady()) {
                clearInterval(checkReady);
                resolve(true);
            }
        }, 100);
    });

    // Test 1: Get BTC Spot Price
    console.log('\n📊 TEST 1: Fetch BTC Spot Price');
    console.log('=====================================');
    const spotPrice = spotPriceService.getBTCPrice();
    console.log(`✅ BTC Spot Price: $${spotPrice.toFixed(2)}`);

    // Test 2: Get Active Market Info
    console.log('\n🎯 TEST 2: Fetch Active Market Info');
    console.log('=====================================');
    const marketInfo = await marketInfoService.getActiveMarket();

    if (!marketInfo) {
        console.log('❌ No active market found');
        process.exit(1);
    }

    console.log(`✅ Market Found: ${marketInfo.eventSlug}`);
    console.log(`   Strike Price: $${marketInfo.strikePrice.toFixed(2)}`);
    console.log(`   UP Token ID: ${marketInfo.upTokenId}`);
    console.log(`   DOWN Token ID: ${marketInfo.downTokenId}`);
    console.log(`   End Date: ${marketInfo.endDate.toISOString()}`);
    console.log(`   Time Remaining: ${marketInfoService.getTimeRemaining().toFixed(1)} minutes`);

    // Test 3: Get Token Prices
    console.log('\n💰 TEST 3: Fetch UP/DOWN Token Prices');
    console.log('=====================================');

    try {
        const prices = await orderBookService.getCurrentPrices(
            marketInfo.upTokenId,
            marketInfo.downTokenId
        );

        console.log(`✅ Prices fetched at: ${prices.timestamp.toISOString()}`);
        console.log('\n   UP Token:');
        console.log(`      Buy Price (Ask):  $${prices.upAsk.toFixed(4)}`);
        console.log(`      Sell Price (Bid): $${prices.upBid.toFixed(4)}`);
        console.log(`      Spread:           $${(prices.upAsk - prices.upBid).toFixed(4)}`);

        console.log('\n   DOWN Token:');
        console.log(`      Buy Price (Ask):  $${prices.downAsk.toFixed(4)}`);
        console.log(`      Sell Price (Bid): $${prices.downBid.toFixed(4)}`);
        console.log(`      Spread:           $${(prices.downAsk - prices.downBid).toFixed(4)}`);

        // Test 4: Market Direction
        console.log('\n🧭 TEST 4: Market Direction Analysis');
        console.log('=====================================');
        const difference = spotPrice - marketInfo.strikePrice;
        const direction = difference >= 0 ? 'UP' : 'DOWN';
        const directionIcon = difference >= 0 ? '🟢' : '🔴';

        console.log(`   Spot Price:   $${spotPrice.toFixed(2)}`);
        console.log(`   Strike Price: $${marketInfo.strikePrice.toFixed(2)}`);
        console.log(`   Difference:   $${difference.toFixed(2)}`);
        console.log(`   Direction:    ${directionIcon} ${direction}`);
        console.log(`   ${direction} Token Price: $${direction === 'UP' ? prices.upAsk.toFixed(4) : prices.downAsk.toFixed(4)}`);

    } catch (error: any) {
        console.error(`❌ Error fetching token prices: ${error.message}`);
    }

    // Cleanup
    console.log('\n🧹 Cleaning up...');
    spotPriceService.disconnect();
    console.log('✅ All tests completed!');
    process.exit(0);
}

// Run tests
testServices().catch(error => {
    console.error('🔥 Test failed:', error);
    process.exit(1);
});
