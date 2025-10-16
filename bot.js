const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Dropbox } = require('dropbox');
const NodeCache = require('node-cache');

// ==================== CONFIGURATION ====================
const IS_RENDER = process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_URL !== undefined;
const PORT = process.env.PORT || 3000;
const RENDER_DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// Auto-detect domain name (EXACTLY LIKE YOUR ORIGINAL CODE)
function getShortDomainName() {
    if (!RENDER_DOMAIN) return 'local';
    
    // Remove http:// or https://
    let domain = RENDER_DOMAIN.replace(/^https?:\/\//, '');
    
    // Remove .render.com and any other subdomains, keep only the main name
    domain = domain.replace(/\.render\.com$/, '');
    domain = domain.replace(/\.onrender\.com$/, '');
    domain = domain.split('.')[0]; // Take only the first part before any dots
    
    console.log(`database connected bigdaddyv3`);
    return domain || 'local';
}

const SHORT_DOMAIN = getShortDomainName();

// ==================== DROPBOX CONFIGURATION (YOUR EXACT KEYS) ====================
const DROPBOX_APP_KEY = 'ho5ep3i58l3tvgu';
const DROPBOX_APP_SECRET = '9fy0w0pgaafyk3e';
const DROPBOX_REFRESH_TOKEN = 'Vjhcbg66GMgAAAAAAAAAARJPgSupFcZdyXFkXiFx7VP-oXv_64RQKmtTLUYfPtm3';

const config = {
    // YOUR TELEGRAM BOT TOKEN
    telegramBotToken: '8494420933:AAFNh20zM_RHbP4ftWGcBEusD1VmcQlvg3E',
    webPort: PORT,
    webBaseUrl: RENDER_DOMAIN,
    
    // YOUR EXACT DROPBOX KEYS
    dropboxAppKey: DROPBOX_APP_KEY,
    dropboxAppSecret: DROPBOX_APP_SECRET,
    dropboxRefreshToken: DROPBOX_REFRESH_TOKEN,
    
    // Memory Management
    maxMemoryMB: 450,
    backupInterval: 60 * 60 * 1000, // 1 hour
    cleanupInterval: 30 * 60 * 1000, // 30 minutes
    reconnectDelay: 5000,
    maxReconnectAttempts: 5
};

// ==================== DROPBOX INTEGRATION (EXACTLY LIKE YOUR CODE) ====================
let dbx = null;
let isDropboxInitialized = false;

/**
 * Get Dropbox access token using refresh token - EXACTLY LIKE YOUR CODE
 */
async function getDropboxAccessToken() {
    try {
        console.log('🔑 Getting Dropbox access token...');
        
        if (!DROPBOX_REFRESH_TOKEN) {
            console.log('❌ No Dropbox refresh token configured');
            return null;
        }

        const response = await axios.post(
            'https://api.dropbox.com/oauth2/token',
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: DROPBOX_REFRESH_TOKEN,
                client_id: DROPBOX_APP_KEY,
                client_secret: DROPBOX_APP_SECRET
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout: 15000
            }
        );

        if (!response.data.access_token) {
            throw new Error('No access token in response');
        }

        console.log('✅ Dropbox access token obtained successfully');
        return response.data.access_token;
        
    } catch (error) {
        console.error('❌ Failed to get Dropbox access token:');
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', error.response.data);
        } else {
            console.error('   Message:', error.message);
        }
        return null;
    }
}

/**
 * Initialize Dropbox client - EXACTLY LIKE YOUR CODE
 */
