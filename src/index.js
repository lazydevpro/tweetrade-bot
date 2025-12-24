const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { setupLogger } = require('./utils/logger');
const { handleTweet } = require('./handlers/tweetHandler');
const twitterService = require('./services/twitterService');
const giveawayService = require('./services/giveawayService');
const { getRewardService } = require('./services/rewardService');

const logger = setupLogger();
const rewardService = getRewardService();

const STATE_FILE = path.join(__dirname, '..', 'last_processed_state.json');

// Keep track of the last processed tweet's timestamp
let lastProcessedTweetTimestamp = null;
let processedTweetIds = new Set();

// Concurrency guards to prevent overlapping runs that can cause double replies
let isCheckingMentions = false;
let isProcessingGiveaways = false;

function toIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

function computeStartTimestamp({ mode, lookbackSeconds, sinceTime }) {
  const now = Date.now();
  const lb = Math.max(0, lookbackSeconds ?? 0);
  if (mode === 'since') {
    if (!sinceTime) return new Date(now - lb * 1000).toISOString();
    const t = new Date(sinceTime);
    if (Number.isNaN(t.getTime())) return new Date(now - lb * 1000).toISOString();
    return t.toISOString();
  }
  // mode === 'fresh' or 'resume' default start is now - lookback
  return new Date(now - lb * 1000).toISOString();
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const state = JSON.parse(data);
      if (state.lastProcessedTweetTimestamp) {
        lastProcessedTweetTimestamp = state.lastProcessedTweetTimestamp;
        logger.info(`Loaded last processed timestamp: ${lastProcessedTweetTimestamp}`);
      }
      if (state.processedTweetIds) {
        processedTweetIds = new Set(state.processedTweetIds);
        logger.info(`Loaded ${processedTweetIds.size} processed tweet IDs.`);
      }
    }
  } catch (error) {
    logger.error('Could not load state', { error: error.message });
  }
}

