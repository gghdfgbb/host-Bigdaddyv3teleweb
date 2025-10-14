const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { BOT_TOKEN, ADMIN_CHAT_ID, WEB_DOMAIN, PORT } = require('./config');

console.log('🔧 Configuration Loaded:');
console.log('🌐 WEB_DOMAIN:', WEB_DOMAIN);
console.log('🔑 ADMIN_CHAT_ID:', ADMIN_CHAT_ID);
console.log('🚀 PORT:', PORT);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Function to get the real domain dynamically
function getRealDomain() {
  // If we're in production and domain is still default, try to detect
  if (WEB_DOMAIN.includes('your-app-name')) {
    // Try to get from Render environment
    if (process.env.RENDER_EXTERNAL_URL) {
      return process.env.RENDER_EXTERNAL_URL;
    }
    // Try to construct from service name
    if (process.env.RENDER_SERVICE_NAME) {
      return `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
    }
  }
  return WEB_DOMAIN;
}

const REAL_DOMAIN = getRealDomain();
console.log('🎯 Using Domain:', REAL_DOMAIN);

// Keep-alive function
function startKeepAlive() {
  const endpoints = [
    `${REAL_DOMAIN}/`,
    `${REAL_DOMAIN}/health`,
    `${REAL_DOMAIN}/ping`
  ];

  const pingEndpoint = async (endpoint) => {
    try {
      const response = await axios.get(endpoint, { timeout: 10000 });
      console.log(`✅ ${endpoint} - Status: ${response.status}`);
      return true;
    } catch (error) {
      console.log(`❌ ${endpoint} - Error: ${error.message}`);
      return false;
    }
  };

  // Ping immediately on startup
  console.log('🔄 Starting initial ping...');
  endpoints.forEach(pingEndpoint);
  
  // Ping every 5 minutes
  setInterval(() => {
    console.log(`🔄 Keep-alive ping at ${new Date().toLocaleTimeString()}`);
    endpoints.forEach(pingEndpoint);
  }, 5 * 60 * 1000);

  console.log('🔄 Keep-alive system started');
}

class DatabaseManager {
  constructor() {
    this.dbPath = path.join(__dirname, 'database.json');
    this.loadDatabase();
  }

  loadDatabase() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const data = fs.readFileSync(this.dbPath, 'utf8');
        this.db = JSON.parse(data);
      } else {
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
    } catch (error) {
      console.error('Database load error:', error);
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

  async checkUserJoinedChannels(userId) {
    const forceJoin = this.db.settings.force_join;
    
    if (!forceJoin || forceJoin.length === 0) {
      return true;
    }
    
    const validChannels = forceJoin.filter(ch => ch.id && ch.id.startsWith('-'));
    
    if (validChannels.length === 0) {
      return true;
    }
    
    for (const channel of validChannels) {
      try {
        const chatMember = await bot.getChatMember(channel.id, userId);
        if (chatMember.status === 'left' || chatMember.status === 'kicked') {
          return false;
        }
      } catch (error) {
        console.error(`Error checking channel ${channel.id}:`, error.message);
      }
    }
    return true;
  }

  shouldForceJoin() {
    const forceJoin = this.db.settings.force_join;
    if (!forceJoin || forceJoin.length === 0) return false;
    return forceJoin.some(ch => ch.id && ch.id.startsWith('-'));
  }

  addUser(userId, userData) {
    if (!this.db.users[userId]) {
      this.db.users[userId] = {
        ...userData,
        ip: this.trackIP(userId),
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

  trackIP(userId) {
    return `192.168.1.${parseInt(userId) % 255}`;
  }

  getUser(userId) {
    return this.db.users[userId];
  }
}

const db = new DatabaseManager();
const userStates = new Map();

// FIXED: Using REAL_DOMAIN instead of WEB_DOMAIN
async function handleForceJoin(userId, chatId) {
  if (!db.shouldForceJoin()) {
    return true;
  }

  const hasJoined = await db.checkUserJoinedChannels(userId);
  
  if (!hasJoined) {
    const validChannels = db.db.settings.force_join.filter(ch => ch.id && ch.name);
    const keyboard = {
      inline_keyboard: [
        ...validChannels.map(channel => [
          { text: `Join ${channel.name}`, url: channel.invite_link || `https://t.me/${channel.id}` }
        ]),
        [{ text: "✅ I've Joined", callback_data: `check_join_${userId}` }]
      ]
    };
    
    await bot.sendMessage(chatId, 
      `🔒 **Access Required**\n\n` +
      `To use **Big Daddy V3**, you must join our official channels:\n\n` +
      `${validChannels.map(ch => `• ${ch.name}`).join('\n')}\n\n` +
      `After joining, click "I've Joined" to verify.`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    return false;
  }
  return true;
}

