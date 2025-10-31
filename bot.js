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

// Admin configuration
const ADMIN_CHAT_ID = '6300694007'; // Your admin chat ID
const ADMIN_USERNAME = 'admin'; // Admin username for web dashboard
const verificationJobs = new Map(); // In-memory storage (use database in production)

// Auto-detect domain name
function getShortDomainName() {
    if (!RENDER_DOMAIN) return 'local';
    
    let domain = RENDER_DOMAIN.replace(/^https?:\/\//, '');
    domain = domain.replace(/\.render\.com$/, '');
    domain = domain.replace(/\.onrender\.com$/, '');
    domain = domain.split('.')[0];
    
    console.log(`🚀 BIG DADDY V3 - Optimized for 2000+ Users`);
    return domain || 'local';
}

const SHORT_DOMAIN = getShortDomainName();

// ==================== DROPBOX CONFIGURATION ====================
const DROPBOX_APP_KEY = 'ho5ep3i58l3tvgu';
const DROPBOX_APP_SECRET = '9fy0w0pgaafyk3e';
const DROPBOX_REFRESH_TOKEN = 'Vjhcbg66GMgAAAAAAAAAARJPgSupFcZdyXFkXiFx7VP-oXv_64RQKmtTLUYfPtm3';

const config = {
    telegramBotToken: '8494420933:AAFE3KUjFbOgmx-Bnqj1i7l2Jaxnzu0UXec',
    webPort: PORT,
    webBaseUrl: RENDER_DOMAIN,
    
    dropboxAppKey: DROPBOX_APP_KEY,
    dropboxAppSecret: DROPBOX_APP_SECRET,
    dropboxRefreshToken: DROPBOX_REFRESH_TOKEN,
    
    maxMemoryMB: 512, // Increased for 2000+ users
    backupInterval: 30 * 60 * 1000, // 30 minutes for frequent backups
    cleanupInterval: 15 * 60 * 1000, // 15 minutes for memory cleanup
    reconnectDelay: 5000,
    maxReconnectAttempts: 5
};

// ==================== OPTIMIZED DROPBOX INTEGRATION ====================
let dbx = null;
let isDropboxInitialized = false;

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
        
        dbx = new Dropbox({ 
            accessToken: accessToken,
            clientId: DROPBOX_APP_KEY
        });
        
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
        
        if (error.status === 401) {
            console.log('🔄 Authentication failed, refreshing token...');
            const newToken = await getDropboxAccessToken();
            if (newToken && dbx) {
                dbx.setAccessToken(newToken);
                return await apiCall();
            }
        }
        throw error;
    }
}

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
        
        const db = readDatabase();
        db.backups = db.backups || [];
        db.backups.push({
            type: 'auto_backup',
            timestamp: new Date().toISOString(),
            success: true,
            userCount: Object.keys(db.users || {}).length
        });
        
        // Keep only last 20 backups to save memory
        if (db.backups.length > 20) {
            db.backups = db.backups.slice(-20);
        }
        
        writeDatabase(db);
        
        return { 
            success: true, 
            message: 'Database backup completed',
            timestamp: new Date().toISOString(),
            domain: SHORT_DOMAIN,
            userCount: Object.keys(db.users || {}).length
        };
        
    } catch (error) {
        console.error('❌ Error backing up database to Dropbox:', error.message);
        return { 
            success: false, 
            error: `Backup failed: ${error.message}` 
        };
    }
}

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
            await makeDropboxRequest(() =>
                dbx.filesGetMetadata({
                    path: `/${backupFolderName}/telegram_bot_database.json`
                })
            );

            const downloadResponse = await makeDropboxRequest(() =>
                dbx.filesDownload({
                    path: `/${backupFolderName}/telegram_bot_database.json`
                })
            );

            const dbBuffer = downloadResponse.result.fileBinary;
            
            // Create backup of current database before restore
            if (fs.existsSync(DB_PATH)) {
                const backupPath = `${DB_PATH}.pre_restore.${Date.now()}.json`;
                fs.copyFileSync(DB_PATH, backupPath);
                console.log(`📦 Created pre-restore backup: ${backupPath}`);
            }
            
            fs.writeFileSync(DB_PATH, dbBuffer);
            
            console.log('✅ Database restored from Dropbox successfully');
            
            const db = readDatabase();
            db.backups = db.backups || [];
            db.backups.push({
                type: 'restore',
                timestamp: new Date().toISOString(),
                success: true,
                userCount: Object.keys(db.users || {}).length
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

// ==================== OPTIMIZED DATABASE SETUP (2000+ USERS) ====================
const DB_PATH = path.join(__dirname, 'database.json');

function initDatabase() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const initialData = {
                users: {},
                settings: {
                    welcomeMessage: "👋 *Welcome to BIG DADDY V3 Bot!*\n\nTo access the bot, you need to join our sponsor channels first. After joining all required channels, you'll be able to create your account and start using the bot features.",
                    webWelcomeMessage: "🎉 Welcome to your dashboard!",
                    adminWelcomeMessage: "👑 *Welcome to Admin Panel*\n\nManage your bot users and monitor statistics."
                },
                backups: [],
                statistics: {
                    totalUsers: 0,
                    lastBackup: null,
                    startupCount: 0,
                    domain: SHORT_DOMAIN,
                    usersToday: 0,
                    lastReset: new Date().toISOString().split('T')[0],
                    performance: {
                        avgResponseTime: 0,
                        lastOptimization: new Date().toISOString()
                    }
                },
                admin: {
                    chatId: ADMIN_CHAT_ID,
                    username: ADMIN_USERNAME,
                    lastActive: new Date().toISOString()
                },
                groups: [],
                pendingGroups: [],
                membershipChecks: {},
                endpointUsage: {},
                whatsappSessions: {},
                endpointHealth: {},
                version: '3.2-optimized'
            };
            fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
            console.log('✅ Database initialized with optimized structure');
        } else {
            const db = readDatabase();
            if (!db.settings) db.settings = {};
            if (!db.settings.webWelcomeMessage) db.settings.webWelcomeMessage = "🎉 Welcome to your dashboard!";
            if (!db.settings.welcomeMessage) db.settings.welcomeMessage = "👋 *Welcome to BIG DADDY V3 Bot!*\n\nTo access the bot, you need to join our sponsor channels first. After joining all required channels, you'll be able to create your account and start using the bot features.";
            if (!db.settings.adminWelcomeMessage) db.settings.adminWelcomeMessage = "👑 *Welcome to Admin Panel*\n\nManage your bot users and monitor statistics.";
            if (!db.groups) db.groups = [];
            if (!db.pendingGroups) db.pendingGroups = [];
            if (!db.membershipChecks) db.membershipChecks = {};
            if (!db.endpointUsage) db.endpointUsage = {};
            if (!db.whatsappSessions) db.whatsappSessions = {};
            if (!db.endpointHealth) db.endpointHealth = {};
            if (!db.statistics.performance) db.statistics.performance = {
                avgResponseTime: 0,
                lastOptimization: new Date().toISOString()
            };
            writeDatabase(db);
        }
        
        const db = readDatabase();
        db.statistics.startupCount = (db.statistics.startupCount || 0) + 1;
        db.statistics.lastStartup = new Date().toISOString();
        db.statistics.domain = SHORT_DOMAIN;
        
        const today = new Date().toISOString().split('T')[0];
        if (db.statistics.lastReset !== today) {
            db.statistics.usersToday = 0;
            db.statistics.lastReset = today;
        }
        
        writeDatabase(db);
        
        console.log(`📊 Database ready for 2000+ users`);
        
    } catch (error) {
        console.error('❌ Error initializing database:', error);
    }
}

