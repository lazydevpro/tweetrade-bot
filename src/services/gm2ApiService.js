const axios = require('axios');
const { setupLogger } = require('../utils/logger');

const logger = setupLogger();

class Gm2ApiService {
  constructor() {
    this.baseUrl = (process.env.GM2_BASE_URL || 'https://staging-defai-api.gm2.social').replace(/\/$/, '');
  }

  async listTokens({ limit = 10, page = 1, sort = null } = {}) {
    const url = new URL('/v1/projects', this.baseUrl);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('page', String(page));
    if (sort) url.searchParams.set('sort', sort);
    try {
      const res = await axios.get(url.toString(), { headers: { 'Content-Type': 'application/json' } });
      // Return the data array from the response
      return res.data.data || [];
    } catch (error) {
      logger.error('GM2 listTokens error', { error: error.response?.data || error.message });
      throw new Error(error.response?.data?.message || 'Failed to list tokens');
    }
  }

  async getTokenDetail(idOrAddress) {
    const path = `/v1/projects/${idOrAddress}`;
    const url = `${this.baseUrl}${path}`;
    try {
      const res = await axios.get(url, { headers: { 'Content-Type': 'application/json' } });
      // Return the data object from the response
      return res.data.data || res.data;
    } catch (error) {
      logger.error('GM2 getTokenDetail error', { idOrAddress, error: error.response?.data || error.message });
      throw new Error(error.response?.data?.message || 'Failed to get token detail');
    }
  }

  async listTokensWithPagination({ limit = 10, page = 1, sort = null } = {}) {
    const url = new URL('/v1/projects', this.baseUrl);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('page', String(page));
    if (sort) url.searchParams.set('sort', sort);
    try {
      const res = await axios.get(url.toString(), { headers: { 'Content-Type': 'application/json' } });
      return {
        tokens: res.data.data || [],
        pagination: res.data.pagination || {}
      };
    } catch (error) {
      logger.error('GM2 listTokensWithPagination error', { error: error.response?.data || error.message });
      throw new Error(error.response?.data?.message || 'Failed to list tokens');
    }
  }
}

module.exports = new Gm2ApiService();