async function initializeDropbox() {
    try {
        if (isDropboxInitialized && dbx) {
            return dbx;
        }

        console.log('🔄 Initializing Dropbox...');
        
        const accessToken = await getDropboxAccessToken();
        if (!accessToken) {
            console.log('❌ Failed to get Dropbox access token');
            return null;
        }
        
        // Initialize Dropbox with access token
        dbx = new Dropbox({ 
            accessToken: accessToken,
            clientId: DROPBOX_APP_KEY
        });
        
        // Test the connection
        try {
            await dbx.usersGetCurrentAccount();
            console.log('✅ Dropbox initialized and verified successfully');
            isDropboxInitialized = true;
            return dbx;
        } catch (testError) {
            console.log('❌ Dropbox connection test failed:', testError.message);
            return null;
        }
        
    } catch (error) {
        console.error('❌ Dropbox initialization failed:', error.message);
        return null;
    }
}

/**
 * Make Dropbox request with error handling - EXACTLY LIKE YOUR CODE
 */
async function makeDropboxRequest(apiCall) {
    try {
        if (!dbx) {
            await initializeDropbox();
            if (!dbx) {
                throw new Error('Dropbox client not available');
            }
        }
        return await apiCall();
    } catch (error) {
        console.error('Dropbox request error:', error);
        
        // If it's an auth error, try to refresh token once
        if (error.status === 401) {
            console.log('🔄 Authentication failed, refreshing token...');
            const newToken = await getDropboxAccessToken();
            if (newToken && dbx) {
                dbx.setAccessToken(newToken);
                // Retry the request once
                return await apiCall();
            }
        }
        throw error;
    }
}

/**
 * Backup database to Dropbox - ENHANCED VERSION
 */
async function backupDatabaseToDropbox() {
    try {
        if (!dbx) {
            await initializeDropbox();
            if (!dbx) {
                console.log('❌ Dropbox client not available for backup');
                return { success: false, error: 'Dropbox not configured' };
            }
        }

        if (!fs.existsSync(DB_PATH)) {
            console.log('📭 No database file to backup');
            return { success: false, error: 'No database found' };
        }

        console.log('📤 Backing up database to Dropbox...');

        const backupFolderName = SHORT_DOMAIN;
        const dbBuffer = fs.readFileSync(DB_PATH);
        
        await makeDropboxRequest(() =>
            dbx.filesUpload({
                path: `/${backupFolderName}/telegram_bot_database.json`,
                contents: dbBuffer,
                mode: { '.tag': 'overwrite' },
                autorename: false
            })
        );

        console.log('✅ Database backed up to Dropbox successfully');
        
        // Update backup history
        const db = readDatabase();
        db.backups = db.backups || [];
        db.backups.push({
            type: 'auto_backup',
            timestamp: new Date().toISOString(),
            success: true
        });
        
        // Keep only last 50 backup entries
        if (db.backups.length > 50) {
            db.backups = db.backups.slice(-50);
        }
        
        writeDatabase(db);
        
        return { 
            success: true, 
            message: 'Database backup completed',
            timestamp: new Date().toISOString(),
            domain: SHORT_DOMAIN
        };
        
    } catch (error) {
        console.error('❌ Error backing up database to Dropbox:', error.message);
        return { 
            success: false, 
            error: `Backup failed: ${error.message}` 
        };
    }
}

/**
 * Restore database from Dropbox - ENHANCED VERSION
 */
async function restoreDatabaseFromDropbox() {
    try {
        if (!dbx) {
            await initializeDropbox();
            if (!dbx) {
                console.log('❌ Dropbox client not available for restore');
                return false;
            }
        }

        console.log('🔍 Checking for Dropbox database backup...');
        
        const backupFolderName = SHORT_DOMAIN;

        try {
            // Check if backup exists
            await makeDropboxRequest(() =>
                dbx.filesGetMetadata({
                    path: `/${backupFolderName}/telegram_bot_database.json`
                })
            );

            // Download the backup
            const downloadResponse = await makeDropboxRequest(() =>
                dbx.filesDownload({
                    path: `/${backupFolderName}/telegram_bot_database.json`
                })
            );

            const dbBuffer = downloadResponse.result.fileBinary;
            fs.writeFileSync(DB_PATH, dbBuffer);
            
            console.log('✅ Database restored from Dropbox successfully');
            
            // Record restore in database
            const db = readDatabase();
            db.backups = db.backups || [];
            db.backups.push({
                type: 'restore',
                timestamp: new Date().toISOString(),
                success: true
            });
            writeDatabase(db);
            
            return true;
            
        } catch (error) {
            if (error.status === 409) {
                console.log('📭 No database backup found in Dropbox, starting fresh');
            } else {
                console.log('❌ Error restoring database:', error.message);
            }
            return false;
        }

    } catch (error) {
        console.error('❌ Error restoring database from Dropbox:', error.message);
        return false;
    }
}

