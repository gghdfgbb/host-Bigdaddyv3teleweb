const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN || "8494420933:AAFNh20zM_RHbP4ftWGcBEusD1VmcQlvg3E";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "8099343828";

// Get web domain
function getWebDomain() {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  if (process.env.RENDER_SERVICE_NAME) {
    return `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
  }
  return 'http://localhost:3000';
}

const WEB_DOMAIN = getWebDomain();

console.log('🤖 Starting Telegram Bot...');
console.log('🌐 Web Domain:', WEB_DOMAIN);

const bot = new TelegramBot(BOT_TOKEN, { 
  polling: true,
  request: {
    timeout: 10000
  }
});

// Wait for web service to be ready
async function waitForWebService() {
  console.log('⏳ Waiting for web service to be ready...');
  
  let attempts = 0;
  const maxAttempts = 30; // 5 minutes max
  
  while (attempts < maxAttempts) {
    try {
      const response = await axios.get(`${WEB_DOMAIN}/health`, { timeout: 5000 });
      if (response.status === 200) {
        console.log('✅ Web service is ready!');
        return true;
      }
    } catch (error) {
      // Ignore errors, just wait
    }
    
    attempts++;
    console.log(`⏰ Attempt ${attempts}/${maxAttempts} - Web service not ready yet...`);
    await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
  }
  
  console.log('❌ Web service did not become ready in time');
  return false;
}

// Start keep-alive only after web service is ready
async function startKeepAlive() {
  const isReady = await waitForWebService();
  
  if (!isReady) {
    console.log('🚫 Cannot start keep-alive - web service unavailable');
    return;
  }

  const pingWeb = async () => {
    try {
      const response = await axios.get(`${WEB_DOMAIN}/health`, { timeout: 10000 });
      console.log(`✅ Web service ping: ${response.status} - ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      console.log(`❌ Web service ping failed: ${error.message}`);
    }
  };

  // Start pinging
  pingWeb();
  setInterval(pingWeb, 5 * 60 * 1000);
  
  console.log('🔄 Keep-alive system started');
}

// Database setup
class DatabaseManager {
  constructor() {
    this.dbPath = 'database.json';
    this.loadDatabase();
  }

  loadDatabase() {
    try {
      if (fs.existsSync(this.dbPath)) {
        this.db = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      } else {
        this.initializeDefaultDB();
      }
    } catch (error) {
      this.initializeDefaultDB();
    }
  }

  initializeDefaultDB() {
    this.db = {
      users: {},
      admins: [ADMIN_CHAT_ID],
      settings: {
        force_join: [],
        max_accounts_per_ip: 3,
        blocked_ips: {}
      },
      statistics: {
        total_users: 0,
        total_accounts: 0,
        blocked_users: 0
      }
    };
    this.saveDatabase();
  }

  saveDatabase() {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2));
    } catch (error) {
      console.error('Database save error:', error);
    }
  }

  shouldForceJoin() {
    const forceJoin = this.db.settings.force_join;
    return forceJoin && forceJoin.length > 0 && forceJoin.some(ch => ch.id && ch.id.startsWith('-'));
  }

  addUser(userId, userData) {
    if (!this.db.users[userId]) {
      this.db.users[userId] = {
        ...userData,
        ip: `192.168.1.${parseInt(userId) % 255}`,
        created_at: new Date().toISOString(),
        status: 'active'
      };
      this.db.statistics.total_users++;
      this.db.statistics.total_accounts++;
      this.saveDatabase();
      return true;
    }
    return false;
  }

  getUser(userId) {
    return this.db.users[userId];
  }
}

const db = new DatabaseManager();
const userStates = new Map();

// Start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  try {
    if (userId === ADMIN_CHAT_ID) {
      const adminUrl = `${WEB_DOMAIN}/admin`;
      await bot.sendMessage(chatId,
        `👑 *Admin Panel - Big Daddy V3*\n\n` +
        `📊 Statistics:\n` +
        `• Users: ${db.db.statistics.total_users}\n` +
        `• Accounts: ${db.db.statistics.total_accounts}\n\n` +
        `🌐 Web Dashboard: ${adminUrl}\n\n` +
        `The system is ready to use!`,
        { parse_mode: 'Markdown' }
      );
    } else {
      const user = db.getUser(userId);
      if (user) {
        const dashboardUrl = `${WEB_DOMAIN}/dashboard?user=${userId}`;
        await bot.sendMessage(chatId,
          `👋 *Welcome back ${user.name}!*\n\n` +
          `Dashboard: ${dashboardUrl}`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.sendMessage(chatId,
          `🎉 *Welcome to Big Daddy V3!*\n\n` +
          `Use /register to create your account\n` +
          `Use /help for assistance`,
          { parse_mode: 'Markdown' }
        );
      }
    }
  } catch (error) {
    console.error('Start command error:', error);
    await bot.sendMessage(chatId, '❌ Service error. Please try again.');
  }
});

// Register command
bot.onText(/\/register/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();

  if (db.getUser(userId)) {
    await bot.sendMessage(chatId, '✅ You already have an account!');
    return;
  }

  userStates.set(userId, { step: 'name' });
  await bot.sendMessage(chatId, 'Please enter your full name:');
});

// Message handler
bot.on('message', async (msg) => {
  if (msg.text.startsWith('/')) return;
  
  const userId = msg.from.id.toString();
  const chatId = msg.chat.id;
  const state = userStates.get(userId);
  
  if (!state) return;

  try {
    switch (state.step) {
      case 'name':
        state.name = msg.text.trim();
        state.step = 'email';
        await bot.sendMessage(chatId, 'Now enter your email address:');
        break;
        
      case 'email':
        state.email = msg.text.trim();
        state.step = 'password';
        await bot.sendMessage(chatId, 'Create a password (min 6 characters):');
        break;
        
      case 'password':
        if (msg.text.length < 6) {
          await bot.sendMessage(chatId, '❌ Password too short. Try again:');
          return;
        }
        
        const userData = {
          name: state.name,
          email: state.email,
          password: msg.text
        };
        
        if (db.addUser(userId, userData)) {
          const dashboardUrl = `${WEB_DOMAIN}/dashboard?user=${userId}`;
          await bot.sendMessage(chatId,
            `🎉 *Account Created!*\n\n` +
            `Welcome ${userData.name}!\n` +
            `Dashboard: ${dashboardUrl}`,
            { parse_mode: 'Markdown' }
          );
        }
        
        userStates.delete(userId);
        break;
    }
  } catch (error) {
    await bot.sendMessage(chatId, '❌ Registration error. Please try /register again.');
    userStates.delete(userId);
  }
});

// Start the system
startKeepAlive().then(() => {
  console.log('✅ Big Daddy V3 Bot is fully operational!');
});

console.log('✅ Bot started (waiting for web service...)');