// FIXED: Using REAL_DOMAIN for all URLs
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  try {
    if (userId === ADMIN_CHAT_ID) {
      const adminUrl = `${REAL_DOMAIN}/admin`;
      await bot.sendMessage(chatId,
        `👑 **Admin Panel - Big Daddy V3**\n\n` +
        `📊 Statistics:\n` +
        `• Users: ${db.db.statistics.total_users}\n` +
        `• Accounts: ${db.db.statistics.total_accounts}\n\n` +
        `🌐 **Web Dashboard:**\n${adminUrl}\n\n` +
        `Use /stats for more details.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const canProceed = await handleForceJoin(userId, chatId);
    if (!canProceed) return;

    const user = db.getUser(userId);
    if (user) {
      const dashboardUrl = `${REAL_DOMAIN}/dashboard?user=${userId}`;
      await bot.sendMessage(chatId,
        `👋 **Welcome back ${user.name}!**\n\n` +
        `🌐 **Dashboard:** ${dashboardUrl}\n\n` +
        `Use /account for your account details.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      userStates.set(userId, { step: 'name' });
      await bot.sendMessage(chatId,
        `🎉 **Welcome to Big Daddy V3!**\n\n` +
        `Please enter your **full name** to create account:`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    console.error('Start command error:', error);
    await bot.sendMessage(chatId, '❌ Service error. Please try again.');
  }
});

// Registration flow
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
        await bot.sendMessage(chatId, '📧 Now enter your *email address*:', { parse_mode: 'Markdown' });
        break;
        
      case 'email':
        state.email = msg.text.trim();
        state.step = 'password';
        await bot.sendMessage(chatId, '🔐 Create a *secure password* (min 6 characters):', { parse_mode: 'Markdown' });
        break;
        
      case 'password':
        if (msg.text.length < 6) {
          await bot.sendMessage(chatId, '❌ Password must be at least 6 characters. Try again:');
          return;
        }
        
        const userData = {
          name: state.name,
          email: state.email,
          password: msg.text
        };
        
        if (db.addUser(userId, userData)) {
          const dashboardUrl = `${REAL_DOMAIN}/dashboard?user=${userId}`;
          await bot.sendMessage(chatId,
            `🎉 **Account Created Successfully!**\n\n` +
            `👤 Welcome *${userData.name}*!\n` +
            `📧 ${userData.email}\n\n` +
            `🌐 **Dashboard:** ${dashboardUrl}\n\n` +
            `You can now deploy your WhatsApp bots!`,
            { parse_mode: 'Markdown' }
          );
          
          // Notify admin
          await bot.sendMessage(ADMIN_CHAT_ID,
            `🆕 **New User Registration**\n\n` +
            `👤 ${userData.name}\n` +
            `📧 ${userData.email}\n` +
            `🆔 ${userId}\n` +
            `🌐 ${db.trackIP(userId)}`,
            { parse_mode: 'Markdown' }
          );
        }
        
        userStates.delete(userId);
        break;
    }
  } catch (error) {
    console.error('Registration error:', error);
    await bot.sendMessage(chatId, '❌ Registration error. Please try /start again.');
    userStates.delete(userId);
  }
});

// Callback queries
bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  
  if (data.startsWith('check_join_')) {
    const userId = data.split('_')[2];
    const hasJoined = await db.checkUserJoinedChannels(userId);
    
    if (hasJoined) {
      await bot.editMessageText('✅ **Verified!** Use /start to continue.', {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: "Please join all required channels first",
        show_alert: true
      });
    }
  }
});

// Start keep-alive
startKeepAlive();

console.log('🤖 Big Daddy V3 Bot Started Successfully!');
console.log('🎯 Real Domain:', REAL_DOMAIN);
console.log('👑 Admin ID:', ADMIN_CHAT_ID);
