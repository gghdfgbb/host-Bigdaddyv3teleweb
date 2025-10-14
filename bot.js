const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ==================== CONFIGURATION ====================
const BOT_TOKEN = process.env.BOT_TOKEN || "8494420933:AAFNh20zM_RHbP4ftWGcBEusD1VmcQlvg3E";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "8099343828";

// Get web domain with better detection
function getWebDomain() {
    if (process.env.RENDER_EXTERNAL_URL) {
        return process.env.RENDER_EXTERNAL_URL;
    }
    if (process.env.RENDER_SERVICE_NAME) {
        return `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
    }
    return `http://localhost:${process.env.PORT || 3000}`;
}

const WEB_DOMAIN = getWebDomain();

console.log('🤖 Starting Big Daddy V3 Telegram Bot...');
console.log('🌐 Web Domain:', WEB_DOMAIN);
console.log('👑 Admin ID:', ADMIN_CHAT_ID);

// ==================== ENHANCED BOT SETUP ====================
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    },
    request: {
        timeout: 15000,
        agentOptions: {
            keepAlive: true,
            family: 4
        }
    }
});

// ==================== ENHANCED DATABASE MANAGER ====================
class DatabaseManager {
    constructor() {
        this.dbPath = path.join(__dirname, 'database.json');
        this.backupDir = path.join(__dirname, 'backups');
        this.ensureDirectories();
        this.loadDatabase();
    }

    ensureDirectories() {
        if (!fs.existsSync(path.dirname(this.dbPath))) {
            fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        }
        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }
    }

    loadDatabase() {
        try {
            if (fs.existsSync(this.dbPath)) {
                const data = fs.readFileSync(this.dbPath, 'utf8');
                this.db = JSON.parse(data);
                console.log('✅ Database loaded successfully');
                console.log(`📊 Users: ${Object.keys(this.db.users || {}).length}`);
            } else {
                this.initializeDefaultDB();
            }
        } catch (error) {
            console.error('❌ Database load error:', error);
            this.initializeDefaultDB();
            this.createBackup('corrupted_recovery');
        }
    }

    initializeDefaultDB() {
        this.db = {
            users: {},
            admins: [ADMIN_CHAT_ID],
            settings: {
                force_join: [],
                max_accounts_per_ip: 3,
                blocked_ips: {},
                welcome_message: "🎉 Welcome to Big Daddy V3!\n\nYour ultimate WhatsApp bot solution."
            },
            statistics: {
                total_users: 0,
                total_accounts: 0,
                blocked_users: 0,
                registrations_today: 0,
                last_reset: new Date().toDateString()
            }
        };
        this.saveDatabase();
        console.log('✅ Default database initialized');
    }

    saveDatabase() {
        try {
            // Create backup before saving
            this.createBackup('auto');
            
            fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2));
            return true;
        } catch (error) {
            console.error('❌ Database save error:', error);
            return false;
        }
    }

    createBackup(reason = 'manual') {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = path.join(this.backupDir, `backup-${timestamp}-${reason}.json`);
            fs.writeFileSync(backupPath, JSON.stringify(this.db, null, 2));
            return true;
        } catch (error) {
            console.error('Backup creation failed:', error);
            return false;
        }
    }

    // ==================== USER MANAGEMENT ====================
    addUser(userId, userData) {
        if (!this.db.users[userId]) {
            this.db.users[userId] = {
                ...userData,
                user_id: userId,
                ip: this.generateUserIP(userId),
                created_at: new Date().toISOString(),
                last_active: new Date().toISOString(),
                status: 'active',
                accounts: []
            };
            
            // Update statistics
            this.db.statistics.total_users++;
            this.db.statistics.total_accounts++;
            
            // Daily registration counter
            this.updateDailyStats();
            
            this.saveDatabase();
            return true;
        }
        return false;
    }

    generateUserIP(userId) {
        // Generate consistent IP based on user ID
        const hash = userId.split('').reduce((a, b) => {
            a = ((a << 5) - a) + b.charCodeAt(0);
            return a & a;
        }, 0);
        return `192.168.1.${Math.abs(hash % 254) + 1}`;
    }

    updateDailyStats() {
        const today = new Date().toDateString();
        if (this.db.statistics.last_reset !== today) {
            this.db.statistics.registrations_today = 0;
            this.db.statistics.last_reset = today;
        }
        this.db.statistics.registrations_today++;
    }

    getUser(userId) {
        const user = this.db.users[userId];
        if (user) {
            user.last_active = new Date().toISOString();
            this.saveDatabase();
        }
        return user;
    }

    updateUser(userId, updates) {
        if (this.db.users[userId]) {
            this.db.users[userId] = { ...this.db.users[userId], ...updates };
            this.saveDatabase();
            return true;
        }
        return false;
    }

    // ==================== CHANNEL MANAGEMENT ====================
    shouldForceJoin() {
        const forceJoin = this.db.settings.force_join;
        return forceJoin && forceJoin.length > 0 && forceJoin.some(ch => ch.id && ch.id.toString().startsWith('-'));
    }

    async checkUserJoinedChannels(userId) {
        if (!this.shouldForceJoin()) return true;

        const forceJoin = this.db.settings.force_join;
        const results = [];

        for (const channel of forceJoin) {
            try {
                const chatMember = await bot.getChatMember(channel.id, userId);
                const hasJoined = !['left', 'kicked'].includes(chatMember.status);
                results.push({ channel: channel.name, joined: hasJoined });
                
                if (!hasJoined) {
                    return false; // User hasn't joined this channel
                }
            } catch (error) {
                console.error(`❌ Channel check error for ${channel.id}:`, error.message);
                results.push({ channel: channel.name, joined: false, error: true });
                return false; // Assume not joined if error
            }
        }
        
        return true;
    }

    getForceJoinChannels() {
        return this.db.settings.force_join.filter(ch => ch.id && ch.name);
    }

    // ==================== ADMIN METHODS ====================
    isAdmin(userId) {
        return this.db.admins.includes(userId.toString());
    }

    getStatistics() {
        return {
            ...this.db.statistics,
            active_users: Object.keys(this.db.users).length,
            force_join_enabled: this.shouldForceJoin(),
            force_join_channels: this.getForceJoinChannels().length
        };
    }

    updateSettings(newSettings) {
        this.db.settings = { ...this.db.settings, ...newSettings };
        return this.saveDatabase();
    }
}

