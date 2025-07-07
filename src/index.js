const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { setupLogger } = require('./utils/logger');
const { handleTweet } = require('./handlers/tweetHandler');
const twitterService = require('./services/twitterService');

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

async function main() {
  try {
    logger.info('Starting Twitter bot...');

    loadState();

    // Initial check
    await checkMentions();

    // Check for new mentions every 1.5 minute
    setInterval(checkMentions, 90 * 1000); // 1.5 minutes

    logger.info('Twitter bot is running and checking for mentions');
  } catch (error) {
    logger.error('Application error:', error);
    process.exit(1);
  }
}

main(); 