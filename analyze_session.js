const fs = require('fs');
const path = require('path');

const filePath = process.argv[2] || 'logs/trades_btc-updown-15m-1766318400_2025-12-21T12-00-03-533Z.json';

const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

console.log('\n' + '='.repeat(80));
console.log('TRADING SESSION ANALYSIS');
console.log('='.repeat(80));

console.log('\n📊 SESSION INFO:');
console.log(`   Market: ${data.session.marketSlug}`);
console.log(`   Duration: ${data.session.duration} seconds (${(data.session.duration / 60).toFixed(2)} minutes)`);
console.log(`   Start: ${new Date(data.session.startTime).toLocaleString()}`);
console.log(`   End: ${new Date(data.session.endTime).toLocaleString()}`);

console.log('\n📈 STATISTICS:');
console.log(`   Total Buy Orders Placed: ${data.statistics.totalBuyOrders}`);
console.log(`   Total Sell Orders Placed: ${data.statistics.totalSellOrders}`);
console.log(`   Executed Buy Orders: ${data.statistics.executedBuyOrders}`);
console.log(`   Executed Sell Orders: ${data.statistics.executedSellOrders}`);
console.log(`   Naked Positions: ${data.statistics.nakedPositions} (bought but never sold)`);
console.log(`   Total Trades: ${data.statistics.totalTrades}`);

console.log('\n💰 FINANCIAL SUMMARY:');
console.log(`   Total Invested: $${data.financial.totalInvested.toFixed(2)}`);
console.log(`   Total Proceeds: $${data.financial.totalProceeds.toFixed(2)}`);
console.log(`   Realized PNL: $${data.financial.realizedPNL.toFixed(2)} ✅`);
console.log(`   Unrealized PNL: $${data.financial.unrealizedPNL.toFixed(2)} (from naked positions)`);
console.log(`   Net PNL: $${data.financial.netPNL.toFixed(2)} ${data.financial.netPNL >= 0 ? '✅ PROFIT' : '❌ LOSS'}`);
console.log(`   ROI: ${data.financial.roi.toFixed(2)}%`);

console.log('\n✅ COMPLETED TRADES:');
console.log(`   Total Completed: ${data.completedTrades.length}`);
if (data.completedTrades.length > 0) {
    const avgPNL = data.completedTrades.reduce((sum, t) => sum + t.pnl, 0) / data.completedTrades.length;
    const avgROI = data.completedTrades.reduce((sum, t) => sum + t.roi, 0) / data.completedTrades.length;
    const winningTrades = data.completedTrades.filter(t => t.pnl > 0).length;
    const losingTrades = data.completedTrades.filter(t => t.pnl <= 0).length;
    
    console.log(`   Average PNL per Trade: $${avgPNL.toFixed(4)}`);
    console.log(`   Average ROI per Trade: ${avgROI.toFixed(2)}%`);
    console.log(`   Winning Trades: ${winningTrades} (${((winningTrades / data.completedTrades.length) * 100).toFixed(1)}%)`);
    console.log(`   Losing Trades: ${losingTrades} (${((losingTrades / data.completedTrades.length) * 100).toFixed(1)}%)`);
    
    console.log('\n   Sample Completed Trades (First 5):');
    data.completedTrades.slice(0, 5).forEach((trade, i) => {
        console.log(`   ${i + 1}. Buy @ $${trade.buyOrder.price.toFixed(4)} → Sell @ $${trade.sellOrder.price.toFixed(4)} | PNL: $${trade.pnl.toFixed(4)} | ROI: ${trade.roi.toFixed(2)}%`);
    });
}

console.log('\n⚠️  NAKED POSITIONS:');
console.log(`   Total Naked: ${data.nakedPositions.length}`);
if (data.nakedPositions.length > 0) {
    const totalNakedInvested = data.nakedPositions.reduce((sum, p) => sum + p.invested, 0);
    console.log(`   Total Invested in Naked Positions: $${totalNakedInvested.toFixed(2)}`);
    console.log(`   Average Price: $${(data.nakedPositions.reduce((sum, p) => sum + p.buyOrder.price, 0) / data.nakedPositions.length).toFixed(4)}`);
}

console.log('\n' + '='.repeat(80));
console.log('ANALYSIS COMPLETE');
console.log('='.repeat(80) + '\n');