// ==================== BOT MANAGER ====================
class BotManager {
    constructor() {
        this.db = new DatabaseManager();
        this.userStates = new Map();
        this.commands = new Map();
        this.setupCommands();
    }

    setupCommands() {
        this.commands.set('start', this.handleStart.bind(this));
        this.commands.set('register', this.handleRegister.bind(this));
        this.commands.set('stats', this.handleStats.bind(this));
        this.commands.set('help', this.handleHelp.bind(this));
        this.commands.set('admin', this.handleAdmin.bind(this));
        this.commands.set('backup', this.handleBackup.bind(this));
    }

    // ==================== COMMAND HANDLERS ====================
    async handleStart(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        
        try {
            console.log(`👤 Start command from ${userId}`);

            // Admin access
            if (this.db.isAdmin(userId)) {
                return await this.sendAdminPanel(chatId, userId);
            }

            // Force join check
            if (this.db.shouldForceJoin()) {
                const hasJoined = await this.db.checkUserJoinedChannels(userId);
                if (!hasJoined) {
                    return await this.sendJoinRequest(chatId, userId);
                }
            }

            // User flow
            const user = this.db.getUser(userId);
            if (user) {
                await this.sendUserDashboard(chatId, user);
            } else {
                await this.sendWelcomeMessage(chatId);
            }
        } catch (error) {
            console.error('❌ Start command error:', error);
            await this.sendError(chatId, 'Service temporarily unavailable. Please try again.');
        }
    }