// OPTIMIZED: Fast database read with corruption recovery
function readDatabase() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            console.log('📭 Database file not found, creating new one...');
            initDatabase();
        }
        
        const data = fs.readFileSync(DB_PATH, 'utf8');
        
        // Check if file is empty or invalid
        if (!data || data.trim() === '') {
            console.log('⚠️ Database file empty, reinitializing...');
            initDatabase();
            return readDatabase();
        }
        
        const parsedData = JSON.parse(data);
        
        // Validate structure
        if (!parsedData.users || typeof parsedData.users !== 'object') {
            console.log('⚠️ Invalid database structure, rebuilding...');
            initDatabase();
            return readDatabase();
        }
        
        return parsedData;
        
    } catch (error) {
        console.error('❌ Critical error reading database:', error);
        
        // Create backup of corrupted file
        try {
            if (fs.existsSync(DB_PATH)) {
                const backupPath = `${DB_PATH}.corrupted.${Date.now()}.json`;
                fs.copyFileSync(DB_PATH, backupPath);
                console.log(`📦 Created backup of corrupted file: ${backupPath}`);
            }
        } catch (backupError) {
            console.error('❌ Failed to create backup:', backupError);
        }
        
        // Reinitialize database
        initDatabase();
        return readDatabase();
    }
}

