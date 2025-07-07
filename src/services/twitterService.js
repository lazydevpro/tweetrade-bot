const { TwitterApi } = require('twitter-api-v2');
const { setupLogger } = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const { getWalletForUser, getWalletByUsername, getOrCreateWalletForUser } = require('./privyUserService');

const logger = setupLogger();

/**
 * @file twitterService.js
 * @description Handles Twitter API interactions, including fetching mentions and user info for the bot.
 */

/**
 * TwitterService provides methods to interact with the Twitter API for mentions and user information.
 * @class
 */

class TwitterService {
  constructor() {
    if (!process.env.TWITTER_API_KEY || !process.env.TWITTER_API_SECRET || !process.env.TWITTER_ACCESS_TOKEN || !process.env.TWITTER_ACCESS_SECRET) {
      throw new Error('Twitter API credentials (API key, secret, access token, access secret) are not set in environment variables');
    }
    if (!process.env.TWITTER_USERNAME) {
      throw new Error('TWITTER_USERNAME is not set in environment variables');
    }

    this.client = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY,
      appSecret: process.env.TWITTER_API_SECRET,
      accessToken: process.env.TWITTER_ACCESS_TOKEN,
      accessSecret: process.env.TWITTER_ACCESS_SECRET,
    });
    this.username = process.env.TWITTER_USERNAME;
    this.userId = process.env.BOT_USER_ID || null; // Use env if available

    if (!this.userId) {
      logger.warn('BOT_USER_ID is not set in environment variables. Some features may not work as expected.');
    } else {
      logger.info('BOT_USER_ID loaded from environment', { userId: this.userId });
    }

    logger.info('TwitterService initialized', {
      username: this.username
    });
  }

  /**
   * Fetches recent mentions of the bot from Twitter.
   * @param {string|null} sinceTimestamp - Optional timestamp to fetch mentions since.
   * @returns {Promise<Array<object>>} Array of tweet objects.
   */
  async getMentions(sinceTimestamp = null) {
    // If MOCK_TWITTER is set, load from mock_mentions.json
    if (process.env.MOCK_TWITTER === '1') {
      const mockPath = path.join(__dirname, '../../mock_mentions.json');
      if (fs.existsSync(mockPath)) {
        const data = fs.readFileSync(mockPath, 'utf8');
        try {
          const tweets = JSON.parse(data);
          logger.info('Loaded mentions from mock_mentions.json', { count: tweets.length });
          return tweets;
        } catch (e) {
          logger.error('Failed to parse mock_mentions.json', { error: e.message });
          return [];
        }
      } else {
        logger.warn('mock_mentions.json not found, returning empty list');
        return [];
      }
    }
    try {
      logger.info('Fetching mentions', {
        username: this.username,
        sinceTimestamp
      });
      logger.info('User ID:', this.userId);
      const params = {
        'max_results': 100,
        'tweet.fields': 'created_at,author_id,conversation_id,in_reply_to_user_id,entities',
        'expansions': 'author_id,entities.mentions.username',
        'user.fields': 'username,name'
      };
      if (sinceTimestamp) {
        // Twitter API expects RFC3339 timestamp for start_time
        params.start_time = new Date(new Date(sinceTimestamp).getTime() + 1000).toISOString();
      }

      const response = await this.client.v2.userMentionTimeline(this.userId, params);
      const tweets = [];
      // Map user id to user info for quick lookup
      const usersById = {};
      if (response.includes && response.includes.users) {
        for (const user of response.includes.users) {
          usersById[user.id] = user;
        }
      }
      for await (const tweet of response) {
        // Extract mentioned user IDs from entities.mentions
        let mentionedUsers = [];
        if (tweet.entities && tweet.entities.mentions) {
          mentionedUsers = tweet.entities.mentions.map(m => {
            // Try to find user info from includes
            const userInfo = Object.values(usersById).find(u => u.username.toLowerCase() === m.username.toLowerCase());
            return {
              username: m.username,
              id: userInfo ? userInfo.id : null,
              name: userInfo ? userInfo.name : null
            };
          });
        }
        tweets.push({
          id: tweet.id,
          text: tweet.text,
          author_id: tweet.author_id,
          created_at: tweet.created_at,
          in_reply_to_id: tweet.in_reply_to_user_id,
          conversation_id: tweet.conversation_id,
          mentioned_users: mentionedUsers
        });
      }

      logger.info('Successfully fetched mentions', {
        count: tweets.length,
        latest: tweets[0]?.id
      });

      // Save to mock_mentions.json for future mocking
      // const mockPath = path.join(__dirname, '../../mock_mentions.json');
      // fs.writeFileSync(mockPath, JSON.stringify(tweets, null, 2));
      return tweets;
    } catch (error) {
      logger.error('Error fetching mentions', {
        error: error.message,
        stack: error.stack
      });
      return [];
    }
  }

  /**
   * Fetches user info by Twitter user ID.
   * @param {string} userId - Twitter user ID.
   * @returns {Promise<{id: string, username: string, name?: string}|null>} User info or null.
   */
  async getUserInfo(userId) {
    console.log('getUserInfo', userId);
    // First try to get from DB
    let walletDoc;
    try {
      walletDoc = await getWalletForUser(userId);
    } catch (err) {
      logger.error('Error fetching wallet from DB in getUserInfo', { userId, error: err.message, stack: err.stack });
    }
    if (walletDoc && walletDoc.address && walletDoc.username) {
      return { id: userId, username: walletDoc.username };
    }
    // Fallback to Twitter API
    try {
      logger.info('Fetching user info', { userId });
      const user = await this.client.v2.user(userId, { 'user.fields': 'username,name' });
      if (!user.data) {
        logger.warn('No user data found', { userId });
        return null;
      }
      // Update DB with username if wallet exists
      if (walletDoc && user.data.username) {
        await getOrCreateWalletForUser(userId, user.data.username);
      }
      const userInfo = {
        id: user.data.id,
        username: user.data.username,
        name: user.data.name
      };
      logger.info('Successfully fetched user info', { user: userInfo });
      return userInfo;
    } catch (error) {
      logger.error('Error fetching user info', {
        userId,
        error: error.message
      });
      return null;
    }
  }

  async replyToTweet(inReplyToTweetId, text) {
    try {
      const response = await this.client.v2.tweet({
        text,
        reply: { in_reply_to_tweet_id: inReplyToTweetId }
      });
      logger.info('Successfully replied to tweet', { inReplyToTweetId, text, response });
      return response;
    } catch (error) {
      logger.error('Failed to reply to tweet', { inReplyToTweetId, text, error: error.message });
      throw error;
    }
  }

  /**
   * Fetches user info by Twitter username.
   * @param {string} username - Twitter username.
   * @returns {Promise<{id: string, username: string, name?: string}|null>} User info or null.
   */
  async getUserInfoByUsername(username) {
    // First try to get from DB
    let walletDoc;
    try {
      walletDoc = await getWalletByUsername(username);
      logger.info('walletDoc', walletDoc, username);
    } catch (err) {
      logger.error('Error fetching wallet from DB in getUserInfoByUsername', { username, error: err.message, stack: err.stack });
    }
    if (walletDoc && walletDoc.twitterUserId) {
      return { id: walletDoc.twitterUserId, username };
    }
    // Fallback to Twitter API
    try {
      logger.info('Fetching user info by username', { username });
      const user = await this.client.v2.userByUsername(username, { 'user.fields': 'username,name' });
      if (!user.data) {
        logger.warn('No user data found for username', { username });
        return null;
      }
      // Update DB with username if wallet exists
      if (user.data.id) {
        await getOrCreateWalletForUser(user.data.id, username);
      }
      return user.data;
    } catch (error) {
      logger.error('Error fetching user info by username', {
        username,
        error: error.message
      });
      return null;
    }
  }
}

module.exports = new TwitterService(); 