// ==================== DATABASE SETUP ====================
const DB_PATH = path.join(__dirname, 'database.json');

function initDatabase() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const initialData = {
                users: {},
                settings: {
                    welcomeMessage: "Welcome! Please provide your email address to access your dashboard.",
                    webWelcomeMessage: "Welcome to your dashboard!"
                },
                backups: [],
                statistics: {
                    totalUsers: 0,
                    lastBackup: null,
                    startupCount: 0,
                    domain: SHORT_DOMAIN
                },
                version: '3.0'
            };
            fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
            console.log('✅ Database initialized');
        }
        
        // Update statistics (EXACTLY LIKE YOUR STYLE)
        const db = readDatabase();
        db.statistics.startupCount = (db.statistics.startupCount || 0) + 1;
        db.statistics.lastStartup = new Date().toISOString();
        db.statistics.domain = SHORT_DOMAIN;
        writeDatabase(db);
        
        console.log(`connecting to bigdaddy database`);
        console.log(`database connected bigdaddyv3`);
        
    } catch (error) {
        console.error('❌ Error initializing database:', error);
    }
}

function readDatabase() {
    try {
        const data = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('❌ Error reading database:', error);
        return { users: {}, settings: {}, statistics: {}, backups: [] };
    }
}

function writeDatabase(data) {
    try {
        // Update statistics (EXACTLY LIKE YOUR STYLE)
        data.statistics = data.statistics || {};
        data.statistics.totalUsers = Object.keys(data.users || {}).length;
        data.statistics.lastUpdate = new Date().toISOString();
        data.statistics.domain = SHORT_DOMAIN;
        
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        console.log(`database connected bigdaddyv3`);
        return true;
    } catch (error) {
        console.error('❌ Error writing database:', error);
        return false;
    }
}

function getUser(userId) {
    const db = readDatabase();
    return db.users[userId] || null;
}

function createOrUpdateUser(userId, userData) {
    const db = readDatabase();
    if (!db.users[userId]) {
        db.users[userId] = {
            id: userId,
            email: '',
            createdAt: new Date().toISOString(),
            ...userData
        };
        console.log(`✅ New user created: ${userId}`);
    } else {
        db.users[userId] = { ...db.users[userId], ...userData };
        console.log(`✅ User updated: ${userId}`);
    }
    
    // Add to backup history
    db.backups = db.backups || [];
    db.backups.push({
        type: 'user_update',
        userId: userId,
        timestamp: new Date().toISOString()
    });
    
    // Keep only last 100 backup entries
    if (db.backups.length > 100) {
        db.backups = db.backups.slice(-100);
    }
    
    return writeDatabase(db);
}

function setUserEmail(userId, email) {
    return createOrUpdateUser(userId, { 
        email: email,
        emailVerified: false,
        lastUpdated: new Date().toISOString()
    });
}

// ==================== MEMORY MANAGEMENT (EXACTLY LIKE YOUR CODE) ====================
const memoryCache = new NodeCache({ 
    stdTTL: 3600,
    checkperiod: 600
});

const sessionHealthMonitor = new Map();
const messageQueue = new Map();