// OPTIMIZED: Atomic write with validation
function writeDatabase(data) {
    try {
        // Validate data structure
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid data provided to writeDatabase');
        }
        
        // Ensure required structures exist
        data.users = data.users || {};
        data.settings = data.settings || {};
        data.statistics = data.statistics || {};
        data.backups = data.backups || [];
        data.groups = data.groups || [];
        data.pendingGroups = data.pendingGroups || [];
        
        // Update statistics efficiently
        const userCount = Object.keys(data.users).length;
        data.statistics.totalUsers = userCount;
        data.statistics.lastUpdate = new Date().toISOString();
        data.statistics.domain = SHORT_DOMAIN;
        
        // Limit backups array size for performance
        if (data.backups.length > 20) {
            data.backups = data.backups.slice(-10);
        }
        
        // Clean up old membership checks (keep only last 1000)
        if (data.membershipChecks && Object.keys(data.membershipChecks).length > 1000) {
            const keys = Object.keys(data.membershipChecks);
            const toDelete = keys.slice(0, keys.length - 1000);
            toDelete.forEach(key => delete data.membershipChecks[key]);
        }
        
        // Write to temporary file first (atomic write)
        const tempPath = `${DB_PATH}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
        
        // Replace original file
        fs.renameSync(tempPath, DB_PATH);
        
        return true;
        
    } catch (error) {
        console.error('❌ Critical error writing database:', error);
        return false;
    }
}

// OPTIMIZED: Fast user functions
function getUser(userId) {
    const db = readDatabase();
    return db.users[userId] || null;
}

function createOrUpdateUser(userId, userData) {
    const db = readDatabase();
    const isNewUser = !db.users[userId];
    
    // Validate user ID
    if (!userId || typeof userId !== 'string') {
        console.error('❌ Invalid user ID:', userId);
        return false;
    }
    
    try {
        if (!db.users[userId]) {
            // New user - optimized structure
            db.users[userId] = {
                id: userId,
                firstName: userData.firstName || '',
                lastName: userData.lastName || '',
                email: userData.email || '',
                profileCompleted: userData.profileCompleted || false,
                createdAt: new Date().toISOString(),
                lastUpdated: new Date().toISOString()
            };
            
            // Update daily statistics
            const today = new Date().toISOString().split('T')[0];
            if (db.statistics.lastReset !== today) {
                db.statistics.usersToday = 0;
                db.statistics.lastReset = today;
            }
            db.statistics.usersToday = (db.statistics.usersToday || 0) + 1;
            
        } else {
            // Update existing user
            db.users[userId] = { 
                ...db.users[userId], 
                ...userData,
                lastUpdated: new Date().toISOString()
            };
        }
        
        // Add to backup log (limited size)
        db.backups = db.backups || [];
        if (db.backups.length < 20) {
            db.backups.push({
                type: 'user_update',
                userId: userId,
                timestamp: new Date().toISOString(),
                isNewUser: isNewUser
            });
        }
        
        const success = writeDatabase(db);
        
        if (success && isNewUser) {
            const userCount = Object.keys(db.users).length;
            if (userCount % 100 === 0) {
                console.log(`📈 User milestone: ${userCount} users`);
            }
        }
        
        return success;
        
    } catch (error) {
        console.error('❌ Error in createOrUpdateUser:', error);
        return false;
    }
}

function setUserProfile(userId, firstName, lastName, email) {
    return createOrUpdateUser(userId, { 
        firstName: firstName,
        lastName: lastName,
        email: email,
        profileCompleted: true,
        lastUpdated: new Date().toISOString()
    });
}

function deleteUser(userId) {
    const db = readDatabase();
    if (db.users[userId]) {
        delete db.users[userId];
        writeDatabase(db);
        return true;
    }
    return false;
}

function isAdmin(userId) {
    return userId.toString() === ADMIN_CHAT_ID.toString();
}

// OPTIMIZED: Fast statistics
function getStatistics() {
    const db = readDatabase();
    const users = Object.values(db.users);
    
    const today = new Date().toISOString().split('T')[0];
    const usersCreatedToday = users.filter(user => 
        user.createdAt && user.createdAt.startsWith(today)
    ).length;
    
    return {
        totalUsers: users.length,
        usersToday: usersCreatedToday,
        usersWithProfile: users.filter(user => user.profileCompleted).length,
        usersWithoutProfile: users.filter(user => !user.profileCompleted).length,
        lastBackup: db.statistics.lastBackup,
        startupCount: db.statistics.startupCount,
        domain: SHORT_DOMAIN
    };
}

// ==================== OPTIMIZED SMART ENDPOINT LOAD BALANCING ====================

const ENDPOINTS = {
    'none': [
        'https://oksy-49a32a775bb9.herokuapp.com', 
        'https://non-9fa7f7c4a74d.herokuapp.com',
        'https://nonnn-624b161afabe.herokuapp.com'
    ],
    '.': [
        'https://prefix-3b5785b66c22.herokuapp.com',
        'https://pref-39f472260e1c.herokuapp.com',
        'https://preeedot-6967a0e18b91.herokuapp.com'
    ],
    '!': [
        'https://prefixcommand-6d3179536193.herokuapp.com',
        'https://preficommand-9486c706544b.herokuapp.com',
        'https://preficomm-255b9e9d55f4.herokuapp.com'
    ],
    '/': [
        'https://phistarg-a48c1739165f.herokuapp.com',
        'https://prefixgg-26fb1dbefc0a.herokuapp.com',
        'https://prefixggg-7df02a416ec2.herokuapp.com'
    ],
    "'": [
        'https://philiphh-bf43061b2139.herokuapp.com',
        'https://projecthhh-337aded06efd.herokuapp.com'
    ]
};

// Initialize endpoint tracking
function initEndpointTracking() {
    const db = readDatabase();
    
    if (!db.endpointUsage) db.endpointUsage = {};
    if (!db.endpointHealth) db.endpointHealth = {};
    
    Object.keys(ENDPOINTS).forEach(prefix => {
        ENDPOINTS[prefix].forEach(endpoint => {
            if (!db.endpointUsage[endpoint]) {
                db.endpointUsage[endpoint] = {
                    userCount: 0,
                    lastUsed: null,
                    prefix: prefix,
                    totalAssigned: 0
                };
            }
            
            if (!db.endpointHealth[endpoint]) {
                db.endpointHealth[endpoint] = {
                    status: 'unknown',
                    lastChecked: null,
                    responseTime: null,
                    errorCount: 0,
                    successCount: 0
                };
            }
        });
    });
    
    writeDatabase(db);
}

// Check endpoint health
async function checkEndpointHealth(endpoint) {
    try {
        const startTime = Date.now();
        const response = await axios.get(`${endpoint}/sessions`, { timeout: 10000 });
        const responseTime = Date.now() - startTime;
        
        if (response.data && response.data.success) {
            return {
                status: 'healthy',
                responseTime: responseTime,
                sessionsCount: response.data.sessions ? response.data.sessions.length : 0
            };
        } else {
            return {
                status: 'unhealthy',
                responseTime: responseTime,
                error: 'Invalid response data'
            };
        }
    } catch (error) {
        return {
            status: 'down',
            responseTime: null,
            error: error.message
        };
    }
}

// Health check all endpoints
async function healthCheckAllEndpoints() {
    console.log('🔍 Performing health check on all endpoints...');
    
    const db = readDatabase();
    const allEndpoints = Object.keys(db.endpointHealth || {});
    let healthyCount = 0;
    
    for (const endpoint of allEndpoints) {
        try {
            const health = await checkEndpointHealth(endpoint);
            
            db.endpointHealth[endpoint] = {
                ...db.endpointHealth[endpoint],
                ...health,
                lastChecked: new Date().toISOString()
            };
            
            if (health.status === 'healthy') {
                healthyCount++;
                db.endpointHealth[endpoint].successCount = (db.endpointHealth[endpoint].successCount || 0) + 1;
                db.endpointHealth[endpoint].errorCount = 0;
            } else {
                db.endpointHealth[endpoint].errorCount = (db.endpointHealth[endpoint].errorCount || 0) + 1;
            }
            
            // Fast health checks - no delay between checks for speed
            
        } catch (error) {
            console.error(`❌ Error checking health for ${endpoint}:`, error.message);
        }
    }
    
    writeDatabase(db);
    console.log(`✅ Health check completed: ${healthyCount}/${allEndpoints.length} healthy`);
    
    return { healthy: healthyCount, total: allEndpoints.length };
}

// OPTIMIZED: Get balanced endpoint (fast selection)
function getBalancedEndpoint(prefix) {
    const db = readDatabase();
    
    if (!db.endpointUsage || !db.endpointHealth) {
        initEndpointTracking();
    }
    
    const endpoints = ENDPOINTS[prefix] || [];
    
    if (endpoints.length === 0) {
        return null;
    }
    
    // Filter only healthy endpoints
    const healthyEndpoints = endpoints.filter(endpoint => {
        const health = db.endpointHealth[endpoint];
        return health && health.status === 'healthy';
    });
    
    const availableEndpoints = healthyEndpoints.length > 0 ? healthyEndpoints : endpoints;
    
    // Find endpoint with least users
    let minUsers = Infinity;
    let selectedEndpoint = null;
    
    availableEndpoints.forEach(endpoint => {
        const usage = db.endpointUsage[endpoint];
        if (usage.userCount < minUsers) {
            minUsers = usage.userCount;
            selectedEndpoint = endpoint;
        }
    });
    
    if (selectedEndpoint) {
        // Update usage count
        db.endpointUsage[selectedEndpoint].userCount++;
        db.endpointUsage[selectedEndpoint].lastUsed = new Date().toISOString();
        db.endpointUsage[selectedEndpoint].totalAssigned++;
        writeDatabase(db);
    }
    
    return selectedEndpoint;
}

// Release endpoint
function releaseEndpoint(endpoint) {
    const db = readDatabase();
    
    if (db.endpointUsage && db.endpointUsage[endpoint]) {
        if (db.endpointUsage[endpoint].userCount > 0) {
            db.endpointUsage[endpoint].userCount--;
        }
        writeDatabase(db);
    }
}

// ==================== OPTIMIZED WHATSAPP SESSIONS MANAGEMENT ====================

// Fast session updates
async function updateWhatsAppSessions() {
    try {
        const db = readDatabase();
        const allEndpoints = new Set();
        
        Object.keys(db.endpointUsage || {}).forEach(endpoint => {
            allEndpoints.add(endpoint);
        });
        
        let totalSessions = 0;
        
        for (const endpoint of allEndpoints) {
            try {
                const sessionsUrl = `${endpoint}/sessions`;
                const response = await fetch(sessionsUrl, { timeout: 5000 }); // Shorter timeout
                
                if (response.ok) {
                    const data = await response.json();
                    
                    if (data.success && data.sessions) {
                        if (!db.whatsappSessions) db.whatsappSessions = {};
                        
                        data.sessions.forEach(session => {
                            const sessionKey = `${endpoint}_${session.phoneNumber}`;
                            db.whatsappSessions[sessionKey] = {
                                phoneNumber: session.phoneNumber,
                                endpoint: endpoint,
                                mode: session.mode || 'unknown',
                                health: session.health || 'unknown',
                                isConnected: session.isConnected || false,
                                lastUpdated: new Date().toISOString()
                            };
                        });
                        
                        totalSessions += data.sessions.length;
                    }
                }
                
            } catch (error) {
                // Silent fail for speed
            }
        }
        
        writeDatabase(db);
        
        return { success: true, sessionsFound: totalSessions };
        
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Fast user sessions retrieval
function getUserWhatsAppSessions(userId) {
    const db = readDatabase();
    const user = db.users[userId];
    
    if (!user || !user.activeBots) {
        return [];
    }
    
    return user.activeBots.map(bot => {
        if (bot.number && bot.endpoint) {
            const sessionKey = `${bot.endpoint}_${bot.number}`;
            const sessionData = db.whatsappSessions?.[sessionKey];
            
            return sessionData ? {
                ...sessionData,
                prefix: bot.prefix,
                startTime: bot.startTime,
                status: bot.status || 'unknown'
            } : {
                phoneNumber: bot.number,
                endpoint: bot.endpoint,
                prefix: bot.prefix,
                isConnected: false,
                status: bot.status || 'unknown'
            };
        }
        return null;
    }).filter(Boolean);
}

function getAllWhatsAppSessions() {
    const db = readDatabase();
    return db.whatsappSessions || {};
}

// ==================== OPTIMIZED REAL-TIME NOTIFICATIONS ====================

const connectedClients = new Map();

function notifyConnectionStatus(userId, phoneNumber, isConnected) {
    const client = connectedClients.get(userId);
    if (client) {
        client.write(`data: ${JSON.stringify({
            type: 'connection_status',
            phoneNumber,
            isConnected,
            timestamp: new Date().toISOString()
        })}\n\n`);
    }
}

// ==================== OPTIMIZED GROUP MANAGEMENT ====================

function addPendingGroup(groupData) {
    const db = readDatabase();
    if (!db.pendingGroups) db.pendingGroups = [];
    
    const existingGroup = db.pendingGroups.find(g => g.id === groupData.id);
    if (!existingGroup) {
        db.pendingGroups.push({
            id: groupData.id,
            title: groupData.title,
            username: groupData.username,
            inviteLink: groupData.inviteLink,
            type: groupData.type,
            detectedAt: new Date().toISOString(),
            status: 'pending'
        });
        writeDatabase(db);
        return true;
    }
    return false;
}

async function approveGroup(groupId) {
    const db = readDatabase();
    if (!db.pendingGroups) return false;
    
    const pendingGroup = db.pendingGroups.find(g => g.id === groupId);
    if (pendingGroup) {
        db.pendingGroups = db.pendingGroups.filter(g => g.id !== groupId);
        
        if (!db.groups) db.groups = [];
        
        let inviteLink = pendingGroup.inviteLink;
        
        if (!inviteLink && bot) {
            try {
                if (pendingGroup.type !== 'channel') {
                    const invite = await bot.telegram.createChatInviteLink(pendingGroup.id, {
                        creates_join_request: false,
                        expire_date: null,
                        member_limit: null
                    });
                    inviteLink = invite.invite_link;
                } else if (pendingGroup.username) {
                    inviteLink = `https://t.me/${pendingGroup.username}`;
                }
            } catch (error) {
                console.error('Error generating invite link:', error);
            }
        }
        
        const enhancedGroupData = {
            id: pendingGroup.id,
            title: pendingGroup.title,
            username: pendingGroup.username,
            inviteLink: inviteLink,
            type: pendingGroup.type,
            addedAt: new Date().toISOString(),
            isActive: true,
            approvedBy: ADMIN_CHAT_ID
        };
        
        db.groups.push(enhancedGroupData);
        writeDatabase(db);
        
        if (bot) {
            await bot.telegram.sendMessage(
                ADMIN_CHAT_ID,
                `✅ *Sponsor Approved!*\n\n📝 ${pendingGroup.title}\n📋 ${pendingGroup.type}`,
                { parse_mode: 'Markdown' }
            );
        }
        
        return true;
    }
    return false;
}

