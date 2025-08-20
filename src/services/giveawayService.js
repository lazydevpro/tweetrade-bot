const { setupLogger } = require('../utils/logger');
const { Giveaway, getEnhancedBalance, sendTransaction, sendUSDTTransaction, getOrCreateWalletForUser } = require('./privyUserService');
const twitterService = require('./twitterService');
const { ethers } = require('ethers');

const logger = setupLogger();

/**
 * Parse tweet URL to extract tweet ID
 * Supports both twitter.com and x.com URLs
 */
function extractTweetIdFromUrl(tweetUrl) {
  const regex = /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/;
  const match = tweetUrl.match(regex);
  return match ? match[1] : null;
}

/**
 * Parse duration string (e.g., "24h", "12h", "48h") into milliseconds
 */
function parseDuration(durationStr) {
  const input = (durationStr || '').toString().trim().toLowerCase();
  // Accept forms like 24h, 30m, 1h, 90m
  let match = input.match(/^(\d+)([hm])$/);
  // Also accept phrases like "24 hours", "12 hour", "30 minutes", "45 mins"
  if (!match) {
    if (/^\d+\s*(hour|hours|hr|hrs)$/.test(input)) {
      const value = parseInt(input);
      return value * 60 * 60 * 1000;
    }
    if (/^\d+\s*(minute|minutes|min|mins)$/.test(input)) {
      const value = parseInt(input);
      return value * 60 * 1000;
    }
  }
  if (!match) {
    throw new Error('Invalid duration format. Use format like "24h" or "30m"');
  }
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  if (unit === 'h') {
    return value * 60 * 60 * 1000; // hours to milliseconds
  } else if (unit === 'm') {
    return value * 60 * 1000; // minutes to milliseconds
  }
  
  throw new Error('Invalid duration unit. Use "h" for hours or "m" for minutes');
}

/**
 * Create a new giveaway
 */
async function createGiveaway(creatorTwitterUserId, creatorUsername, params) {
  try {
    const { tweetUrl: rawTweetUrl, amount, token, winners, duration, currentTweetUrl, currentTweetId } = params;
    
    // Prefer provided tweet URL if valid, otherwise fall back to current tweet URL/ID if provided
    let tweetUrl = rawTweetUrl;
    const urlRegex = /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/;
    let tweetId = tweetUrl && urlRegex.test(tweetUrl) ? extractTweetIdFromUrl(tweetUrl) : null;

    // If both provided and current tweet are available but ambiguous (e.g., quote/media), prefer current
    if (tweetId && currentTweetId && tweetId !== currentTweetId) {
      // If the raw URL was not explicitly set by user (often parser hint like "this tweet"), prefer current
      const rawLooksExplicit = typeof rawTweetUrl === 'string' && urlRegex.test(rawTweetUrl);
      if (!rawLooksExplicit) {
        tweetId = currentTweetId;
        tweetUrl = currentTweetUrl || `https://x.com/${creatorUsername}/status/${currentTweetId}`;
      }
    }

    if (!tweetId) {
      // Try fallback from params if the handler provided it
      if (currentTweetUrl && urlRegex.test(currentTweetUrl)) {
        tweetUrl = currentTweetUrl;
        tweetId = extractTweetIdFromUrl(currentTweetUrl);
      } else if (currentTweetId) {
        tweetId = currentTweetId;
        tweetUrl = `https://x.com/${creatorUsername}/status/${currentTweetId}`;
      }
    }

    if (!tweetId) {
      throw new Error('Invalid tweet URL format. Please provide a valid Twitter/X URL.');
    }
    
    // Parse duration
    const durationMs = parseDuration(duration);
    const endTime = new Date(Date.now() + durationMs);
    
    // Calculate total prize amount
    const totalPrizeAmount = (parseFloat(amount) * parseInt(winners)).toString();
    
    // Get creator's wallet first
    const wallet = await getOrCreateWalletForUser(creatorTwitterUserId, creatorUsername);
    
    // Check creator's balance
    const balance = await getEnhancedBalance(wallet.address);
    let userBalance = 0;
    
    if (token.toUpperCase() === 'METIS') {
      userBalance = parseFloat(balance.metis);
    } else if (token.toUpperCase() === 'USDT') {
      userBalance = parseFloat(balance.usdt);
    } else {
      throw new Error('Unsupported token. Only METIS and USDT are supported.');
    }
    
    if (userBalance < parseFloat(totalPrizeAmount)) {
      throw new Error(`Insufficient ${token} balance. You have ${userBalance} ${token}, but need ${totalPrizeAmount} ${token} for this giveaway.`);
    }
    
    // Verify tweet exists and is accessible
    try {
      const tweet = await twitterService.getTweet(tweetId);
      if (!tweet) {
        throw new Error('Tweet not found or not accessible. Please check the URL.');
      }
    } catch (error) {
      logger.warn('Could not verify tweet existence:', { tweetId, error: error.message });
      // Continue anyway - the tweet might be private or have API limitations
    }
    
    // Create giveaway record
    const giveaway = new Giveaway({
      creatorTwitterUserId,
      creatorUsername,
      tweetUrl,
      tweetId,
      amount,
      token: token.toUpperCase(),
      winners: parseInt(winners),
      duration,
      endTime,
      totalPrizeAmount,
      status: 'active'
    });
    
    await giveaway.save();
    
    logger.info('Giveaway created successfully:', {
      giveawayId: giveaway._id,
      creator: creatorUsername,
      tweetId,
      amount,
      token,
      winners,
      endTime
    });
    
    return giveaway;
    
  } catch (error) {
    logger.error('Error creating giveaway:', { error: error.message, params });
    throw error;
  }
}

