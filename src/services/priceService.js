const axios = require('axios');
const { setupLogger } = require('../utils/logger');

const logger = setupLogger();

class PriceService {
  async getMetisUsdPrice() {
    try {
      // Use CoinGecko id for Metis: metis-token
      const url = 'https://api.coingecko.com/api/v3/simple/price?ids=metis-token&vs_currencies=usd';
      const res = await axios.get(url, { timeout: 5000 });
      const price = res.data?.['metis-token']?.usd;
      if (!price) throw new Error('No price in response');
      return Number(price);
    } catch (error) {
      logger.error('Failed to fetch METIS price from CoinGecko', { error: error.message });
      // Fallback to env override if provided
      const fallback = process.env.METIS_USD_PRICE_FALLBACK ? Number(process.env.METIS_USD_PRICE_FALLBACK) : null;
      if (!fallback) throw new Error('Price unavailable');
      return fallback;
    }
  }

  async convertUsdToMetis(usdAmount) {
    const price = await this.getMetisUsdPrice();
    return Number(usdAmount) / price;
  }

  async convertMetisToUsd(metisAmount) {
    const price = await this.getMetisUsdPrice();
    return Number(metisAmount) * price;
  }
}

module.exports = new PriceService();

