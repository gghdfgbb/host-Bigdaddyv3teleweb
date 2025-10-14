const os = require('os');

// Auto-detect the domain in production
function getWebDomain() {
  // If WEB_DOMAIN is set in environment, use it
  if (process.env.WEB_DOMAIN && process.env.WEB_DOMAIN !== 'https://your-app-name.onrender.com') {
    return process.env.WEB_DOMAIN;
  }
  
  // If running on Render, construct the domain from Render's environment
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  
  // If running on Render with service name
  if (process.env.RENDER_SERVICE_NAME) {
    return `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
  }
  
  // Default for local development
  return 'http://localhost:3000';
}

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN || "8494420933:AAFNh20zM_RHbP4ftWGcBEusD1VmcQlvg3E",
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID || "8099343828",
  WEB_DOMAIN: getWebDomain(),
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development'
};