/**
 * Get tweet comments/replies for winner selection
 */
async function getTweetComments(tweetId) {
  try {
    // Get replies to the tweet
    const replies = await twitterService.getTweetReplies(tweetId);
    
    if (!replies || replies.length === 0) {
      logger.warn('No replies found for tweet:', { tweetId });
      return [];
    }
    
    // Filter out retweets and format the comments
    const comments = replies
      .filter(reply => !reply.referenced_tweets?.some(t => t.type === 'retweeted'))
      .map(reply => ({
        twitterUserId: reply.author_id,
        username: reply.username || `user_${reply.author_id}`,
        commentId: reply.id,
        commentText: reply.text,
        parsedAddress: extractEthereumAddress(reply.text)
      }));
    
    logger.info('Retrieved tweet comments:', { tweetId, commentCount: comments.length });
    return comments;
    
  } catch (error) {
    logger.error('Error getting tweet comments:', { tweetId, error: error.message });
    throw error;
  }
}

/**
 * Try to extract an Ethereum address from text
 */
function extractEthereumAddress(text) {
  if (!text) return null;
  const match = text.match(/0x[a-fA-F0-9]{40}/);
  return match ? match[0] : null;
}

/**
 * Select random winners from comments
 */
function selectRandomWinners(comments, winnersCount) {
  if (comments.length === 0) {
    return [];
  }
  
  if (comments.length <= winnersCount) {
    return comments; // Return all if not enough comments
  }
  
  // Shuffle array and take first winnersCount items
  const shuffled = [...comments].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, winnersCount);
}

/**
 * Process giveaway and select winners
 */
async function processGiveaway(giveawayId) {
  try {
    const giveaway = await Giveaway.findById(giveawayId);
    if (!giveaway || giveaway.status !== 'active') {
      logger.warn('Giveaway not found or not active:', { giveawayId });
      return null;
    }
    
    // Check if giveaway has ended
    if (new Date() < giveaway.endTime) {
      logger.info('Giveaway not yet ended:', { giveawayId, endTime: giveaway.endTime });
      return null;
    }
    
    // Get tweet comments
    let comments = await getTweetComments(giveaway.tweetId);

    // Try to fetch the original tweet to get its author (in case the creator is different)
    let originalTweetAuthorId = null;
    try {
      const originalTweet = await twitterService.getTweet(giveaway.tweetId);
      originalTweetAuthorId = originalTweet?.author_id || null;
    } catch (e) {
      logger.warn('Could not fetch original tweet author for exclusion', { giveawayId, tweetId: giveaway.tweetId, error: e.message });
    }

    // Enforce eligibility rules
    // - Exclude the bot account
    // - Exclude the giveaway creator
    // - Exclude the original tweet author (if known)
    // - Deduplicate by twitterUserId
    const botUserId = twitterService.userId || null;
    const creatorId = giveaway.creatorTwitterUserId;

    const uniqueByUser = new Map();
    for (const c of comments) {
      if (botUserId && c.twitterUserId === botUserId) continue;
      if (c.twitterUserId === creatorId) continue;
      if (originalTweetAuthorId && c.twitterUserId === originalTweetAuthorId) continue;
      if (!uniqueByUser.has(c.twitterUserId)) {
        uniqueByUser.set(c.twitterUserId, c);
      }
    }
    comments = Array.from(uniqueByUser.values());
    
    if (comments.length === 0) {
      // No comments found - mark as completed but with no winners
      giveaway.status = 'completed';
      giveaway.completedAt = new Date();
      await giveaway.save();
      
      logger.info('Giveaway completed with no participants:', { giveawayId });
      return { giveaway, winners: [], noParticipants: true };
    }
    
    // Select winners
    const selectedWinners = selectRandomWinners(comments, giveaway.winners);
    
    // Update giveaway with selected winners
    giveaway.selectedWinners = selectedWinners.map(winner => ({
      ...winner,
      transferStatus: 'pending'
    }));
    giveaway.status = 'completed';
    giveaway.completedAt = new Date();
    
    await giveaway.save();
    
    logger.info('Giveaway processed and winners selected:', {
      giveawayId,
      winnersSelected: selectedWinners.length,
      totalComments: comments.length
    });
    
    return { giveaway, winners: selectedWinners };
    
  } catch (error) {
    logger.error('Error processing giveaway:', { giveawayId, error: error.message });
    throw error;
  }
}