function startMemoryCleanup() {
    setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
        
        console.log(`🧠 Memory usage: ${heapUsedMB.toFixed(2)}MB / ${config.maxMemoryMB}MB`);
        
        if (heapUsedMB > config.maxMemoryMB * 0.8) {
            console.log('⚠️ High memory usage detected, running cleanup...');
            performMemoryCleanup();
        }
        
        // Clean cache periodically (EXACTLY LIKE YOUR STYLE)
        const keys = memoryCache.keys();
        if (keys.length > 1000) {
            const half = Math.floor(keys.length / 2);
            keys.slice(0, half).forEach(key => memoryCache.del(key));
            console.log(`🗑️ Cleaned ${half} cache entries`);
        }
        
        // Clean message queues
        messageQueue.forEach((queue, phoneNumber) => {
            if (queue.length > 50) {
                messageQueue.set(phoneNumber, queue.slice(-50));
            }
        });
        
    }, config.cleanupInterval);
}

function performMemoryCleanup() {
    try {
        // Clear memory cache
        memoryCache.flushAll();
        
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
            console.log('🗑️ Manual garbage collection performed');
        }
        
        console.log('✅ Memory cleanup completed');
        console.log(`connecting to bigdaddy database`);
        
    } catch (error) {
        console.error('Memory cleanup error:', error);
    }
}

// ==================== AUTO-BACKUP SYSTEM ====================
function startAutoBackup() {
    console.log(`🔄 Starting automatic backups every ${config.backupInterval / 60000} minutes`);
    
    // Initial backup after 2 minutes
    setTimeout(async () => {
        console.log('🔄 Running initial automatic backup...');
        await backupDatabaseToDropbox().catch(console.error);
    }, 2 * 60 * 1000);

    // Regular backups
    setInterval(async () => {
        console.log('🔄 Running scheduled automatic backup...');
        const result = await backupDatabaseToDropbox().catch(console.error);
        
        // Record backup in database
        if (result && result.success) {
            const db = readDatabase();
            db.statistics.lastBackup = new Date().toISOString();
            writeDatabase(db);
        }
    }, config.backupInterval);

    // Backup on process exit (EXACTLY LIKE YOUR CODE)
    process.on('SIGINT', async () => {
        console.log('🚨 Process exiting, performing final backup...');
        await backupDatabaseToDropbox().catch(console.error);
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('🚨 Process terminating, performing final backup...');
        await backupDatabaseToDropbox().catch(console.error);
        process.exit(0);
    });
}

// ==================== EXPRESS WEB SERVER ====================
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Health check endpoint for auto-ping
app.get('/health', (req, res) => {
    const db = readDatabase();
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        statistics: db.statistics,
        domain: SHORT_DOMAIN,
        dropboxEnabled: true,
        telegramBot: true
    });
});