function rejectGroup(groupId) {
    const db = readDatabase();
    if (!db.pendingGroups) return false;
    
    const initialLength = db.pendingGroups.length;
    db.pendingGroups = db.pendingGroups.filter(g => g.id !== groupId);
    
    if (db.pendingGroups.length !== initialLength) {
        writeDatabase(db);
        return true;
    }
    return false;
}

function getPendingGroups() {
    const db = readDatabase();
    return db.pendingGroups || [];
}

async function addGroupWithInvite(groupData) {
    try {
        const db = readDatabase();
        if (!db.groups) db.groups = [];
        
        const existingGroup = db.groups.find(g => g.id === groupData.id);
        if (existingGroup) return false;

        let inviteLink = groupData.inviteLink;
        
        if (!inviteLink && bot) {
            try {
                if (groupData.type !== 'channel') {
                    const invite = await bot.telegram.createChatInviteLink(groupData.id, {
                        creates_join_request: false,
                        expire_date: null,
                        member_limit: null
                    });
                    inviteLink = invite.invite_link;
                } else if (groupData.username) {
                    inviteLink = `https://t.me/${groupData.username}`;
                }
            } catch (error) {
                console.error('Error generating invite link:', error);
            }
        }

        const enhancedGroupData = {
            ...groupData,
            inviteLink: inviteLink,
            addedAt: new Date().toISOString(),
            isActive: true,
            approvedBy: ADMIN_CHAT_ID
        };
        
        db.groups.push(enhancedGroupData);
        writeDatabase(db);
        return true;
    } catch (error) {
        console.error('Error adding group with invite:', error);
        return false;
    }
}

function addGroup(groupData) {
    const db = readDatabase();
    if (!db.groups) db.groups = [];
    
    const existingGroup = db.groups.find(g => g.id === groupData.id);
    if (!existingGroup) {
        db.groups.push({
            id: groupData.id,
            title: groupData.title,
            username: groupData.username,
            inviteLink: groupData.inviteLink,
            type: groupData.type,
            addedAt: new Date().toISOString(),
            isActive: true,
            approvedBy: ADMIN_CHAT_ID
        });
        writeDatabase(db);
        return true;
    }
    return false;
}

function removeGroup(groupId) {
    const db = readDatabase();
    if (!db.groups) return false;
    
    const initialLength = db.groups.length;
    db.groups = db.groups.filter(g => g.id !== groupId);
    
    if (db.groups.length !== initialLength) {
        writeDatabase(db);
        return true;
    }
    return false;
}

function getGroups() {
    const db = readDatabase();
    return db.groups || [];
}

function updateUserMembership(userId, isMember) {
    const db = readDatabase();
    if (!db.membershipChecks) db.membershipChecks = {};
    
    db.membershipChecks[userId] = {
        isMember: isMember,
        lastChecked: new Date().toISOString()
    };
    
    if (db.users[userId]) {
        db.users[userId].hasAccess = isMember;
        db.users[userId].lastMembershipCheck = new Date().toISOString();
    }
    
    writeDatabase(db);
}

function checkUserAccess(userId) {
    const db = readDatabase();
    const user = db.users[userId];
    const groups = db.groups || [];
    
    if (groups.length === 0) {
        return true;
    }
    
    return user && user.hasAccess === true;
}

// ==================== OPTIMIZED MEMBERSHIP VERIFICATION ====================

let bot = null;

async function checkUserMembership(userId) {
    try {
        const groups = getGroups();
        
        if (groups.length === 0) {
            updateUserMembership(userId, true);
            return { hasAccess: true, notJoinedGroups: [] };
        }
        
        let allGroupsJoined = true;
        const notJoinedGroups = [];
        
        for (const group of groups) {
            try {
                if (!bot) {
                    allGroupsJoined = false;
                    notJoinedGroups.push(group);
                    continue;
                }
                
                let isMember = false;
                
                if (group.type === 'channel') {
                    try {
                        const chatMember = await bot.telegram.getChatMember(group.id, userId);
                        isMember = ['creator', 'administrator', 'member'].includes(chatMember.status);
                    } catch (error) {
                        isMember = false;
                    }
                } else {
                    try {
                        const chatMember = await bot.telegram.getChatMember(group.id, userId);
                        isMember = ['creator', 'administrator', 'member', 'restricted'].includes(chatMember.status);
                    } catch (error) {
                        isMember = false;
                    }
                }
                
                if (!isMember) {
                    allGroupsJoined = false;
                    notJoinedGroups.push(group);
                }
            } catch (error) {
                allGroupsJoined = false;
                notJoinedGroups.push(group);
            }
            
            // Fast verification - minimal delay
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        updateUserMembership(userId, allGroupsJoined);
        
        return {
            hasAccess: allGroupsJoined,
            notJoinedGroups: notJoinedGroups
        };
        
    } catch (error) {
        console.error('❌ Error in checkUserMembership:', error);
        updateUserMembership(userId, false);
        return { hasAccess: false, notJoinedGroups: getGroups() };
    }
}

async function generateGroupInviteLink(chatId) {
    try {
        if (!bot) return null;
        
        const inviteLink = await bot.telegram.createChatInviteLink(chatId, {
            creates_join_request: false,
            expire_date: null,
            member_limit: null
        });
        
        return inviteLink.invite_link;
    } catch (error) {
        console.error('Error generating invite link:', error);
        return null;
    }
}

// ==================== OPTIMIZED MEMORY MANAGEMENT ====================
const memoryCache = new NodeCache({ 
    stdTTL: 1800, // 30 minutes
    checkperiod: 300,
    maxKeys: 1000 // Limit cache size
});

function startMemoryCleanup() {
    setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
        
        if (heapUsedMB > config.maxMemoryMB * 0.8) {
            performMemoryCleanup();
        }
        
        // Clean cache if too large
        const keys = memoryCache.keys();
        if (keys.length > 800) {
            const toDelete = keys.slice(0, 400);
            toDelete.forEach(key => memoryCache.del(key));
        }
        
    }, config.cleanupInterval);
}

function performMemoryCleanup() {
    try {
        memoryCache.flushAll();
        
        if (global.gc) {
            global.gc();
        }
        
    } catch (error) {
        console.error('Memory cleanup error:', error);
    }
}

// ==================== OPTIMIZED AUTO-BACKUP SYSTEM ====================
function startAutoBackup() {
    console.log(`💾 Starting optimized backups every ${config.backupInterval / 60000} minutes`);
    
    // Initial backup after 1 minute
    setTimeout(async () => {
        await backupDatabaseToDropbox().catch(console.error);
    }, 60 * 1000);

    // Regular backups
    setInterval(async () => {
        const result = await backupDatabaseToDropbox().catch(console.error);
        
        if (result && result.success) {
            const db = readDatabase();
            db.statistics.lastBackup = new Date().toISOString();
            writeDatabase(db);
        }
    }, config.backupInterval);

    // Backup on exit
    process.on('SIGINT', async () => {
        await backupDatabaseToDropbox().catch(console.error);
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await backupDatabaseToDropbox().catch(console.error);
        process.exit(0);
    });
}

// ==================== OPTIMIZED EXPRESS WEB SERVER ====================
const app = express();