    async handleRegister(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();

        if (this.db.getUser(userId)) {
            await bot.sendMessage(chatId, '✅ You already have an account! Use /start to continue.');
            return;
        }

        this.userStates.set(userId, { 
            step: 'name',
            data: {}
        });
        
        await bot.sendMessage(chatId,
            `📝 *Account Registration*\n\n` +
            `Let's create your account!\n\n` +
            `Please enter your *full name*:`,
            { parse_mode: 'Markdown' }
        );
    }

    async handleStats(msg) {
        const userId = msg.from.id.toString();
        if (!this.db.isAdmin(userId)) return;

        const stats = this.db.getStatistics();
        await bot.sendMessage(msg.chat.id,
            `📊 *Detailed Statistics*\n\n` +
            `👥 Total Users: ${stats.total_users}\n` +
            `📦 Total Accounts: ${stats.total_accounts}\n` +
            `🚫 Blocked Users: ${stats.blocked_users}\n` +
            `🌐 Active Users: ${stats.active_users}\n` +
            `📈 Registrations Today: ${stats.registrations_today}\n` +
            `🔧 Accounts per IP: ${this.db.db.settings.max_accounts_per_ip}\n` +
            `📢 Force Join: ${stats.force_join_enabled ? 'Enabled' : 'Disabled'}\n` +
            `📋 Channels: ${stats.force_join_channels}`,
            { parse_mode: 'Markdown' }
        );
    }

    async handleHelp(msg) {
        const chatId = msg.chat.id;
        await bot.sendMessage(chatId,
            `🆘 *Big Daddy V3 Help*\n\n` +
            `Available Commands:\n` +
            `• /start - Start the bot\n` +
            `• /register - Create new account\n` +
            `• /help - Show this help\n\n` +
            `Need support? Contact our team.`,
            { parse_mode: 'Markdown' }
        );
    }

    async handleAdmin(msg) {
        const userId = msg.from.id.toString();
        if (!this.db.isAdmin(userId)) return;
        
        await this.sendAdminPanel(msg.chat.id, userId);
    }

    async handleBackup(msg) {
        const userId = msg.from.id.toString();
        if (!this.db.isAdmin(userId)) return;

        try {
            const success = this.db.createBackup('manual');
            if (success) {
                await bot.sendMessage(msg.chat.id, '✅ Database backup created successfully!');
            } else {
                await bot.sendMessage(msg.chat.id, '❌ Backup creation failed.');
            }
        } catch (error) {
            await bot.sendMessage(msg.chat.id, '❌ Backup error: ' + error.message);
        }
    }

    // ==================== MESSAGE HANDLERS ====================
    async handleMessage(msg) {
        if (msg.text?.startsWith('/')) return;
        
        const userId = msg.from.id.toString();
        const chatId = msg.chat.id;
        const state = this.userStates.get(userId);
        
        if (!state) return;

        try {
            switch (state.step) {
                case 'name':
                    await this.handleNameStep(msg, state, chatId, userId);
                    break;
                    
                case 'email':
                    await this.handleEmailStep(msg, state, chatId, userId);
                    break;
                    
                case 'password':
                    await this.handlePasswordStep(msg, state, chatId, userId);
                    break;
            }
        } catch (error) {
            console.error('Registration error:', error);
            await this.sendError(chatId, 'Registration error. Please try /register again.');
            this.userStates.delete(userId);
        }
    }

    async handleNameStep(msg, state, chatId, userId) {
        state.data.name = msg.text.trim();
        state.step = 'email';
        await bot.sendMessage(chatId, '📧 Now enter your *email address*:', { parse_mode: 'Markdown' });
    }

    async handleEmailStep(msg, state, chatId, userId) {
        const email = msg.text.trim();
        
        // Basic email validation
        if (!email.includes('@') || !email.includes('.')) {
            await bot.sendMessage(chatId, '❌ Please enter a valid email address:');
            return;
        }
        
        state.data.email = email;
        state.step = 'password';
        await bot.sendMessage(chatId, '🔐 Create a *secure password* (min 6 characters):', { parse_mode: 'Markdown' });
    }