// Backup status endpoint
app.get('/backup-status', async (req, res) => {
    try {
        const db = readDatabase();
        res.json({
            success: true,
            lastBackup: db.statistics.lastBackup,
            totalUsers: db.statistics.totalUsers,
            startupCount: db.statistics.startupCount,
            domain: SHORT_DOMAIN,
            dropboxEnabled: true,
            telegramBot: true,
            backups: db.backups ? db.backups.slice(-10) : []
        });
    } catch (error) {
        console.error('Backup status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Manual backup trigger
app.get('/trigger-backup', async (req, res) => {
    try {
        console.log('💾 Manual backup triggered via web');
        const result = await backupDatabaseToDropbox();
        res.json(result);
    } catch (error) {
        console.error('Manual backup error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Web dashboard route
app.get('/dashboard/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        
        if (!user || !user.email) {
            return res.redirect('/error?message=User not found or email not provided');
        }
        
        const welcomeMessage = readDatabase().settings.webWelcomeMessage;
        
        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>User Dashboard</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    max-width: 800px; 
                    margin: 0 auto; 
                    padding: 20px; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    color: white;
                }
                .dashboard-container {
                    background: rgba(255,255,255,0.1);
                    backdrop-filter: blur(10px);
                    border-radius: 15px;
                    padding: 30px;
                    margin-top: 50px;
                    box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
                }
                .user-info {
                    background: rgba(255,255,255,0.2);
                    padding: 20px;
                    border-radius: 10px;
                    margin: 20px 0;
                }
                .btn {
                    background: #4CAF50;
                    color: white;
                    padding: 12px 24px;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                    text-decoration: none;
                    display: inline-block;
                    margin: 10px 5px;
                }
                .stats {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 10px;
                    margin: 20px 0;
                }
                .stat-item {
                    background: rgba(255,255,255,0.1);
                    padding: 15px;
                    border-radius: 8px;
                    text-align: center;
                }
            </style>
        </head>
        <body>
            <div class="dashboard-container">
                <h1>📊 Welcome to Your Dashboard</h1>
                <p>${welcomeMessage}</p>
                
                <div class="user-info">
                    <h3>User Information</h3>
                    <p><strong>User ID:</strong> ${user.id}</p>
                    <p><strong>Email:</strong> ${user.email}</p>
                    <p><strong>Member since:</strong> ${new Date(user.createdAt).toLocaleDateString()}</p>
                </div>
                
                <div class="stats">
                    <div class="stat-item">
                        <strong>Server</strong>
                        <p>${SHORT_DOMAIN}</p>
                    </div>
                    <div class="stat-item">
                        <strong>Status</strong>
                        <p>✅ Online</p>
                    </div>
                    <div class="stat-item">
                        <strong>Dropbox</strong>
                        <p>✅ Connected</p>
                    </div>
                    <div class="stat-item">
                        <strong>Telegram Bot</strong>
                        <p>✅ Active</p>
                    </div>
                </div>
                
                <div class="actions">
                    <h3>Quick Actions</h3>
                    <button onclick="refreshData()" class="btn">🔄 Refresh</button>
                    <a href="/backup-status" class="btn">💾 Backup Status</a>
                    <a href="/health" class="btn">🏥 Health Check</a>
                </div>
            </div>
            
            <script>
                function refreshData() {
                    location.reload();
                }
            </script>
        </body>
        </html>
        `;
        
        res.send(html);
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).send('Internal server error');
    }
});

// API endpoint to get user data
app.get('/api/user/:userId', (req, res) => {
    try {
        const user = getUser(req.params.userId);
        if (user) {
            res.json({ success: true, user });
        } else {
            res.status(404).json({ success: false, error: 'User not found' });
        }
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Error page
app.get('/error', (req, res) => {
    try {
        const message = req.query.message || 'An error occurred';
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Error</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                    .error { color: #ff4444; background: #ffeaea; padding: 20px; border-radius: 5px; }
                </style>
            </head>
            <body>
                <div class="error">
                    <h2>⚠️ Error</h2>
                    <p>${message}</p>
                    <a href="/">Go Home</a>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Error page error:', error);
        res.status(500).send('Internal server error');
    }
});

// Home page
app.get('/', (req, res) => {
    try {
        const db = readDatabase();
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Telegram Bot Dashboard</title>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        text-align: center; 
                        padding: 50px; 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        min-height: 100vh;
                    }
                    .container {
                        background: rgba(255,255,255,0.1);
                        backdrop-filter: blur(10px);
                        padding: 40px;
                        border-radius: 15px;
                        display: inline-block;
                    }
                    .stats {
                        margin: 20px 0;
                        padding: 15px;
                        background: rgba(255,255,255,0.1);
                        border-radius: 10px;
                    }
                    .status-badge {
                        display: inline-block;
                        padding: 5px 10px;
                        border-radius: 15px;
                        background: #4CAF50;
                        color: white;
                        font-size: 12px;
                        margin: 2px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🤖 Telegram Bot Dashboard</h1>
                    <p>Please use the Telegram bot to access your personal dashboard.</p>
                    
                    <div class="stats">
                        <p><strong>Server:</strong> ${SHORT_DOMAIN}</p>
                        <p><strong>Status:</strong> <span class="status-badge">✅ Online</span></p>
                        <p><strong>Total Users:</strong> ${db.statistics.totalUsers || 0}</p>
                        <p><strong>Dropbox Backup:</strong> <span class="status-badge">✅ Connected</span></p>
                        <p><strong>Telegram Bot:</strong> <span class="status-badge">✅ Active</span></p>
                        <p><strong>Startups:</strong> ${db.statistics.startupCount || 0}</p>
                    </div>
                    
                    <div>
                        <a href="/backup-status" style="color: white; margin: 10px;">📊 Backup Status</a>
                        <a href="/health" style="color: white; margin: 10px;">🏥 Health Check</a>
                        <a href="/trigger-backup" style="color: white; margin: 10px;">💾 Backup Now</a>
                    </div>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Home page error:', error);
        res.status(500).send('Internal server error');
    }
});

// ==================== TELEGRAM BOT SETUP ====================
let bot = null;

async function initializeTelegramBot() {
    try {
        bot = new Telegraf(config.telegramBotToken);
        bot.use(session());

        // Start command with interactive buttons
        bot.start(async (ctx) => {
            try {
                const userId = ctx.from.id.toString();
                const user = getUser(userId);
                const welcomeMessage = readDatabase().settings.welcomeMessage;
                
                if (user && user.email) {
                    await ctx.reply(
                        `Welcome back! Your registered email: ${user.email}\n\nAccess your dashboard:`,
                        Markup.inlineKeyboard([
                            [Markup.button.url('📊 Open Dashboard', `${config.webBaseUrl}/dashboard/${userId}`)],
                            [Markup.button.callback('✏️ Change Email', 'change_email')],
                            [Markup.button.url('🔗 Server Status', `${config.webBaseUrl}`)]
                        ])
                    );
                } else {
                    await ctx.reply(
                        welcomeMessage,
                        Markup.inlineKeyboard([
                            [Markup.button.callback('📧 Provide Email', 'provide_email')],
                            [Markup.button.url('🔗 Server Status', `${config.webBaseUrl}`)]
                        ])
                    );
                }
            } catch (error) {
                console.error('Start command error:', error);
                await ctx.reply('Sorry, an error occurred. Please try again.');
            }
        });

        bot.action('provide_email', async (ctx) => {
            try {
                await ctx.answerCbQuery();
                ctx.session.waitingForEmail = true;
                await ctx.reply('Please enter your email address:');
            } catch (error) {
                console.error('Provide email action error:', error);
            }
        });

        bot.action('change_email', async (ctx) => {
            try {
                await ctx.answerCbQuery();
                ctx.session.waitingForEmail = true;
                await ctx.reply('Please enter your new email address:');
            } catch (error) {
                console.error('Change email action error:', error);
            }
        });

        bot.on('text', async (ctx) => {
            try {
                const userId = ctx.from.id.toString();
                
                if (ctx.session && ctx.session.waitingForEmail) {
                    const email = ctx.message.text.trim();
                    
                    if (!email.includes('@') || !email.includes('.')) {
                        await ctx.reply('Please enter a valid email address:');
                        return;
                    }
                    
                    setUserEmail(userId, email);
                    ctx.session.waitingForEmail = false;
                    
                    await ctx.reply(
                        `✅ Thank you! Your email ${email} has been registered.\n\nYou can now access your dashboard:`,
                        Markup.inlineKeyboard([
                            [Markup.button.url('📊 Open Dashboard', `${config.webBaseUrl}/dashboard/${userId}`)],
                            [Markup.button.url('🔗 Server Status', `${config.webBaseUrl}`)]
                        ])
                    );
                    
                    // Auto-backup after new user registration
                    setTimeout(() => {
                        backupDatabaseToDropbox().catch(console.error);
                    }, 5000);
                }
            } catch (error) {
                console.error('Text message handler error:', error);
                await ctx.reply('Sorry, an error occurred. Please try again.');
            }
        });

        bot.on('callback_query', async (ctx) => {
            try {
                await ctx.answerCbQuery();
            } catch (error) {
                console.error('Callback query error:', error);
            }
        });

        bot.catch((err, ctx) => {
            console.error(`Telegram Bot Error for ${ctx.updateType}:`, err);
        });

        await bot.telegram.getMe();
        console.log('✅ Telegram bot connected successfully');
        return bot;
        
    } catch (error) {
        console.error('❌ Failed to initialize Telegram bot:', error.message);
        return null;
    }
}

// ==================== AUTO-PING SYSTEM FOR RENDER ====================
function startAutoPing() {
    if (!IS_RENDER) {
        console.log('🚫 Auto-ping disabled (not on Render)');
        return;
    }

    const pingInterval = 14 * 60 * 1000; // Ping every 14 minutes
    
    async function pingServer() {
        try {
            const response = await axios.get(`${config.webBaseUrl}/health`, { timeout: 10000 });
            console.log(`✅ Auto-ping successful: ${response.data.status}`);
        } catch (error) {
            console.warn(`⚠️ Auto-ping failed: ${error.message}`);
        }
    }

    setTimeout(() => {
        pingServer();
        setInterval(pingServer, pingInterval);
    }, 60000);

    console.log(`🔄 Auto-ping started for Render (every ${pingInterval/60000} minutes)`);
}

// ==================== START SERVERS ====================
async function startServers() {
    try {
        console.log('🚀 Starting Telegram Bot Dashboard...');
        console.log(`🌐 Domain: ${SHORT_DOMAIN}`);
        console.log(`🔗 URL: ${config.webBaseUrl}`);
        console.log(`🤖 Bot Token: ${config.telegramBotToken ? '✅ Configured' : '❌ Missing'}`);
        console.log(`📦 Dropbox: ${DROPBOX_REFRESH_TOKEN ? '✅ Configured' : '❌ Missing'}`);
        
        // Initialize database
        initDatabase();
        
        // Try to restore from Dropbox on startup
        console.log('🔄 Checking for Dropbox backup...');
        await restoreDatabaseFromDropbox();
        
        // Start web server
        const server = app.listen(config.webPort, '0.0.0.0', () => {
            console.log(`✅ Web server running on port ${config.webPort}`);
            console.log(`📊 Dashboard: ${config.webBaseUrl}`);
            console.log(`🏥 Health: ${config.webBaseUrl}/health`);
            console.log(`💾 Backup: ${config.webBaseUrl}/backup-status`);
            console.log(`connecting to bigdaddy database`);
            console.log(`database connected bigdaddyv3`);
        });

        // Start all background services
        startAutoPing();
        startAutoBackup();
        startMemoryCleanup();

        // Initialize Telegram bot
        const telegramBot = await initializeTelegramBot();
        
        if (telegramBot) {
            await telegramBot.launch();
            console.log('✅ Telegram bot started successfully');
        } else {
            console.log('ℹ️  Running in web-only mode (no Telegram bot)');
        }
        
        // Graceful shutdown
        process.once('SIGINT', () => gracefulShutdown(telegramBot, server));
        process.once('SIGTERM', () => gracefulShutdown(telegramBot, server));
        
    } catch (error) {
        console.error('❌ Failed to start servers:', error);
        process.exit(1);
    }
}

async function gracefulShutdown(telegramBot, server) {
    console.log('🛑 Shutting down gracefully...');
    
    // Final backup
    await backupDatabaseToDropbox().catch(console.error);
    
    if (telegramBot) {
        await telegramBot.stop();
    }
    
    server.close(() => {
        console.log('✅ Server shut down successfully');
        process.exit(0);
    });
}

// ==================== GLOBAL ERROR HANDLING ====================
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

// Start everything
console.log(`connecting to bigdaddy database`);
console.log(`database connected bigdaddyv3`);
startServers();

module.exports = {
    readDatabase,
    getUser,
    createOrUpdateUser,
    backupDatabaseToDropbox
};