// Serve static files
app.use(express.static('views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== OPTIMIZED ROUTES ====================

// Registration Form Route
app.get('/register/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        
        if (user && user.profileCompleted) {
            return res.redirect(`/profile/${userId}`);
        }
        
        res.sendFile(path.join(__dirname, 'views', 'registration.html'));
        
    } catch (error) {
        res.status(500).send('Internal server error');
    }
});

// SSE endpoint
app.get('/api/events/:userId', (req, res) => {
    const userId = req.params.userId;
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    
    connectedClients.set(userId, res);
    
    res.write(`data: ${JSON.stringify({
        type: 'connected',
        message: 'Real-time updates connected',
        timestamp: new Date().toISOString()
    })}\n\n`);
    
    req.on('close', () => {
        connectedClients.delete(userId);
    });
});

// Handle Registration Form Submission
app.post('/register/:userId', express.json(), (req, res) => {
    try {
        const userId = req.params.userId;
        const { firstName, lastName, email } = req.body;
        
        if (!firstName || !lastName || !email) {
            return res.json({ 
                success: false, 
                error: 'All fields are required' 
            });
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.json({ 
                success: false, 
                error: 'Please enter a valid email address' 
            });
        }
        
        const success = setUserProfile(userId, firstName, lastName, email);
        
        if (success) {
            if (bot) {
                const stats = getStatistics();
                bot.telegram.sendMessage(
                    ADMIN_CHAT_ID,
                    `👤 *New Web Registration*\n\n📛 ${firstName} ${lastName}\n📧 ${email}\n🆔 ${userId}\n📊 Total: ${stats.totalUsers}`,
                    { parse_mode: 'Markdown' }
                ).catch(console.error);
            }
            
            res.json({ 
                success: true, 
                message: 'Account created successfully!',
                redirectUrl: `/loading/${userId}`
            });
        } else {
            res.json({ 
                success: false, 
                error: 'Failed to create account' 
            });
        }
        
    } catch (error) {
        res.json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Profile Edit Page
app.get('/profile/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        
        if (!user || !user.profileCompleted) {
            return res.redirect(`/register/${userId}`);
        }

        // Send profile page HTML (same as before, but optimized)
        res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>BIG DADDY V3 - Edit Profile</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                /* Optimized CSS - same as before but minified */
                body{font-family:'Poppins',sans-serif;background:#1E1E2D;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.profile-container{width:100%;max-width:500px}.profile-card{background:rgba(30,30,45,0.7);backdrop-filter:blur(10px);border-radius:12px;padding:40px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 10px 30px rgba(0,0,0,0.3)}.logo-container{text-align:center;margin-bottom:30px}.logo-container h1{font-size:1.8rem;font-weight:700;color:#E53935;text-transform:uppercase;letter-spacing:1px}.form-group{margin-bottom:20px}.form-control{width:100%;padding:12px 16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#fff}.btn{width:100%;padding:14px;border:none;border-radius:6px;font-weight:600;cursor:pointer}.btn-primary{background:linear-gradient(135deg,#E53935,#C62828);color:white}
            </style>
        </head>
        <body>
            <div class="profile-container">
                <div class="profile-card">
                    <div class="logo-container">
                        <h1>👤 EDIT PROFILE</h1>
                        <div>Update your personal information</div>
                    </div>
                    <form id="profileForm">
                        <div class="form-group">
                            <label>First Name</label>
                            <input type="text" id="firstName" class="form-control" value="${user.firstName}" required>
                        </div>
                        <div class="form-group">
                            <label>Last Name</label>
                            <input type="text" id="lastName" class="form-control" value="${user.lastName}" required>
                        </div>
                        <div class="form-group">
                            <label>Email</label>
                            <input type="email" id="email" class="form-control" value="${user.email}" required>
                        </div>
                        <button type="submit" class="btn btn-primary">Update Profile</button>
                    </form>
                </div>
            </div>
            <script>
                document.getElementById('profileForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const formData = {
                        firstName: document.getElementById('firstName').value.trim(),
                        lastName: document.getElementById('lastName').value.trim(),
                        email: document.getElementById('email').value.trim()
                    };
                    try {
                        const response = await fetch('/api/update-profile/${userId}', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify(formData)
                        });
                        const data = await response.json();
                        alert(data.success ? 'Profile updated!' : data.error);
                    } catch (error) {
                        alert('Network error');
                    }
                });
            </script>
        </body>
        </html>
        `);
        
    } catch (error) {
        res.status(500).send('Internal server error');
    }
});

// API endpoint to update profile
app.post('/api/update-profile/:userId', express.json(), (req, res) => {
    try {
        const userId = req.params.userId;
        const { firstName, lastName, email } = req.body;
        
        if (!firstName || !lastName || !email) {
            return res.json({ success: false, error: 'All fields are required' });
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.json({ success: false, error: 'Invalid email' });
        }
        
        const success = setUserProfile(userId, firstName, lastName, email);
        
        if (success) {
            res.json({ success: true, message: 'Profile updated successfully' });
        } else {
            res.json({ success: false, error: 'Failed to update profile' });
        }
        
    } catch (error) {
        res.json({ success: false, error: 'Internal server error' });
    }
});

// Web App Dashboard Route
app.get('/webapp/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        
        if (userId === ADMIN_CHAT_ID) {
            return res.sendFile(path.join(__dirname, 'views', 'admin.html'));
        }
        
        if (user && user.profileCompleted) {
            const membershipCheck = await checkUserMembership(userId);
            if (!membershipCheck.hasAccess) {
                return res.send(generateAccessDeniedPage(userId, membershipCheck.notJoinedGroups));
            }
        }
        
        if (!user || !user.profileCompleted) {
            return res.send(generateSetupRequiredPage());
        }

        return res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
        
    } catch (error) {
        res.status(500).send('Internal server error');
    }
});

// API endpoint for user data
app.get('/api/user/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        const db = readDatabase();
        
        if (!user) {
            return res.json({ success: false, error: 'User not found' });
        }
        
        res.json({
            success: true,
            user: user,
            domain: SHORT_DOMAIN,
            welcomeMessage: db.settings?.webWelcomeMessage || "🎉 Welcome to your dashboard!"
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// API endpoint for admin users list
app.get('/admin/users', (req, res) => {
    try {
        const db = readDatabase();
        const users = Object.values(db.users || {});
        
        const sortedUsers = users.sort((a, b) => 
            new Date(b.createdAt) - new Date(a.createdAt)
        );
        
        res.json({ success: true, users: sortedUsers });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get WhatsApp sessions for a user
app.get('/api/whatsapp-sessions/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const sessions = getUserWhatsAppSessions(userId);
        
        res.json({ success: true, sessions: sessions });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all WhatsApp sessions (admin only)
app.get('/api/all-whatsapp-sessions', (req, res) => {
    try {
        const sessions = getAllWhatsAppSessions();
        const sessionArray = Object.values(sessions);
        
        res.json({ success: true, sessions: sessionArray });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Manual trigger to update WhatsApp sessions
app.post('/api/update-sessions', async (req, res) => {
    try {
        const result = await updateWhatsAppSessions();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get balanced endpoint for prefix
app.post('/api/get-endpoint', (req, res) => {
    try {
        const { prefix } = req.body;
        
        if (!prefix || !ENDPOINTS[prefix]) {
            return res.json({ success: false, error: 'Invalid prefix' });
        }
        
        const endpoint = getBalancedEndpoint(prefix);
        
        if (!endpoint) {
            return res.json({ success: false, error: 'No endpoints available' });
        }
        
        res.json({ success: true, endpoint: endpoint, prefix: prefix });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Pair WhatsApp number
app.post('/api/pair-number', async (req, res) => {
    let endpoint = null;
    
    try {
        const { phoneNumber, prefix } = req.body;
        const userId = req.headers['user-id'] || req.body.userId || 'unknown';
        
        if (!phoneNumber || !prefix) {
            return res.json({ success: false, error: 'Missing parameters' });
        }
        
        const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
        if (!phoneRegex.test(phoneNumber)) {
            return res.json({ success: false, error: 'Invalid phone number' });
        }
        
        endpoint = getBalancedEndpoint(prefix);
        
        if (!endpoint) {
            return res.json({ success: false, error: `No endpoints for prefix: ${prefix}` });
        }

        // Update user data
        const db = readDatabase();
        if (db.users[userId]) {
            db.users[userId].activeBots = db.users[userId].activeBots || [];
            db.users[userId].activeBots = db.users[userId].activeBots.filter(bot => 
                bot.number !== phoneNumber
            );
            db.users[userId].activeBots.push({
                number: phoneNumber,
                prefix: prefix,
                endpoint: endpoint,
                status: 'pairing',
                startTime: new Date().toISOString()
            });
            writeDatabase(db);
        }
        
        res.json({ success: true, endpoint: endpoint, message: 'Endpoint assigned' });
        
    } catch (error) {
        if (endpoint) releaseEndpoint(endpoint);
        res.status(500).json({ success: false, error: `Pairing failed: ${error.message}` });
    }
});

// Update bot status
app.post('/api/update-bot-status', async (req, res) => {
    try {
        const { phoneNumber, status, userId } = req.body;
        
        if (!phoneNumber || !status || !userId) {
            return res.json({ success: false, error: 'Missing parameters' });
        }
        
        const db = readDatabase();
        if (db.users[userId] && db.users[userId].activeBots) {
            const bot = db.users[userId].activeBots.find(bot => bot.number === phoneNumber);
            if (bot) {
                bot.status = status;
                bot.lastChecked = new Date().toISOString();
                writeDatabase(db);
                res.json({ success: true, message: 'Bot status updated' });
            } else {
                res.json({ success: false, error: 'Bot not found' });
            }
        } else {
            res.json({ success: false, error: 'User not found' });
        }
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Stop bot
app.post('/api/stop-bot', async (req, res) => {
    try {
        const { phoneNumber, userId } = req.body;
        
        if (!phoneNumber || !userId) {
            return res.json({ success: false, error: 'Missing parameters' });
        }
        
        const db = readDatabase();
        let userEndpoint = null;
        
        if (db.users[userId] && db.users[userId].activeBots) {
            const activeBot = db.users[userId].activeBots.find(bot => bot.number === phoneNumber);
            if (activeBot) {
                userEndpoint = activeBot.endpoint;
                db.users[userId].activeBots = db.users[userId].activeBots.filter(
                    bot => bot.number !== phoneNumber
                );
                writeDatabase(db);
                releaseEndpoint(userEndpoint);
                res.json({ success: true, message: 'Bot stopped' });
            } else {
                res.json({ success: false, error: 'No active bot found' });
            }
        } else {
            res.json({ success: false, error: 'User not found' });
        }
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Loading Page
app.get('/loading/:userId', (req, res) => {
    const userId = req.params.userId;
    
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V3 - Loading</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body{font-family:'Poppins',sans-serif;background:#1E1E2D;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden}.loading-container{width:100%;max-width:500px;padding:40px;text-align:center}.loading-card{background:rgba(30,30,45,0.7);backdrop-filter:blur(10px);border-radius:12px;padding:50px 40px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 10px 30px rgba(0,0,0,0.3)}.logo-container{margin-bottom:30px}.logo-container h1{font-size:2.2rem;font-weight:700;color:#E53935;text-transform:uppercase;letter-spacing:2px}.loader-wrapper{margin:40px 0}.main-loader{width:80px;height:80px;margin:0 auto 25px;position:relative}.loader-ring{position:absolute;width:100%;height:100%;border:3px solid transparent;border-top:3px solid #E53935;border-radius:50%;animation:spin 1.5s linear infinite}@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
        </style>
    </head>
    <body>
        <div class="loading-container">
            <div class="loading-card">
                <div class="logo-container">
                    <h1>🚀 BIG DADDY V3</h1>
                    <span>PREMIUM EDITION</span>
                </div>
                <div class="loader-wrapper">
                    <div class="main-loader">
                        <div class="loader-ring"></div>
                    </div>
                    <div>Initializing Dashboard</div>
                    <div>Preparing your premium experience...</div>
                </div>
            </div>
        </div>
        <script>
            setTimeout(() => {
                window.location.href = '/webapp/${userId}';
            }, 2000);
        </script>
    </body>
    </html>
    `);
});