    async handlePasswordStep(msg, state, chatId, userId) {
        if (msg.text.length < 6) {
            await bot.sendMessage(chatId, '❌ Password must be at least 6 characters. Try again:');
            return;
        }
        
        state.data.password = msg.text;
        
        if (this.db.addUser(userId, state.data)) {
            await this.sendRegistrationSuccess(chatId, state.data, userId);
            
            // Notify admin
            await this.notifyAdminRegistration(state.data, userId);
        } else {
            await bot.sendMessage(chatId, '❌ Account creation failed. You may already have an account.');
        }
        
        this.userStates.delete(userId);
    }

    // ==================== UTILITY METHODS ====================
    async sendAdminPanel(chatId, userId) {
        const adminUrl = `${WEB_DOMAIN}/admin`;
        const stats = this.db.getStatistics();
        
        await bot.sendMessage(chatId,
            `👑 *Admin Panel - Big Daddy V3*\n\n` +
            `📊 *Statistics:*\n` +
            `• Users: ${stats.total_users}\n` +
            `• Active: ${stats.active_users}\n` +
            `• Today: ${stats.registrations_today}\n\n` +
            `🌐 *Web Dashboard:* ${adminUrl}\n\n` +
            `Commands:\n` +
            `/stats - Detailed statistics\n` +
            `/backup - Create database backup\n` +
            `/admin - Show this panel`,
            { parse_mode: 'Markdown' }
        );
    }

