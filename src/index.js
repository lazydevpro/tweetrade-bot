const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { setupLogger } = require('./utils/logger');
const { handleTweet } = require('./handlers/tweetHandler');
const twitterService = require('./services/twitterService');
const giveawayService = require('./services/giveawayService');

const logger = setupLogger();

const STATE_FILE = path.join(__dirname, '..', 'last_processed_state.json');

// Keep track of the last processed tweet's timestamp
let lastProcessedTweetTimestamp = null;
let processedTweetIds = new Set();

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

async function checkMentions() {
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
  }
}

async function processGiveaways() {
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
  }
}

async function main() {
  try {
    logger.info('Starting Twitter bot...');

    loadState();

    // Initial checks
    await checkMentions();
    await processGiveaways();

    // Check for new mentions every 1.5 minute
    setInterval(checkMentions, 90 * 1000); // 1.5 minutes

    // Process giveaways every 5 minutes
    setInterval(processGiveaways, 5 * 60 * 1000); // 5 minutes

    logger.info('Twitter bot is running and checking for mentions and processing giveaways');
  } catch (error) {
    logger.error('Application error:', error);
    process.exit(1);
  }
}

main(); 