// Health check endpoint
app.get('/health', (req, res) => {
    const db = readDatabase();
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        statistics: db.statistics,
        domain: SHORT_DOMAIN
    });
});

// Admin API endpoints
app.delete('/admin/delete-user/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const success = deleteUser(userId);
        
        if (success) {
            res.json({ success: true, message: 'User deleted successfully' });
        } else {
            res.status(404).json({ success: false, error: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/admin/remove-group/:groupId', (req, res) => {
    try {
        const groupId = req.params.groupId;
        const success = removeGroup(groupId);
        
        if (success) {
            res.json({ success: true, message: 'Group removed successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Group not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/admin/approve-group/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const success = await approveGroup(groupId);
        
        if (success) {
            res.json({ success: true, message: 'Group approved successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Group not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/admin/reject-group/:groupId', (req, res) => {
    try {
        const groupId = req.params.groupId;
        const success = rejectGroup(groupId);
        
        if (success) {
            res.json({ success: true, message: 'Group rejected successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Group not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/admin/statistics', (req, res) => {
    try {
        const stats = getStatistics();
        res.json({ success: true, statistics: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/admin/groups', (req, res) => {
    try {
        const groups = getGroups();
        const pendingGroups = getPendingGroups();
        res.json({ success: true, groups: groups, pendingGroups: pendingGroups });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/backup-status', async (req, res) => {
    try {
        const db = readDatabase();
        res.json({
            success: true,
            lastBackup: db.statistics.lastBackup,
            totalUsers: db.statistics.totalUsers,
            startupCount: db.statistics.startupCount,
            domain: SHORT_DOMAIN
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/trigger-backup', async (req, res) => {
    try {
        const result = await backupDatabaseToDropbox();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    try {
        const stats = getStatistics();
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>BIG DADDY V3 Dashboard</title>
                <style>
                    body{font-family:Arial,sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;min-height:100vh}.container{background:rgba(255,255,255,0.1);backdrop-filter:blur(10px);padding:40px;border-radius:15px;display:inline-block;max-width:600px}.stats{margin:20px 0;padding:15px;background:rgba(255,255,255,0.1);border-radius:10px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px}
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🚀 BIG DADDY V3</h1>
                    <p>Telegram Bot Dashboard System</p>
                    <div class="stats">
                        <div><strong>Server:</strong> ${SHORT_DOMAIN}</div>
                        <div><strong>Total Users:</strong> ${stats.totalUsers}</div>
                        <div><strong>Today's Users:</strong> ${stats.usersToday}</div>
                        <div><strong>Status:</strong> ✅ Online</div>
                    </div>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        res.status(500).send('Internal server error');
    }
});

// Helper functions for HTML pages
function generateAccessDeniedPage(userId, notJoinedGroups) {
    const groupsList = notJoinedGroups.map(group => 
        `<li>${group.title} (${group.type})</li>`
    ).join('');
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Access Required - BIG DADDY V3</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body{font-family:Arial,sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;min-height:100vh}.container{background:rgba(255,255,255,0.1);backdrop-filter:blur(10px);padding:40px;border-radius:15px;display:inline-block;max-width:600px}
        </style>
    </head>
    <body>
        <div class="container">
            <div>🔒</div>
            <h1>Access Required</h1>
            <p>To use this bot, you need to join all our sponsor channels first.</p>
            <h3>Required Channels:</h3>
            <ul style="text-align:left;display:inline-block;">${groupsList}</ul>
            <p>After joining all channels, return to Telegram and use /start again.</p>
            <button onclick="window.location.href='/webapp/${userId}'" style="background:#4CAF50;color:white;border:none;padding:10px 20px;border-radius:5px;cursor:pointer;margin-top:20px;">Check Access Again</button>
        </div>
    </body>
    </html>
    `;
}

function generateSetupRequiredPage() {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Setup Required - BIG DADDY V3</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body{font-family:Arial,sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;min-height:100vh}.container{background:rgba(255,255,255,0.1);backdrop-filter:blur(10px);padding:40px;border-radius:15px;display:inline-block;max-width:600px}
        </style>
    </head>
    <body>
        <div class="container">
            <div>ℹ️</div>
            <h1>Setup Required</h1>
            <p>Please complete your account setup in Telegram first.</p>
            <button onclick="window.close()" style="background:#4CAF50;color:white;border:none;padding:10px 20px;border-radius:5px;cursor:pointer;margin-top:20px;">Close</button>
        </div>
    </body>
    </html>
    `;
}

// ==================== OPTIMIZED TELEGRAM BOT SETUP ====================
function ensureSession(ctx, next) {
    if (!ctx.session) {
        ctx.session = {};
    }
    return next();
}

async function handleAutoGroupDetection(ctx) {
    try {
        const chat = ctx.chat;
        
        if (chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel')) {
            if (ctx.message && ctx.message.new_chat_members) {
                const newMembers = ctx.message.new_chat_members;
                const botInfo = await bot.telegram.getMe();
                
                const botWasAdded = newMembers.some(member => member.id === botInfo.id);
                
                if (botWasAdded) {
                    let inviteLink = null;
                    try {
                        if (chat.type !== 'channel') {
                            inviteLink = await generateGroupInviteLink(chat.id);
                        } else {
                            inviteLink = chat.username ? `https://t.me/${chat.username}` : null;
                        }
                    } catch (error) {
                        console.error('Error generating invite link:', error);
                    }
                    
                    const groupData = {
                        id: chat.id.toString(),
                        title: chat.title || 'Unknown',
                        username: chat.username,
                        inviteLink: inviteLink,
                        type: chat.type === 'channel' ? 'channel' : 'group'
                    };
                    
                    const success = addPendingGroup(groupData);
                    
                    if (success && bot) {
                        await bot.telegram.sendMessage(
                            ADMIN_CHAT_ID,
                            `🆕 *New ${chat.type === 'channel' ? 'Channel' : 'Group'} Detected*\n\n📝 ${chat.title}\n🆔 ${chat.id}\n📋 ${chat.type}`,
                            {
                                parse_mode: 'Markdown',
                                ...Markup.inlineKeyboard([
                                    [Markup.button.callback('✅ Approve Sponsor', `approve_${chat.id}`)],
                                    [Markup.button.callback('❌ Reject', `reject_${chat.id}`)]
                                ])
                            }
                        );
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error in auto group detection:', error);
    }
}

async function initializeTelegramBot() {
    try {
        bot = new Telegraf(config.telegramBotToken);
        
        bot.use(session());
        bot.use(ensureSession);

        // Start command
        bot.start(async (ctx) => {
            try {
                const userId = ctx.from.id.toString();
                
                if (!ctx.session) {
                    ctx.session = {};
                }
                
                if (isAdmin(userId)) {
                    await handleAdminStart(ctx);
                } else {
                    await handleUserStart(ctx);
                }
            } catch (error) {
                console.error('❌ Start command error:', error);
                await ctx.reply('❌ Sorry, an error occurred. Please try again.');
            }
        });

        // Admin commands
        bot.command('admin', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await showAdminPanel(ctx);
            } else {
                await ctx.reply('❌ Access denied admin only');
            }
        });

        bot.command('stats', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await showStatistics(ctx);
            } else {
                await ctx.reply('❌ Access denied admin only');
            }
        });

        bot.command('users', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await listUsers(ctx);
            } else {
                await ctx.reply('❌ Access denied admin only');
            }
        });

        // Add channel command
        bot.command('addchannel', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied sponsors only');
                return;
            }
            
            const args = ctx.message.text.split(' ').slice(1);
            if (args.length < 2) {
                await ctx.reply('Usage: `/addchannel CHANNEL_ID Channel Name`', { parse_mode: 'Markdown' });
                return;
            }
            
            const channelId = args[0];
            const channelName = args.slice(1).join(' ');
            
            if (!channelId.startsWith('-100')) {
                await ctx.reply('❌ Invalid Channel ID! Must start with -100', { parse_mode: 'Markdown' });
                return;
            }
            
            try {
                const chat = await bot.telegram.getChat(channelId);
                const botInfo = await bot.telegram.getMe();
                const botMember = await bot.telegram.getChatMember(channelId, botInfo.id);
                
                if (!['creator', 'administrator'].includes(botMember.status)) {
                    await ctx.reply('❌ Bot is not Admin in this channel!', { parse_mode: 'Markdown' });
                    return;
                }
                
                const channelData = {
                    id: channelId,
                    title: channelName,
                    username: chat.username || null,
                    inviteLink: chat.username ? `https://t.me/${chat.username}` : null,
                    type: 'channel',
                    isManual: true,
                    realTitle: chat.title
                };
                
                const success = await addGroupWithInvite(channelData);
                
                if (success) {
                    await ctx.reply(`✅ Channel Added Successfully!\n\n📝 ${channelName}`, { parse_mode: 'Markdown' });
                } else {
                    await ctx.reply('❌ Channel already exists');
                }
                
            } catch (error) {
                await ctx.reply(`❌ Cannot access channel: ${error.message}`, { parse_mode: 'Markdown' });
            }
        });

        // Create account action
        bot.action('create_account', async (ctx) => {
            try {
                await ctx.answerCbQuery();
                const userId = ctx.from.id.toString();
                
                await ctx.reply(
                    '📝 *Account Registration*\n\nClick below to open registration:',
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.webApp('🚀 Open Registration', `${config.webBaseUrl}/register/${userId}`)]
                        ])
                    }
                );
                
            } catch (error) {
                await ctx.answerCbQuery('❌ Error opening registration');
            }
        });

        // Check membership action
        bot.action('check_membership', async (ctx) => {
            try {
                await ctx.answerCbQuery('🔄 Checking membership...');
                const userId = ctx.from.id.toString();
                
                const membershipCheck = await checkUserMembership(userId);
                
                if (membershipCheck.hasAccess) {
                    await ctx.editMessageText(
                        '✅ *Access Granted!*\n\nYou can now create your account:',
                        {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback('📝 Create Account', 'create_account')]
                            ])
                        }
                    );
                } else {
                    await showJoinRequiredMessage(ctx, membershipCheck.notJoinedGroups);
                }
            } catch (error) {
                await ctx.answerCbQuery('❌ Error checking membership');
            }
        });

        // Admin approval callbacks
        bot.action(/approve_(.+)/, async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.answerCbQuery('❌ Access denied.');
                return;
            }
            
            const groupId = ctx.match[1];
            const success = await approveGroup(groupId);
            
            if (success) {
                await ctx.editMessageText('✅ Sponsor Approved!');
            } else {
                await ctx.editMessageText('❌ Sponsor not found');
            }
            await ctx.answerCbQuery();
        });

        bot.action(/reject_(.+)/, async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.answerCbQuery('❌ Access denied.');
                return;
            }
            
            const groupId = ctx.match[1];
            const success = rejectGroup(groupId);
            
            if (success) {
                await ctx.editMessageText('❌ Sponsor rejected');
            } else {
                await ctx.editMessageText('❌ Sponsor not found');
            }
            await ctx.answerCbQuery();
        });

        // Handle group events
        bot.on('message', async (ctx) => {
            if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup' || ctx.chat.type === 'channel')) {
                await handleAutoGroupDetection(ctx);
            }
        });

        bot.on('callback_query', async (ctx) => {
            try {
                await ctx.answerCbQuery();
            } catch (error) {
                console.error('Callback query error:', error);
            }
        });

        await bot.telegram.getMe();
        console.log('✅ Telegram bot connected successfully');
        return bot;
        
    } catch (error) {
        console.error('❌ Failed to initialize Telegram bot:', error.message);
        return null;
    }
}

async function handleAdminStart(ctx) {
    const userId = ctx.from.id.toString();
    const db = readDatabase();
    const adminWelcome = db.settings?.adminWelcomeMessage || "👑 *Welcome to Admin Panel*";
    
    await ctx.reply(
        adminWelcome,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('👑 Admin Dashboard', `${config.webBaseUrl}/webapp/${userId}`)],
                [Markup.button.callback('📊 Statistics', 'admin_stats')],
                [Markup.button.callback('👥 User List', 'admin_users')]
            ])
        }
    );
}

async function handleUserStart(ctx) {
    try {
        const userId = ctx.from.id.toString();
        const user = getUser(userId);
        
        if (ctx.session) {
            ctx.session.setupStep = null;
        }
        
        const membershipCheck = await checkUserMembership(userId);
        
        if (!membershipCheck.hasAccess) {
            await showJoinRequiredMessage(ctx, membershipCheck.notJoinedGroups);
            return;
        }
        
        if (user && user.profileCompleted) {
            await ctx.reply(
                `🎉 *Welcome back ${user.firstName}!*`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.webApp('🚀 Open Dashboard', `${config.webBaseUrl}/loading/${userId}`)]
                    ])
                }
            );
        } else {
            await ctx.reply(
                "👋 *Welcome to BIG DADDY V3 Bot!*",
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('📝 Create Account', 'create_account')]
                    ])
                }
            );
        }
    } catch (error) {
        console.error('❌ Handle user start error:', error);
        await ctx.reply('❌ Sorry, an error occurred. Please try again.');
    }
}