/**
 * Transfer prizes to winners
 */
async function transferPrizesToWinners(giveawayId) {
  try {
    const giveaway = await Giveaway.findById(giveawayId);
    if (!giveaway || giveaway.status !== 'completed') {
      logger.warn('Giveaway not found or not completed:', { giveawayId });
      return null;
    }
    
    const results = [];
    
    for (const winner of giveaway.selectedWinners) {
      if (winner.transferStatus !== 'pending') {
        continue; // Skip already processed transfers
      }
      
      try {
        // Create wallet for winner if it doesn't exist
        const { getOrCreateWalletForUser } = require('./privyUserService');
        const winnerWallet = await getOrCreateWalletForUser(winner.twitterUserId, winner.username);
        
        // Get creator's wallet to send from
        const creatorWallet = await getOrCreateWalletForUser(giveaway.creatorTwitterUserId);
        
        // Transfer prize
        let txResult;
        logger.info('Attempting to transfer prize', {
          giveawayId,
          winner: winner.username,
          amount: giveaway.amount,
          token: giveaway.token,
          fromWallet: creatorWallet.address,
          toWallet: winnerWallet.address
        });
        
        if (giveaway.token === 'METIS') {
          txResult = await sendTransaction(
            creatorWallet.id,
            winnerWallet.address,
            giveaway.amount
          );
        } else if (giveaway.token === 'USDT') {
          txResult = await sendUSDTTransaction(
            creatorWallet.id,
            winnerWallet.address,
            giveaway.amount
          );
        } else {
          throw new Error(`Unsupported token: ${giveaway.token}`);
        }
        
        if (txResult && txResult.hash) {
          // Update winner with transaction hash
          winner.txHash = txResult.hash;
          winner.transferStatus = 'completed';
          
          results.push({
            winner: winner.username,
            twitterUserId: winner.twitterUserId,
            amount: giveaway.amount,
            token: giveaway.token,
            txHash: txResult.hash,
            status: 'success'
          });
          
          logger.info('Prize transferred successfully:', {
            giveawayId,
            winner: winner.username,
            amount: giveaway.amount,
            token: giveaway.token,
            txHash: txResult.hash
          });
        } else {
          winner.transferStatus = 'failed';
          const errorMsg = 'Transaction failed - no transaction hash returned';
          results.push({
            winner: winner.username,
            twitterUserId: winner.twitterUserId,
            amount: giveaway.amount,
            token: giveaway.token,
            status: 'failed',
            error: errorMsg
          });
          
          logger.error('Transaction failed - no hash returned:', {
            giveawayId,
            winner: winner.username,
            amount: giveaway.amount,
            token: giveaway.token,
            txResult
          });
        }
        
      } catch (error) {
        winner.transferStatus = 'failed';
        results.push({
          winner: winner.username,
          twitterUserId: winner.twitterUserId,
          amount: giveaway.amount,
          token: giveaway.token,
          status: 'failed',
          error: error.message
        });
        
        logger.error('Error transferring prize to winner:', {
          giveawayId,
          winner: winner.username,
          error: error.message
        });
      }
    }
    
    // Save updated giveaway
    await giveaway.save();
    
    return { giveaway, transferResults: results };
    
  } catch (error) {
    logger.error('Error transferring prizes:', { giveawayId, error: error.message });
    throw error;
  }
}

/**
 * Get all active giveaways that need to be processed
 */
async function getActiveGiveaways() {
  try {
    const now = new Date();
    const activeGiveaways = await Giveaway.find({
      status: 'active',
      endTime: { $lte: now }
    }).sort({ endTime: 1 });
    
    return activeGiveaways;
  } catch (error) {
    logger.error('Error fetching active giveaways:', { error: error.message });
    throw error;
  }
}

/**
 * Cancel a giveaway (only by creator)
 */
async function cancelGiveaway(giveawayId, creatorTwitterUserId) {
  try {
    const giveaway = await Giveaway.findOne({
      _id: giveawayId,
      creatorTwitterUserId,
      status: 'active'
    });
    
    if (!giveaway) {
      throw new Error('Giveaway not found or you are not authorized to cancel it');
    }
    
    giveaway.status = 'cancelled';
    giveaway.completedAt = new Date();
    await giveaway.save();
    
    logger.info('Giveaway cancelled:', { giveawayId, creator: creatorTwitterUserId });
    return giveaway;
    
  } catch (error) {
    logger.error('Error cancelling giveaway:', { giveawayId, error: error.message });
    throw error;
  }
}

module.exports = {
  createGiveaway,
  processGiveaway,
  transferPrizesToWinners,
  getActiveGiveaways,
  cancelGiveaway,
  getTweetComments,
  selectRandomWinners,
  extractTweetIdFromUrl,
  parseDuration,
  extractEthereumAddress
};