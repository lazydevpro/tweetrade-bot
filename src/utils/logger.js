const winston = require('winston');

/**
 * @file logger.js
 * @description Sets up and exports a Winston logger for application-wide logging.
 */

function setupLogger() {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
      }),
      new winston.transports.File({ filename: 'error.log', level: 'error' }),
    ],
  });
}

/**
 * Creates and configures a Winston logger instance.
 * @returns {import('winston').Logger} Winston logger instance.
 */

module.exports = {
  setupLogger,
}; 