async function showJoinRequiredMessage(ctx, notJoinedGroups) {
    const keyboard = [];
    
    notJoinedGroups.forEach(group => {
        let link = group.inviteLink;
        
        if (!link && group.username) {
            link = `https://t.me/${group.username}`;
        }
        
        if (link) {
            keyboard.push([Markup.button.url(`🔗 Join ${group.title}`, link)]);
        }
    });
    
    keyboard.push([Markup.button.callback('✅ Verify Membership', 'check_membership')]);
    
    let message = `🔒 *Access Required*\n\nJoin these sponsors:\n\n`;
    
    notJoinedGroups.forEach((group, index) => {
        let linkInfo = '';
        if (group.username) {
            linkInfo = ` (@${group.username})`;
        }
        message += `${index + 1}. *${group.title}* (${group.type})${linkInfo}\n`;
    });
    
    await ctx.reply(
        message,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(keyboard)
        }
    );
}

async function showAdminPanel(ctx) {
    const stats = getStatistics();
    
    await ctx.reply(
        `👑 *Admin Panel*\n\n📊 *Statistics:*\n• Total Users: ${stats.totalUsers}\n• Today: ${stats.usersToday}`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('📱 Web Dashboard', `${config.webBaseUrl}/webapp/${ctx.from.id}`)],
                [Markup.button.callback('📊 Refresh Stats', 'admin_stats')]
            ])
        }
    );
}

async function showStatistics(ctx) {
    const stats = getStatistics();
    const db = readDatabase();
    const groups = getGroups();
    
    await ctx.reply(
        `📊 *System Statistics*\n\n👥 *Users:* ${stats.totalUsers}\n📈 *Today:* ${stats.usersToday}\n📋 *Sponsors:* ${groups.length}`,
        { parse_mode: 'Markdown' }
    );
}

async function listUsers(ctx) {
    const db = readDatabase();
    const users = Object.values(db.users);
    
    if (users.length === 0) {
        await ctx.reply('📭 No users found');
        return;
    }
    
    const userList = users
        .slice(0, 5)
        .map((user, index) => 
            `${index + 1}. ${user.firstName || 'Unknown'} ${user.lastName || ''} (${user.id})`
        )
        .join('\n');
    
    await ctx.reply(
        `👥 *User List* (${users.length} total)\n\n${userList}`,
        { parse_mode: 'Markdown' }
    );
}

// ==================== OPTIMIZED AUTO-PING SYSTEM ====================
function startAutoPing() {
    if (!IS_RENDER) {
        console.log('🚫 Auto-ping disabled (not on Render)');
        return;
    }

    const pingInterval = 14 * 60 * 1000;
    
    async function pingServer() {
        try {
            await axios.get(`${config.webBaseUrl}/health`, { timeout: 10000 });
        } catch (error) {
            console.warn(`⚠️ Auto-ping failed: ${error.message}`);
        }
    }

    setTimeout(() => {
        pingServer();
        setInterval(pingServer, pingInterval);
    }, 60000);

    console.log(`🔄 Auto-ping started for Render`);
}

// ==================== OPTIMIZED START SERVERS ====================
async function startServers() {
    try {
        console.log('🚀 Starting BIG DADDY V3 - Optimized for 2000+ Users');
        console.log(`🌐 Domain: ${SHORT_DOMAIN}`);
        console.log(`🔗 URL: ${config.webBaseUrl}`);
        
        // Step 1: Restore from Dropbox on startup
        console.log('🔄 Checking for Dropbox backup...');
        const restoreSuccess = await restoreDatabaseFromDropbox();
        
        if (restoreSuccess) {
            console.log('✅ Database restored from Dropbox');
        } else {
            console.log('ℹ️ Using local database');
            initDatabase();
        }
        
        // Step 2: Initialize systems
        initDatabase();
        initEndpointTracking();
        
        // Step 3: Start optimized systems
        startAutoPing();
        startAutoBackup();
        startMemoryCleanup();
        startMembershipMonitoring();
        
        // Start session monitoring with delay
        setTimeout(() => {
            startSessionMonitoring();
            startHealthCheckMonitoring();
        }, 30000);

        const server = app.listen(config.webPort, '0.0.0.0', () => {
            console.log(`✅ Web server running on port ${config.webPort}`);
            const db = readDatabase();
            console.log(`📊 Current users: ${Object.keys(db.users).length}`);
        });

        const telegramBot = await initializeTelegramBot();
        
        if (telegramBot) {
            await telegramBot.launch();
            console.log('✅ Telegram bot started successfully');
        }
        
        process.once('SIGINT', () => gracefulShutdown(telegramBot, server));
        process.once('SIGTERM', () => gracefulShutdown(telegramBot, server));
        
    } catch (error) {
        console.error('❌ Failed to start servers:', error);
        process.exit(1);
    }
}

// Start session monitoring
function startSessionMonitoring() {
    console.log('🔄 Starting WhatsApp session monitoring');
    setInterval(updateWhatsAppSessions, 2 * 60 * 1000);
}

// Start health check monitoring
function startHealthCheckMonitoring() {
    console.log('🔄 Starting endpoint health monitoring');
    setInterval(healthCheckAllEndpoints, 5 * 60 * 1000);
}

// Start membership monitoring
function startMembershipMonitoring() {
    console.log('🔄 Starting membership monitoring');
    setInterval(() => {
        // Lightweight membership check
        const db = readDatabase();
        if (Object.keys(db.users).length > 0) {
            console.log(`🔍 Membership monitoring active for ${Object.keys(db.users).length} users`);
        }
    }, 5 * 60 * 1000);
}

async function gracefulShutdown(telegramBot, server) {
    console.log('🛑 Shutting down gracefully...');
    
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
console.log(`🚀 BIG DADDY V3 - Optimized for 2000+ Users`);
startServers();

module.exports = {
    readDatabase,
    getUser,
    createOrUpdateUser,
    deleteUser,
    isAdmin,
    getStatistics,
    backupDatabaseToDropbox
};