    async sendJoinRequest(chatId, userId) {
        const channels = this.db.getForceJoinChannels();
        const keyboard = {
            inline_keyboard: [
                ...channels.map(channel => [
                    { 
                        text: `Join ${channel.name}`, 
                        url: channel.invite_link || `https://t.me/${channel.username || channel.id.toString().replace('-100', '')}` 
                    }
                ]),
                [{ text: "✅ I've Joined", callback_data: `check_join_${userId}` }]
            ]
        };
        
        await bot.sendMessage(chatId, 
            `🔒 *Access Required*\n\n` +
            `Please join our channels to continue:\n\n` +
            `${channels.map(ch => `• ${ch.name}`).join('\n')}\n\n` +
            `After joining, click "I've Joined" to verify.`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
    }

    async sendUserDashboard(chatId, user) {
        const dashboardUrl = `${WEB_DOMAIN}/dashboard?user=${user.user_id}`;
        await bot.sendMessage(chatId,
            `👋 *Welcome back ${user.name}!*\n\n` +
            `📧 ${user.email}\n` +
            `🆔 ${user.user_id}\n` +
            `📅 Joined: ${new Date(user.created_at).toLocaleDateString()}\n\n` +
            `🌐 *Dashboard:* ${dashboardUrl}\n\n` +
            `You can now deploy your WhatsApp bots!`,
            { parse_mode: 'Markdown' }
        );
    }

    async sendWelcomeMessage(chatId) {
        await bot.sendMessage(chatId,
            `🎉 *Welcome to Big Daddy V3!*\n\n` +
            `Your ultimate WhatsApp bot deployment platform.\n\n` +
            `Use /register to create your account\n` +
            `Use /help for assistance\n\n` +
            `✨ *Features:*\n` +
            `• Multi-account support\n` +
            `• Session management\n` +
            `• Dropbox backups\n` +
            `• Web dashboard`,
            { parse_mode: 'Markdown' }
        );
    }

    async sendRegistrationSuccess(chatId, userData, userId) {
        const dashboardUrl = `${WEB_DOMAIN}/dashboard?user=${userId}`;
        await bot.sendMessage(chatId,
            `🎉 *Account Created Successfully!*\n\n` +
            `👤 Welcome *${userData.name}*!\n` +
            `📧 ${userData.email}\n` +
            `🆔 ${userId}\n\n` +
            `🌐 *Dashboard:* ${dashboardUrl}\n\n` +
            `You can now deploy your WhatsApp bots!\n\n` +
            `Use /start to access your dashboard anytime.`,
            { parse_mode: 'Markdown' }
        );
    }

    async notifyAdminRegistration(userData, userId) {
        const user = this.db.getUser(userId);
        await bot.sendMessage(ADMIN_CHAT_ID,
            `🆕 *New User Registration*\n\n` +
            `👤 ${userData.name}\n` +
            `📧 ${userData.email}\n` +
            `🆔 ${userId}\n` +
            `🌐 IP: ${user.ip}\n` +
            `📅 ${new Date().toLocaleString()}`,
            { parse_mode: 'Markdown' }
        );
    }

    async sendError(chatId, message) {
        await bot.sendMessage(chatId, `❌ ${message}`);
    }

    // ==================== CALLBACK HANDLER ====================
    async handleCallback(callbackQuery) {
        const data = callbackQuery.data;
        
        if (data.startsWith('check_join_')) {
            const userId = data.split('_')[2];
            const hasJoined = await this.db.checkUserJoinedChannels(userId);
            
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
    }
}

// ==================== WEB SERVICE HEALTH CHECK ====================
async function waitForWebService() {
    console.log('⏳ Waiting for web service to be ready...');
    
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes max (30 * 10 seconds)
    
    while (attempts < maxAttempts) {
        try {
            const response = await axios.get(`${WEB_DOMAIN}/health`, { 
                timeout: 5000,
                validateStatus: () => true // Accept any status code
            });
            
            if (response.data && response.data.status === 'OK') {
                console.log(`✅ Web service is ready! (Attempt ${attempts + 1})`);
                return true;
            }
        } catch (error) {
            // Silent retry
        }
        
        attempts++;
        if (attempts % 5 === 0) {
            console.log(`⏰ Still waiting for web service... (${attempts}/${maxAttempts})`);
        }
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
    
    console.log('❌ Web service did not become ready in time');
    return false;
}

async function startKeepAlive() {
    const isReady = await waitForWebService();
    
    if (!isReady) {
        console.log('⚠️ Web service unavailable - bot will work in limited mode');
        return;
    }

    const pingWeb = async () => {
        try {
            const response = await axios.get(`${WEB_DOMAIN}/health`, { 
                timeout: 10000,
                validateStatus: () => true
            });
            console.log(`🌐 Web service ping: ${response.data?.status || 'unknown'} - ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            console.log(`❌ Web service ping failed: ${error.message}`);
        }
    };

    // Start pinging
    console.log('🔄 Starting keep-alive system...');
    await pingWeb();
    setInterval(pingWeb, 5 * 60 * 1000); // Ping every 5 minutes
    
    console.log('✅ Keep-alive system started');
}

// ==================== BOT INITIALIZATION ====================
const botManager = new BotManager();

// Set up event handlers
bot.onText(/\/start/, (msg) => botManager.handleStart(msg));
bot.onText(/\/register/, (msg) => botManager.handleRegister(msg));
bot.onText(/\/stats/, (msg) => botManager.handleStats(msg));
bot.onText(/\/help/, (msg) => botManager.handleHelp(msg));
bot.onText(/\/admin/, (msg) => botManager.handleAdmin(msg));
bot.onText(/\/backup/, (msg) => botManager.handleBackup(msg));
bot.on('message', (msg) => botManager.handleMessage(msg));
bot.on('callback_query', (callbackQuery) => botManager.handleCallback(callbackQuery));

// Error handling
bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.message);
});

bot.on('webhook_error', (error) => {
    console.error('❌ Webhook error:', error.message);
});

bot.on('error', (error) => {
    console.error('❌ Bot error:', error);
});

// ==================== STARTUP ====================
async function initializeBot() {
    try {
        console.log('🚀 Initializing Big Daddy V3 Bot...');
        
        // Test bot connection
        const me = await bot.getMe();
        console.log(`✅ Bot connected: @${me.username} (${me.first_name})`);
        
        // Start keep-alive system
        await startKeepAlive();
        
        console.log('✅ Big Daddy V3 Bot is fully operational!');
        console.log('📝 Available commands: /start, /register, /help, /admin, /stats, /backup');
        
    } catch (error) {
        console.error('❌ Bot initialization failed:', error);
        process.exit(1);
    }
}

// Start the bot
initializeBot();

module.exports = { bot, botManager };