function saveState() {
  try {
    const state = {
      lastProcessedTweetTimestamp,
      processedTweetIds: Array.from(processedTweetIds)
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    logger.info(`Saved state. Last processed timestamp: ${lastProcessedTweetTimestamp}, Processed IDs: ${processedTweetIds.size}`);
  } catch (error) {
    logger.error('Could not save state', { error: error.message });
  }
}

function initializeMentionCursor() {
  // Modes:
  // - resume (default): use saved cursor if present; if missing, start "now - lookback"
  // - fresh: ignore saved cursor and start "now - lookback" (prevents historical backfill)
  // - since: start at BOT_MENTIONS_START_TIME (RFC3339) or "now - lookback"
  const modeRaw = (process.env.BOT_MENTIONS_START_MODE || 'resume').toLowerCase();
  const mode = (modeRaw === 'fresh' || modeRaw === 'since' || modeRaw === 'resume') ? modeRaw : 'resume';
  const lookbackSeconds =
    toIntOrNull(process.env.BOT_MENTIONS_LOOKBACK_SECONDS) ??
    (mode === 'fresh' ? 30 : 0); // default: 30s lookback on fresh to avoid missing just-before-start mentions
  const sinceTime = process.env.BOT_MENTIONS_START_TIME || null;

  if (mode === 'fresh') {
    processedTweetIds = new Set();
    lastProcessedTweetTimestamp = computeStartTimestamp({ mode, lookbackSeconds, sinceTime: null });
    logger.warn('BOT_MENTIONS_START_MODE=fresh: starting from cursor (no historical mentions before this time)', {
      cursor: lastProcessedTweetTimestamp,
      lookbackSeconds,
    });
    saveState();
    return;
  }

  if (mode === 'since') {
    processedTweetIds = new Set(processedTweetIds); // keep any loaded dedupe, but not required
    lastProcessedTweetTimestamp = computeStartTimestamp({ mode, lookbackSeconds, sinceTime });
    logger.info('BOT_MENTIONS_START_MODE=since: starting from cursor', {
      cursor: lastProcessedTweetTimestamp,
      lookbackSeconds,
      sinceTime,
    });
    saveState();
    return;
  }

  // resume
  if (!lastProcessedTweetTimestamp) {
    lastProcessedTweetTimestamp = computeStartTimestamp({ mode, lookbackSeconds, sinceTime: null });
    logger.info('BOT_MENTIONS_START_MODE=resume with no saved state: starting from cursor', {
      cursor: lastProcessedTweetTimestamp,
      lookbackSeconds,
    });
    saveState();
  } else {
    logger.info('BOT_MENTIONS_START_MODE=resume: using saved cursor', { cursor: lastProcessedTweetTimestamp });
  }
}

async function checkMentions() {
  if (isCheckingMentions) {
    logger.warn('checkMentions skipped: previous run still in progress');
    return;
  }
  isCheckingMentions = true;
  try {
    const mentions = await twitterService.getMentions(lastProcessedTweetTimestamp);

    if (mentions.length > 0) {
      // Process mentions in chronological order (oldest first)
      const sortedMentions = mentions.sort((a, b) =>
        new Date(a.created_at) - new Date(b.created_at)
      );

      let stateChanged = false;
      for (const tweet of sortedMentions) {
        try {
          if (processedTweetIds.has(tweet.id)) {
            logger.info('Skipping already processed tweet in main loop.', { id: tweet.id });
            continue;
          }
          
          const processed = await handleTweet(tweet, processedTweetIds);
          if (processed) {
            processedTweetIds.add(tweet.id);
            lastProcessedTweetTimestamp = tweet.created_at > (lastProcessedTweetTimestamp || '') ? tweet.created_at : lastProcessedTweetTimestamp;
            logger.info('Successfully processed tweet:', { id: tweet.id, text: tweet.text, createdAt: tweet.created_at });
            stateChanged = true;
          }
        } catch (error) {
          logger.error('Error handling tweet:', {tweetId: tweet.id, error: error.message});
        }
      }

      if (stateChanged) {
        saveState();
      }
    }
  } catch (error) {
    logger.error('Error checking mentions:', error);
  } finally {
    isCheckingMentions = false;
  }
}

async function processGiveaways() {
  if (isProcessingGiveaways) {
    logger.warn('processGiveaways skipped: previous run still in progress');
    return;
  }
  isProcessingGiveaways = true;
  try {
    // Get all active giveaways that have ended
    const activeGiveaways = await giveawayService.getActiveGiveaways();
    
    if (activeGiveaways.length === 0) {
      logger.debug('No active giveaways to process');
      return;
    }
    
    logger.info(`Processing ${activeGiveaways.length} expired giveaways`);
    
    for (const giveaway of activeGiveaways) {
      try {
        // Process giveaway and select winners
        const result = await giveawayService.processGiveaway(giveaway._id);
        
        if (!result) {
          continue; // Giveaway not ready or already processed
        }
        
        const { giveaway: updatedGiveaway, winners, noParticipants } = result;
        
        if (noParticipants) {
          // No participants - just announce completion
          const message = `🎉 Giveaway Results\n\n` +
            `Unfortunately, no comments were found on the tweet, so no winners could be selected.\n\n` +
            `Prize Pool: ${updatedGiveaway.totalPrizeAmount} ${updatedGiveaway.token} (returned to creator)`;
          
          // Reply to the original giveaway tweet instead of creating a new tweet
          let resultTweet;
          if (updatedGiveaway.confirmationTweetId) {
            // Reply to the confirmation tweet
            resultTweet = await twitterService.replyToTweet(updatedGiveaway.confirmationTweetId, message);
          } else if (updatedGiveaway.tweetId) {
            // Reply to the original giveaway tweet
            resultTweet = await twitterService.replyToTweet(updatedGiveaway.tweetId, message);
          } else {
            // Fallback to creating a new tweet if no tweet IDs are available
            resultTweet = await twitterService.createTweet(message);
          }
          
          if (resultTweet && resultTweet.data && resultTweet.data.id) {
            updatedGiveaway.resultsTweetId = resultTweet.data.id;
            await updatedGiveaway.save();
          }
          
          logger.info('Giveaway completed with no participants', { 
            giveawayId: updatedGiveaway._id 
          });
          continue;
        }
        
        if (winners.length === 0) {
          logger.warn('No winners selected for giveaway', { 
            giveawayId: updatedGiveaway._id 
          });
          continue;
        }
        
        // Transfer prizes to winners
        const transferResult = await giveawayService.transferPrizesToWinners(updatedGiveaway._id);
        
        if (transferResult && transferResult.transferResults) {
          // Create results announcement tweet
          const successfulTransfers = transferResult.transferResults.filter(r => r.status === 'success');
          const failedTransfers = transferResult.transferResults.filter(r => r.status === 'failed');
          
          let resultsMessage = `🎉 Giveaway Results!\n\n`;
          resultsMessage += `💰 Prize: ${updatedGiveaway.amount} ${updatedGiveaway.token} each\n`;
          resultsMessage += `👥 Winners Selected: ${winners.length}\n\n`;
          
          if (successfulTransfers.length > 0) {
            resultsMessage += `✅ Successfully transferred:\n`;
            successfulTransfers.forEach((transfer, index) => {
              resultsMessage += `${index + 1}. @${transfer.winner} - ${transfer.amount} ${transfer.token}\n`;
              resultsMessage += `   TX: https://hyperion-testnet-explorer.metisdevops.link/tx/${transfer.txHash}\n`;
            });
          }
          
          if (failedTransfers.length > 0) {
            resultsMessage += `\n❌ Failed transfers:\n`;
            failedTransfers.forEach((transfer, index) => {
              resultsMessage += `${index + 1}. @${transfer.winner} - ${transfer.error}\n`;
            });
          }
          
          resultsMessage += `\nCongratulations to all winners! 🎊`;
          
          // Reply to the original giveaway tweet instead of creating a new tweet
          let resultTweet;
          if (updatedGiveaway.confirmationTweetId) {
            // Reply to the confirmation tweet
            resultTweet = await twitterService.replyToTweet(updatedGiveaway.confirmationTweetId, resultsMessage);
          } else if (updatedGiveaway.tweetId) {
            // Reply to the original giveaway tweet
            resultTweet = await twitterService.replyToTweet(updatedGiveaway.tweetId, resultsMessage);
          } else {
            // Fallback to creating a new tweet if no tweet IDs are available
            resultTweet = await twitterService.createTweet(resultsMessage);
          }
          
          if (resultTweet && resultTweet.data && resultTweet.data.id) {
            updatedGiveaway.resultsTweetId = resultTweet.data.id;
            await updatedGiveaway.save();
          }
          
          logger.info('Giveaway completed and results announced', {
            giveawayId: updatedGiveaway._id,
            winnersCount: winners.length,
            successfulTransfers: successfulTransfers.length,
            failedTransfers: failedTransfers.length
          });
        }
        
      } catch (error) {
        logger.error('Error processing individual giveaway', {
          giveawayId: giveaway._id,
          error: error.message
        });
      }
    }
    
  } catch (error) {
    logger.error('Error processing giveaways', { error: error.message });
  } finally {
    isProcessingGiveaways = false;
  }
}

async function main() {
  try {
    logger.info('Starting Twitter bot...');

    loadState();
    initializeMentionCursor();

    // Initial checks
    await checkMentions();
    if (process.env.BOT_DISABLE_GIVEAWAYS !== '1') {
      await processGiveaways();
    } else {
      logger.info('BOT_DISABLE_GIVEAWAYS=1: skipping giveaways processing');
    }
    if (rewardService) {
      try {
        if (process.env.BOT_DISABLE_SNAPSHOTS !== '1') {
          await rewardService.snapshotIfNeeded();
        } else {
          logger.info('BOT_DISABLE_SNAPSHOTS=1: skipping reward snapshots');
        }
      } catch (e) {
        logger.error('Initial reward snapshot check failed', { error: e.message });
      }
    } else {
      logger.info('RewardService disabled (missing reward env vars). Skipping snapshots.');
    }

    // One-shot mode for local smoke testing / ops.
    if (process.env.BOT_RUN_ONCE === '1') {
      logger.warn('BOT_RUN_ONCE=1: completed initial cycle; exiting without scheduling intervals');
      // Force exit even if there are open handles (e.g., mongoose connections initialized by services).
      setTimeout(() => process.exit(0), 0);
      return;
    }

    // Check for new mentions every 1.5 minute
    setInterval(checkMentions, 90 * 1000); // 1.5 minutes

    // Process giveaways every 5 minutes
    if (process.env.BOT_DISABLE_GIVEAWAYS !== '1') {
      setInterval(processGiveaways, 5 * 60 * 1000); // 5 minutes
    }

    // Snapshot XP rewards on a configurable interval
    if (rewardService) {
      if (process.env.BOT_DISABLE_SNAPSHOTS !== '1') {
        setInterval(async () => {
          try {
            await rewardService.snapshotIfNeeded();
          } catch (e) {
            logger.error('Reward snapshot interval failed', { error: e.message });
          }
        }, rewardService.snapshotCheckIntervalSeconds * 1000);
      }
    }

    logger.info('Twitter bot is running and checking for mentions and processing giveaways');
  } catch (error) {
    logger.error('Application error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };