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
    
    console.log(`database connected bigdaddyv3`);
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
    
    maxMemoryMB: 450,
    backupInterval: 60 * 60 * 1000,
    cleanupInterval: 30 * 60 * 1000,
    reconnectDelay: 5000,
    maxReconnectAttempts: 5
};

// ==================== DROPBOX INTEGRATION ====================
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
            success: true
        });
        
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
            fs.writeFileSync(DB_PATH, dbBuffer);
            
            console.log('✅ Database restored from Dropbox successfully');
            
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

// ==================== DATABASE SETUP (FOR ADMIN ONLY - NO USER ACCOUNTS) ====================
const DB_PATH = path.join(__dirname, 'database.json');

function initDatabase() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const initialData = {
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
                    lastReset: new Date().toISOString().split('T')[0]
                },
                admin: {
                    chatId: ADMIN_CHAT_ID,
                    username: ADMIN_USERNAME,
                    lastActive: new Date().toISOString()
                },
                groups: [],
                pendingGroups: [], // Groups waiting for admin approval
                membershipChecks: {},
                endpointUsage: {}, // Track endpoint usage for load balancing
                whatsappSessions: {}, // Store WhatsApp session data
                endpointHealth: {}, // Track endpoint health status
                version: '3.1'
            };
            fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
            console.log('✅ Database initialized');
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
        return { settings: {}, statistics: {}, backups: [], groups: [], pendingGroups: [], membershipChecks: {}, endpointUsage: {}, whatsappSessions: {}, endpointHealth: {} };
    }
}

function writeDatabase(data) {
    try {
        data.statistics = data.statistics || {};
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

function isAdmin(userId) {
    return userId.toString() === ADMIN_CHAT_ID.toString();
}

function getStatistics() {
    const db = readDatabase();
    
    // Count active WhatsApp sessions
    const activeSessions = Object.values(db.whatsappSessions || {}).filter(session => 
        session.isConnected === true
    ).length;
    
    // Count healthy endpoints
    const healthyEndpoints = Object.values(db.endpointHealth || {}).filter(health => 
        health.status === 'healthy'
    ).length;
    
    return {
        totalUsers: 0, // No longer tracking users in database
        usersToday: 0, // No longer tracking users in database
        usersWithProfile: 0, // No longer tracking users in database
        usersWithoutProfile: 0, // No longer tracking users in database
        activeWhatsAppSessions: activeSessions,
        healthyEndpoints: healthyEndpoints,
        totalEndpoints: Object.keys(db.endpointHealth || {}).length,
        lastBackup: db.statistics.lastBackup,
        startupCount: db.statistics.startupCount,
        domain: SHORT_DOMAIN
    };
}

// ==================== SMART ENDPOINT LOAD BALANCING ====================

const ENDPOINTS = {
    'none': [
        'https://oksy-49a32a775bb9.herokuapp.com', 
        'https://non-9fa7f7c4a74d.herokuapp.com',
        'https://nonnn-624b161afabe.herokuapp.com',
        'https://noneprefix-06fde5e78785.herokuapp.com',
        'https://godso-342ffa8cb7fe.herokuapp.com',
        'https://gshshhshs-d76a9aa229b6.herokuapp.com'
    ],
    '.': [
        'https://prefix-3b5785b66c22.herokuapp.com',
        'https://pref-39f472260e1c.herokuapp.com',
        'https://preeedot-6967a0e18b91.herokuapp.com',
        'https://predoxx-22bdf42b0248.herokuapp.com',
        'https://dox-e44872c65792.herokuapp.com'
    ],
    '!': [
        'https://prefixcommand-6d3179536193.herokuapp.com',
        'https://preficommand-9486c706544b.herokuapp.com',
        'https://preficomm-255b9e9d55f4.herokuapp.com',
        'https://loveofgod-ef074e61496c.herokuapp.com',
        'https://okhhs-45eac3bff62d.herokuapp.com'
    ],
    '/': [
        'https://phistarg-a48c1739165f.herokuapp.com',
        'https://prefixgg-26fb1dbefc0a.herokuapp.com',
        'https://prefixggg-7df02a416ec2.herokuapp.com',
        'https://lovepfjesure-ad3e6a69e495.herokuapp.com'
    ],
    "'": [
        'https://philiphh-bf43061b2139.herokuapp.com',
        'https://projecthhh-337aded06efd.herokuapp.com'
    ]
};

// Initialize endpoint tracking in database
function initEndpointTracking() {
    const db = readDatabase();
    
    // Create endpointUsage if it doesn't exist
    if (!db.endpointUsage) {
        db.endpointUsage = {};
    }
    
    // Create endpointHealth if it doesn't exist
    if (!db.endpointHealth) {
        db.endpointHealth = {};
    }
    
    // Initialize ALL endpoints with userCount: 0 and health status
    Object.keys(ENDPOINTS).forEach(prefix => {
        ENDPOINTS[prefix].forEach(endpoint => {
            // Initialize endpoint usage
            if (!db.endpointUsage[endpoint]) {
                db.endpointUsage[endpoint] = {
                    userCount: 0,
                    lastUsed: null,
                    prefix: prefix,
                    totalAssigned: 0
                };
            }
            
            // Initialize endpoint health
            if (!db.endpointHealth[endpoint]) {
                db.endpointHealth[endpoint] = {
                    status: 'unknown',
                    lastChecked: null,
                    responseTime: null,
                    errorCount: 0,
                    successCount: 0,
                    lastError: null,
                    sessionsCount: 0
                };
            }
        });
    });
    
    writeDatabase(db);
    console.log(`🔀 Endpoint tracking initialized with ${Object.keys(db.endpointUsage).length} endpoints`);
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
                sessionsCount: response.data.sessions ? response.data.sessions.length : 0,
                lastChecked: new Date().toISOString()
            };
        } else {
            return {
                status: 'unhealthy',
                responseTime: responseTime,
                error: 'Invalid response data',
                lastChecked: new Date().toISOString()
            };
        }
    } catch (error) {
        return {
            status: 'down',
            responseTime: null,
            error: error.message,
            lastChecked: new Date().toISOString()
        };
    }
}

// Health check all endpoints
async function healthCheckAllEndpoints() {
    console.log('🔍 Performing health check on all endpoints...');
    
    const db = readDatabase();
    const allEndpoints = Object.keys(db.endpointHealth || {});
    let healthyCount = 0;
    let unhealthyCount = 0;
    let downCount = 0;
    
    const healthResults = {};
    
    for (const endpoint of allEndpoints) {
        try {
            const health = await checkEndpointHealth(endpoint);
            healthResults[endpoint] = health;
            
            // Update database
            db.endpointHealth[endpoint] = {
                ...db.endpointHealth[endpoint],
                ...health,
                lastChecked: new Date().toISOString()
            };
            
            if (health.status === 'healthy') {
                healthyCount++;
                db.endpointHealth[endpoint].successCount = (db.endpointHealth[endpoint].successCount || 0) + 1;
                db.endpointHealth[endpoint].errorCount = 0; // Reset error count on success
            } else {
                if (health.status === 'down') {
                    downCount++;
                } else {
                    unhealthyCount++;
                }
                db.endpointHealth[endpoint].errorCount = (db.endpointHealth[endpoint].errorCount || 0) + 1;
                db.endpointHealth[endpoint].lastError = health.error;
                
                // Notify admin if endpoint is down
                if (health.status === 'down' && bot) {
                    const errorCount = db.endpointHealth[endpoint].errorCount;
                    if (errorCount === 1 || errorCount % 5 === 0) { // Notify on first failure and every 5th consecutive failure
                        await bot.telegram.sendMessage(
                            ADMIN_CHAT_ID,
                            `🚨 *Endpoint Down Alert*\n\n` +
                            `🔗 *Endpoint:* ${endpoint}\n` +
                            `📊 *Status:* ${health.status}\n` +
                            `❌ *Error:* ${health.error}\n` +
                            `🔢 *Consecutive Failures:* ${errorCount}\n\n` +
                            `Please check the endpoint configuration.`,
                            { parse_mode: 'Markdown' }
                        );
                    }
                }
            }
            
            // Update sessions count
            if (health.sessionsCount !== undefined) {
                db.endpointHealth[endpoint].sessionsCount = health.sessionsCount;
            }
            
            // Rate limiting between health checks
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`❌ Error checking health for ${endpoint}:`, error.message);
            healthResults[endpoint] = {
                status: 'error',
                error: error.message,
                lastChecked: new Date().toISOString()
            };
        }
    }
    
    writeDatabase(db);
    
    console.log(`✅ Health check completed: ${healthyCount} healthy, ${unhealthyCount} unhealthy, ${downCount} down`);
    
    return {
        healthy: healthyCount,
        unhealthy: unhealthyCount,
        down: downCount,
        total: allEndpoints.length,
        results: healthResults
    };
}

// Get the best endpoint for a prefix (considering both load and health)
function getBalancedEndpoint(prefix) {
    const db = readDatabase();
    
    // Make sure endpointUsage and endpointHealth exist
    if (!db.endpointUsage || !db.endpointHealth) {
        initEndpointTracking();
    }
    
    const endpoints = ENDPOINTS[prefix] || [];
    
    if (endpoints.length === 0) {
        console.log(`❌ No endpoints configured for prefix: ${prefix}`);
        return null;
    }
    
    console.log(`🔍 Looking for healthy endpoints for prefix: ${prefix}`);
    
    // Filter only healthy endpoints
    const healthyEndpoints = endpoints.filter(endpoint => {
        const health = db.endpointHealth[endpoint];
        return health && health.status === 'healthy';
    });
    
    if (healthyEndpoints.length === 0) {
        console.log(`❌ No healthy endpoints available for prefix: ${prefix}`);
        // Fallback to any endpoint if no healthy ones
        console.log(`🔄 Falling back to any endpoint for prefix: ${prefix}`);
        return getFallbackEndpoint(endpoints, db);
    }
    
    console.log(`✅ Found ${healthyEndpoints.length} healthy endpoints for prefix ${prefix}`);
    
    // Find endpoint with least users among healthy ones
    let minUsers = Infinity;
    let selectedEndpoint = null;
    
    healthyEndpoints.forEach(endpoint => {
        const usage = db.endpointUsage[endpoint];
        const health = db.endpointHealth[endpoint];
        
        console.log(`🔍 Endpoint ${endpoint}: ${usage.userCount} users, ${health.responseTime}ms response`);
        
        if (usage.userCount < minUsers) {
            minUsers = usage.userCount;
            selectedEndpoint = endpoint;
        } else if (usage.userCount === minUsers) {
            // If same user count, choose the one with better response time
            const currentHealth = db.endpointHealth[selectedEndpoint];
            if (health.responseTime < (currentHealth?.responseTime || Infinity)) {
                selectedEndpoint = endpoint;
            }
        }
    });
    
    if (selectedEndpoint) {
        // Update usage count
        db.endpointUsage[selectedEndpoint].userCount++;
        db.endpointUsage[selectedEndpoint].lastUsed = new Date().toISOString();
        db.endpointUsage[selectedEndpoint].totalAssigned++;
        writeDatabase(db);
        
        console.log(`🔀 Load balancing: Selected ${selectedEndpoint} for prefix ${prefix} (now has ${db.endpointUsage[selectedEndpoint].userCount} users)`);
    } else {
        console.log(`❌ No endpoint selected for prefix: ${prefix}`);
    }
    
    return selectedEndpoint;
}

// Fallback endpoint selection when no healthy endpoints
function getFallbackEndpoint(endpoints, db) {
    let minUsers = Infinity;
    let selectedEndpoint = null;
    
    endpoints.forEach(endpoint => {
        const usage = db.endpointUsage[endpoint];
        console.log(`🔍 Fallback endpoint ${endpoint}: ${usage.userCount} users`);
        
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
        
        console.log(`🔄 Fallback: Selected ${selectedEndpoint} (now has ${db.endpointUsage[selectedEndpoint].userCount} users)`);
    }
    
    return selectedEndpoint;
}

// Release endpoint when user stops bot
function releaseEndpoint(endpoint) {
    const db = readDatabase();
    
    if (db.endpointUsage && db.endpointUsage[endpoint]) {
        if (db.endpointUsage[endpoint].userCount > 0) {
            db.endpointUsage[endpoint].userCount--;
        }
        writeDatabase(db);
        
        console.log(`🔀 Load balancing: Released ${endpoint} (now has ${db.endpointUsage[endpoint].userCount} users)`);
    } else {
        console.log(`⚠️ Cannot release endpoint ${endpoint}: not found in endpointUsage`);
    }
}

// ==================== WHATSAPP SESSIONS MANAGEMENT ====================

// Function to update WhatsApp sessions from endpoints
async function updateWhatsAppSessions() {
    try {
        console.log('🔄 Updating WhatsApp sessions from all endpoints...');
        
        const db = readDatabase();
        const allEndpoints = new Set();
        
        // Collect all unique endpoints from endpointUsage
        Object.keys(db.endpointUsage || {}).forEach(endpoint => {
            allEndpoints.add(endpoint);
        });
        
        let totalSessions = 0;
        let updatedSessions = 0;
        
        // Check each endpoint for sessions
        for (const endpoint of allEndpoints) {
            try {
                const sessionsUrl = `${endpoint}/sessions`;
                console.log(`🔍 Checking sessions at: ${sessionsUrl}`);
                
                const response = await fetch(sessionsUrl, { timeout: 10000 });
                
                if (!response.ok) {
                    console.log(`❌ Endpoint ${endpoint} returned ${response.status}`);
                    continue;
                }
                
                const data = await response.json();
                
                if (data.success && data.sessions) {
                    console.log(`✅ Found ${data.sessions.length} sessions at ${endpoint}`);
                    
                    // Update sessions in database
                    data.sessions.forEach(session => {
                        const sessionKey = `${endpoint}_${session.phoneNumber}`;
                        
                        if (!db.whatsappSessions) db.whatsappSessions = {};
                        
                        db.whatsappSessions[sessionKey] = {
                            phoneNumber: session.phoneNumber,
                            endpoint: endpoint,
                            mode: session.mode || 'unknown',
                            health: session.health || 'unknown',
                            messagesProcessed: session.messagesProcessed || 0,
                            errors: session.errors || 0,
                            queueSize: session.queueSize || 0,
                            welcomeSent: session.welcomeSent || false,
                            lastActivity: session.lastActivity || 'unknown',
                            isConnected: session.isConnected || false,
                            lastUpdated: new Date().toISOString()
                        };
                        
                        updatedSessions++;
                    });
                    
                    totalSessions += data.sessions.length;
                }
                
                // Rate limiting between endpoint calls
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`❌ Error checking endpoint ${endpoint}:`, error.message);
            }
        }
        
        writeDatabase(db);
        console.log(`✅ WhatsApp sessions updated: ${updatedSessions} sessions from ${allEndpoints.size} endpoints`);
        
        return {
            success: true,
            endpointsChecked: allEndpoints.size,
            sessionsFound: totalSessions,
            sessionsUpdated: updatedSessions
        };
        
    } catch (error) {
        console.error('❌ Error updating WhatsApp sessions:', error);
        return { success: false, error: error.message };
    }
}

// Function to get all WhatsApp sessions (for admin)
function getAllWhatsAppSessions() {
    const db = readDatabase();
    return db.whatsappSessions || {};
}

// Start periodic session updates
function startSessionMonitoring() {
    console.log('🔄 Starting WhatsApp session monitoring (every 2 minutes)');
    
    // Initial update after 30 seconds
    setTimeout(updateWhatsAppSessions, 30000);
    
    // Update every 2 minutes
    setInterval(updateWhatsAppSessions, 2 * 60 * 1000);
}

// Start health check monitoring
function startHealthCheckMonitoring() {
    console.log('🔄 Starting endpoint health monitoring (every 5 minutes)');
    
    // Initial health check after 1 minute
    setTimeout(healthCheckAllEndpoints, 60000);
    
    // Health check every 5 minutes
    setInterval(healthCheckAllEndpoints, 5 * 60 * 1000);
}

// ==================== REAL-TIME NOTIFICATIONS ====================

const connectedClients = new Map();

// ==================== ENHANCED GROUP/CHANNEL MANAGEMENT ====================

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
        // Remove from pending
        db.pendingGroups = db.pendingGroups.filter(g => g.id !== groupId);
        
        // Add to active groups with enhanced data
        if (!db.groups) db.groups = [];
        
        let inviteLink = pendingGroup.inviteLink;
        
        // Generate proper invite link if not exists
        if (!inviteLink && bot) {
            try {
                if (pendingGroup.type !== 'channel') {
                    // For groups, generate invite link
                    const invite = await bot.telegram.createChatInviteLink(pendingGroup.id, {
                        creates_join_request: false,
                        expire_date: null,
                        member_limit: null
                    });
                    inviteLink = invite.invite_link;
                } else if (pendingGroup.username) {
                    // For public channels, use t.me/username format
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
            approvedBy: ADMIN_CHAT_ID,
            lastVerified: new Date().toISOString()
        };
        
        db.groups.push(enhancedGroupData);
        writeDatabase(db);
        
        // Notify admin about successful addition
        if (bot) {
            await bot.telegram.sendMessage(
                ADMIN_CHAT_ID,
                `✅ *Sponsor Approved Successfully!*\n\n` +
                `📝 *Title:* ${pendingGroup.title}\n` +
                `📋 *Type:* ${pendingGroup.type}\n` +
                `🔗 *Link:* ${inviteLink || 'Manual join required'}\n\n` +
                `This sponsor is now visible to users and required for access.`,
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
        
        // Generate proper invite link if not provided
        if (!inviteLink && bot) {
            try {
                if (groupData.type !== 'channel') {
                    // For groups, generate invite link
                    const invite = await bot.telegram.createChatInviteLink(groupData.id, {
                        creates_join_request: false,
                        expire_date: null,
                        member_limit: null
                    });
                    inviteLink = invite.invite_link;
                } else if (groupData.username) {
                    // For public channels, use t.me/username format
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
            approvedBy: ADMIN_CHAT_ID,
            lastVerified: new Date().toISOString()
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
            approvedBy: ADMIN_CHAT_ID,
            lastVerified: new Date().toISOString()
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
    
    writeDatabase(db);
}

function checkUserAccess(userId) {
    const db = readDatabase();
    const groups = db.groups || [];
    
    if (groups.length === 0) {
        return true;
    }
    
    const membership = db.membershipChecks?.[userId];
    return membership && membership.isMember === true;
}

// ==================== PROFESSIONAL MEMBERSHIP VERIFICATION ====================

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
                    console.error('Bot not initialized for membership check');
                    allGroupsJoined = false;
                    notJoinedGroups.push(group);
                    continue;
                }
                
                let isMember = false;
                
                // Professional membership checking according to Telegram Bot API
                if (group.type === 'channel') {
                    // For channels - bot needs to be admin to check membership
                    try {
                        const chatMember = await bot.telegram.getChatMember(group.id, userId);
                        // Valid statuses for channel membership
                        isMember = ['creator', 'administrator', 'member'].includes(chatMember.status);
                        console.log(`✅ Channel ${group.title}: User ${userId} status: ${chatMember.status}, isMember: ${isMember}`);
                    } catch (error) {
                        console.error(`❌ Error checking channel membership for ${group.title}:`, error.message);
                        // If we can't verify (bot not admin), assume user needs to join
                        isMember = false;
                    }
                } else {
                    // For groups/supergroups
                    try {
                        const chatMember = await bot.telegram.getChatMember(group.id, userId);
                        // Valid statuses for group membership
                        isMember = ['creator', 'administrator', 'member', 'restricted'].includes(chatMember.status);
                        console.log(`✅ Group ${group.title}: User ${userId} status: ${chatMember.status}, isMember: ${isMember}`);
                    } catch (error) {
                        console.error(`❌ Error checking group membership for ${group.title}:`, error.message);
                        isMember = false;
                    }
                }
                
                if (!isMember) {
                    allGroupsJoined = false;
                    notJoinedGroups.push(group);
                }
            } catch (error) {
                console.error(`❌ Error checking membership for ${group.title}:`, error.message);
                allGroupsJoined = false;
                notJoinedGroups.push(group);
            }
            
            // Rate limiting to avoid hitting Telegram API limits
            await new Promise(resolve => setTimeout(resolve, 1000));
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

async function monitorMemberships() {
    try {
        console.log('🔍 Checking user memberships...');
        const db = readDatabase();
        const groups = getGroups();
        
        if (groups.length === 0 || !bot) return;
        
        let checked = 0;
        let restricted = 0;
        
        for (const userId of Object.keys(db.membershipChecks || {})) {
            if (userId === ADMIN_CHAT_ID) continue;
            
            const membershipCheck = await checkUserMembership(userId);
            if (!membershipCheck.hasAccess) {
                restricted++;
            }
            checked++;
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log(`✅ Membership check completed: ${checked} users checked, ${restricted} restricted`);
        
    } catch (error) {
        console.error('Error in membership monitoring:', error);
    }
}

function startMembershipMonitoring() {
    setInterval(monitorMemberships, 5 * 60 * 1000);
    console.log('🔍 Membership monitoring started (every 5 minutes)');
}

// ==================== MEMORY MANAGEMENT ====================
const memoryCache = new NodeCache({ 
    stdTTL: 3600,
    checkperiod: 600
});

function startMemoryCleanup() {
    setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
        
        console.log(`🧠 Memory usage: ${heapUsedMB.toFixed(2)}MB / ${config.maxMemoryMB}MB`);
        
        if (heapUsedMB > config.maxMemoryMB * 0.8) {
            console.log('⚠️ High memory usage detected, running cleanup...');
            performMemoryCleanup();
        }
        
        const keys = memoryCache.keys();
        if (keys.length > 1000) {
            const half = Math.floor(keys.length / 2);
            keys.slice(0, half).forEach(key => memoryCache.del(key));
            console.log(`🗑️ Cleaned ${half} cache entries`);
        }
        
    }, config.cleanupInterval);
}

function performMemoryCleanup() {
    try {
        memoryCache.flushAll();
        
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
    
    setTimeout(async () => {
        console.log('🔄 Running initial automatic backup...');
        await backupDatabaseToDropbox().catch(console.error);
    }, 2 * 60 * 1000);

    setInterval(async () => {
        console.log('🔄 Running scheduled automatic backup...');
        const result = await backupDatabaseToDropbox().catch(console.error);
        
        if (result && result.success) {
            const db = readDatabase();
            db.statistics.lastBackup = new Date().toISOString();
            writeDatabase(db);
        }
    }, config.backupInterval);

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

// Serve static files from views directory
app.use(express.static('views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== UPDATED REGISTRATION FORM ROUTES ====================

// Registration Form Route - Serve external HTML file
app.get('/register/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Serve the external HTML file - localStorage will handle account check
        res.sendFile(path.join(__dirname, 'views', 'registration.html'));
        
    } catch (error) {
        console.error('Registration form error:', error);
        res.status(500).send('Internal server error');
    }
});

// SSE endpoint for real-time updates
app.get('/api/events/:userId', (req, res) => {
    const userId = req.params.userId;
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    
    // Store the response object for later notifications
    connectedClients.set(userId, res);
    
    // Send initial connection message
    res.write(`data: ${JSON.stringify({
        type: 'connected',
        message: 'Real-time updates connected',
        timestamp: new Date().toISOString()
    })}\n\n`);
    
    // Remove client when connection closes
    req.on('close', () => {
        connectedClients.delete(userId);
    });
});

// Handle Registration Form Submission - SIMPLIFIED (just redirect)
app.post('/register/:userId', express.json(), (req, res) => {
    try {
        const userId = req.params.userId;
        const { firstName, lastName, email } = req.body;
        
        console.log(`📝 Registration form submitted for ${userId}:`, { firstName, lastName, email });
        
        // Just return success - localStorage handles the actual storage
        res.json({ 
            success: true, 
            message: 'Account created successfully!',
            redirectUrl: `/loading/${userId}`
        });
        
    } catch (error) {
        console.error('Registration submission error:', error);
        res.json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ==================== UPDATED WEB APP DASHBOARD ROUTES ====================

// Web App Dashboard Route (For Telegram Web App)
app.get('/webapp/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        if (userId === ADMIN_CHAT_ID) {
            return res.sendFile(path.join(__dirname, 'views', 'admin.html'));
        }
        
        // Check membership for non-admin users
        const membershipCheck = await checkUserMembership(userId);
        if (!membershipCheck.hasAccess) {
            return res.send(generateAccessDeniedPage(userId, membershipCheck.notJoinedGroups));
        }

        return res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
        
    } catch (error) {
        console.error('Web App error:', error);
        res.status(500).send('Internal server error');
    }
});

// API endpoint for user data - SIMPLIFIED (no user lookup in database)
app.get('/api/user/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const db = readDatabase();
        
        res.json({
            success: true,
            user: { id: userId }, // Minimal user info
            domain: SHORT_DOMAIN,
            welcomeMessage: db.settings?.webWelcomeMessage || "🎉 Welcome to your dashboard!"
        });
        
    } catch (error) {
        console.error('API user error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// API endpoint for admin users list - EMPTY (no users in database)
app.get('/admin/users', (req, res) => {
    try {
        res.json({
            success: true,
            users: [] // No users stored in database
        });
        
    } catch (error) {
        console.error('Admin users API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== UPDATED WHATSAPP SESSIONS API ====================

// Get all WhatsApp sessions (admin only)
app.get('/api/all-whatsapp-sessions', (req, res) => {
    try {
        const sessions = getAllWhatsAppSessions();
        const sessionArray = Object.values(sessions);
        
        res.json({
            success: true,
            sessions: sessionArray,
            total: sessionArray.length,
            connected: sessionArray.filter(s => s.isConnected).length,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('All WhatsApp sessions API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Manual trigger to update WhatsApp sessions
app.post('/api/update-sessions', async (req, res) => {
    try {
        const result = await updateWhatsAppSessions();
        res.json(result);
    } catch (error) {
        console.error('Update sessions error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== ENDPOINT MANAGEMENT ADMIN ROUTES ====================

// Get all endpoints with their prefixes and health status
app.get('/admin/endpoints', (req, res) => {
    try {
        const db = readDatabase();
        const endpointUsage = db.endpointUsage || {};
        const endpointHealth = db.endpointHealth || {};
        
        // Organize endpoints by prefix
        const endpointsByPrefix = {};
        
        Object.keys(ENDPOINTS).forEach(prefix => {
            endpointsByPrefix[prefix] = ENDPOINTS[prefix].map(endpoint => {
                const usage = endpointUsage[endpoint] || { userCount: 0, lastUsed: null, prefix: prefix };
                const health = endpointHealth[endpoint] || { status: 'unknown', lastChecked: null };
                
                return {
                    url: endpoint,
                    prefix: prefix,
                    userCount: usage.userCount,
                    totalAssigned: usage.totalAssigned || 0,
                    lastUsed: usage.lastUsed,
                    health: health.status,
                    responseTime: health.responseTime,
                    sessionsCount: health.sessionsCount || 0,
                    lastChecked: health.lastChecked,
                    errorCount: health.errorCount || 0,
                    successCount: health.successCount || 0
                };
            });
        });
        
        // Get all available prefixes
        const availablePrefixes = Object.keys(ENDPOINTS);
        
        res.json({
            success: true,
            endpointsByPrefix: endpointsByPrefix,
            availablePrefixes: availablePrefixes,
            totalEndpoints: Object.values(endpointsByPrefix).flat().length,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Admin endpoints error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add new endpoint to a specific prefix
app.post('/admin/endpoints/add', express.json(), (req, res) => {
    try {
        const { endpointUrl, prefix } = req.body;
        
        if (!endpointUrl || !prefix) {
            return res.json({ 
                success: false, 
                error: 'Endpoint URL and prefix are required' 
            });
        }
        
        // Validate URL format
        try {
            new URL(endpointUrl);
        } catch (error) {
            return res.json({ 
                success: false, 
                error: 'Invalid endpoint URL format' 
            });
        }
        
        // Check if prefix exists
        if (!ENDPOINTS[prefix]) {
            return res.json({ 
                success: false, 
                error: `Invalid prefix: ${prefix}. Available prefixes: ${Object.keys(ENDPOINTS).join(', ')}` 
            });
        }
        
        // Check if endpoint already exists in any prefix
        for (const existingPrefix in ENDPOINTS) {
            if (ENDPOINTS[existingPrefix].includes(endpointUrl)) {
                return res.json({ 
                    success: false, 
                    error: `Endpoint already exists in prefix: ${existingPrefix}` 
                });
            }
        }
        
        // Add endpoint to the specified prefix
        ENDPOINTS[prefix].push(endpointUrl);
        
        // Update database with new endpoint
        const db = readDatabase();
        
        // Initialize endpoint usage
        if (!db.endpointUsage) db.endpointUsage = {};
        db.endpointUsage[endpointUrl] = {
            userCount: 0,
            lastUsed: null,
            prefix: prefix,
            totalAssigned: 0,
            addedAt: new Date().toISOString()
        };
        
        // Initialize endpoint health
        if (!db.endpointHealth) db.endpointHealth = {};
        db.endpointHealth[endpointUrl] = {
            status: 'unknown',
            lastChecked: null,
            responseTime: null,
            errorCount: 0,
            successCount: 0,
            lastError: null,
            sessionsCount: 0
        };
        
        writeDatabase(db);
        
        console.log(`✅ New endpoint added: ${endpointUrl} to prefix: ${prefix}`);
        
        res.json({
            success: true,
            message: `Endpoint added successfully to prefix: ${prefix}`,
            endpoint: endpointUrl,
            prefix: prefix,
            totalEndpoints: ENDPOINTS[prefix].length
        });
        
    } catch (error) {
        console.error('Add endpoint error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Remove endpoint from system
app.delete('/admin/endpoints/remove', express.json(), (req, res) => {
    try {
        const { endpointUrl } = req.body;
        
        if (!endpointUrl) {
            return res.json({ 
                success: false, 
                error: 'Endpoint URL is required' 
            });
        }
        
        let removedFromPrefix = null;
        let endpointFound = false;
        
        // Remove endpoint from all prefixes
        Object.keys(ENDPOINTS).forEach(prefix => {
            const index = ENDPOINTS[prefix].indexOf(endpointUrl);
            if (index > -1) {
                ENDPOINTS[prefix].splice(index, 1);
                removedFromPrefix = prefix;
                endpointFound = true;
                console.log(`✅ Endpoint removed from prefix ${prefix}: ${endpointUrl}`);
            }
        });
        
        if (!endpointFound) {
            return res.json({ 
                success: false, 
                error: 'Endpoint not found in any prefix' 
            });
        }
        
        // Clean up database entries
        const db = readDatabase();
        
        // Remove from endpointUsage
        if (db.endpointUsage && db.endpointUsage[endpointUrl]) {
            const userCount = db.endpointUsage[endpointUrl].userCount;
            delete db.endpointUsage[endpointUrl];
            console.log(`🗑️ Removed from endpointUsage (had ${userCount} users)`);
        }
        
        // Remove from endpointHealth
        if (db.endpointHealth && db.endpointHealth[endpointUrl]) {
            delete db.endpointHealth[endpointUrl];
            console.log(`🗑️ Removed from endpointHealth`);
        }
        
        writeDatabase(db);
        
        res.json({
            success: true,
            message: `Endpoint removed successfully from prefix: ${removedFromPrefix}`,
            endpoint: endpointUrl,
            cleanup: {
                endpointUsage: true,
                endpointHealth: true
            }
        });
        
    } catch (error) {
        console.error('Remove endpoint error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Move endpoint to different prefix
app.post('/admin/endpoints/move', express.json(), (req, res) => {
    try {
        const { endpointUrl, newPrefix } = req.body;
        
        if (!endpointUrl || !newPrefix) {
            return res.json({ 
                success: false, 
                error: 'Endpoint URL and new prefix are required' 
            });
        }
        
        // Check if new prefix exists
        if (!ENDPOINTS[newPrefix]) {
            return res.json({ 
                success: false, 
                error: `Invalid prefix: ${newPrefix}. Available prefixes: ${Object.keys(ENDPOINTS).join(', ')}` 
            });
        }
        
        let oldPrefix = null;
        let endpointFound = false;
        
        // Remove from current prefix
        Object.keys(ENDPOINTS).forEach(prefix => {
            const index = ENDPOINTS[prefix].indexOf(endpointUrl);
            if (index > -1) {
                ENDPOINTS[prefix].splice(index, 1);
                oldPrefix = prefix;
                endpointFound = true;
            }
        });
        
        if (!endpointFound) {
            return res.json({ 
                success: false, 
                error: 'Endpoint not found in any prefix' 
            });
        }
        
        // Add to new prefix
        ENDPOINTS[newPrefix].push(endpointUrl);
        
        // Update database
        const db = readDatabase();
        
        if (db.endpointUsage && db.endpointUsage[endpointUrl]) {
            db.endpointUsage[endpointUrl].prefix = newPrefix;
            db.endpointUsage[endpointUrl].lastUpdated = new Date().toISOString();
        }
        
        writeDatabase(db);
        
        console.log(`🔀 Endpoint moved: ${endpointUrl} from ${oldPrefix} to ${newPrefix}`);
        
        res.json({
            success: true,
            message: `Endpoint moved from ${oldPrefix} to ${newPrefix}`,
            endpoint: endpointUrl,
            oldPrefix: oldPrefix,
            newPrefix: newPrefix
        });
        
    } catch (error) {
        console.error('Move endpoint error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Test endpoint health
app.post('/admin/endpoints/test', express.json(), async (req, res) => {
    try {
        const { endpointUrl } = req.body;
        
        if (!endpointUrl) {
            return res.json({ 
                success: false, 
                error: 'Endpoint URL is required' 
            });
        }
        
        console.log(`🔍 Testing endpoint: ${endpointUrl}`);
        
        const health = await checkEndpointHealth(endpointUrl);
        
        // Update database with test result
        const db = readDatabase();
        if (db.endpointHealth) {
            db.endpointHealth[endpointUrl] = {
                ...db.endpointHealth[endpointUrl],
                ...health,
                lastChecked: new Date().toISOString()
            };
            writeDatabase(db);
        }
        
        res.json({
            success: true,
            endpoint: endpointUrl,
            health: health,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Test endpoint error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get endpoint statistics
app.get('/admin/endpoints/stats', (req, res) => {
    try {
        const db = readDatabase();
        const endpointUsage = db.endpointUsage || {};
        const endpointHealth = db.endpointHealth || {};
        
        const stats = {
            totalEndpoints: 0,
            healthyEndpoints: 0,
            unhealthyEndpoints: 0,
            downEndpoints: 0,
            totalUsers: 0,
            byPrefix: {},
            topEndpoints: []
        };
        
        // Calculate stats by prefix
        Object.keys(ENDPOINTS).forEach(prefix => {
            stats.byPrefix[prefix] = {
                endpoints: ENDPOINTS[prefix].length,
                users: 0,
                healthy: 0,
                unhealthy: 0,
                down: 0
            };
            
            ENDPOINTS[prefix].forEach(endpoint => {
                stats.totalEndpoints++;
                const usage = endpointUsage[endpoint] || { userCount: 0 };
                const health = endpointHealth[endpoint] || { status: 'unknown' };
                
                stats.byPrefix[prefix].users += usage.userCount;
                stats.totalUsers += usage.userCount;
                
                if (health.status === 'healthy') {
                    stats.healthyEndpoints++;
                    stats.byPrefix[prefix].healthy++;
                } else if (health.status === 'unhealthy') {
                    stats.unhealthyEndpoints++;
                    stats.byPrefix[prefix].unhealthy++;
                } else if (health.status === 'down') {
                    stats.downEndpoints++;
                    stats.byPrefix[prefix].down++;
                }
                
                // Collect top endpoints by user count
                stats.topEndpoints.push({
                    url: endpoint,
                    prefix: prefix,
                    userCount: usage.userCount,
                    health: health.status,
                    responseTime: health.responseTime
                });
            });
        });
        
        // Sort top endpoints by user count
        stats.topEndpoints.sort((a, b) => b.userCount - a.userCount);
        stats.topEndpoints = stats.topEndpoints.slice(0, 10);
        
        res.json({
            success: true,
            statistics: stats,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Endpoint stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== SMART ENDPOINT LOAD BALANCING API ENDPOINTS ====================

// Get balanced endpoint for prefix
app.post('/api/get-endpoint', (req, res) => {
    try {
        const { prefix } = req.body;
        
        if (!prefix || !ENDPOINTS[prefix]) {
            return res.json({ 
                success: false, 
                error: 'Invalid prefix selected' 
            });
        }
        
        const endpoint = getBalancedEndpoint(prefix);
        
        if (!endpoint) {
            return res.json({ 
                success: false, 
                error: 'No endpoints available for this prefix' 
            });
        }
        
        res.json({
            success: true,
            endpoint: endpoint,
            prefix: prefix
        });
        
    } catch (error) {
        console.error('Get endpoint error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get endpoint health status
app.get('/api/endpoint-health', (req, res) => {
    try {
        const db = readDatabase();
        const health = db.endpointHealth || {};
        
        res.json({
            success: true,
            health: health,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Endpoint health error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Manual health check trigger
app.post('/api/health-check', async (req, res) => {
    try {
        const result = await healthCheckAllEndpoints();
        res.json(result);
    } catch (error) {
        console.error('Health check error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get endpoint usage statistics
app.get('/api/endpoint-stats', (req, res) => {
    try {
        const db = readDatabase();
        const stats = db.endpointUsage || {};
        const health = db.endpointHealth || {};
        
        // Calculate totals
        const totals = {};
        Object.keys(ENDPOINTS).forEach(prefix => {
            totals[prefix] = {
                totalUsers: 0,
                availableEndpoints: ENDPOINTS[prefix].length,
                healthyEndpoints: 0
            };
            
            ENDPOINTS[prefix].forEach(endpoint => {
                if (stats[endpoint]) {
                    totals[prefix].totalUsers += stats[endpoint].userCount;
                }
                if (health[endpoint] && health[endpoint].status === 'healthy') {
                    totals[prefix].healthyEndpoints++;
                }
            });
        });
        
        res.json({
            success: true,
            stats: stats,
            health: health,
            totals: totals,
            endpoints: ENDPOINTS
        });
        
    } catch (error) {
        console.error('Endpoint stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== SIMPLIFIED PAIR NUMBER ENDPOINT ====================

// Pair WhatsApp number - Just returns the endpoint, frontend handles pairing
app.post('/api/pair-number', async (req, res) => {
    let endpoint = null;
    
    try {
        const { phoneNumber, prefix } = req.body;
        const userId = req.headers['user-id'] || req.body.userId || 'unknown';
        
        console.log(`📱 Pairing request: ${phoneNumber} with prefix ${prefix}`);
        
        if (!phoneNumber || !prefix) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters: phoneNumber and prefix' 
            });
        }
        
        // Validate phone number
        const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
        if (!phoneRegex.test(phoneNumber)) {
            return res.json({ 
                success: false, 
                error: 'Invalid phone number format' 
            });
        }
        
        // Get balanced endpoint for the prefix
        endpoint = getBalancedEndpoint(prefix);
        
        if (!endpoint) {
            return res.json({
                success: false,
                error: `No endpoints available for prefix: ${prefix}`
            });
        }

        console.log(`🔀 Selected endpoint: ${endpoint} for user ${userId}`);
        
        // ✅ ADD DROPBOX BACKUP
        await backupDatabaseToDropbox().catch(error => {
            console.error('❌ Dropbox backup failed after pairing:', error.message);
        });
        
        console.log(`✅ Bot assigned for user ${userId}: ${phoneNumber} on ${endpoint}`);
        
        res.json({
            success: true,
            endpoint: endpoint,
            message: 'Endpoint assigned successfully. Please pair using the provided endpoint.'
        });
        
    } catch (error) {
        console.error('Pair number error:', error);
        
        // Release endpoint on error
        if (endpoint) {
            releaseEndpoint(endpoint);
        }
        
        res.status(500).json({ 
            success: false, 
            error: `Pairing failed: ${error.message}` 
        });
    }
});

// Stop bot - Backend knows which endpoint to use
app.post('/api/stop-bot', async (req, res) => {
    try {
        const { phoneNumber, userId } = req.body;
        
        if (!phoneNumber || !userId) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters' 
            });
        }
        
        console.log(`🛑 Stopping bot: ${phoneNumber} for user ${userId}`);
        
        // Release endpoint
        // Note: We don't track user bots in database anymore
        // Frontend will handle the actual stop via the endpoint
        
        res.json({
            success: true,
            message: 'Bot stopped successfully'
        });
        
    } catch (error) {
        console.error('Stop bot error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Restart bot - Get new endpoint
app.post('/api/restart-bot', async (req, res) => {
    let newEndpoint = null;
    
    try {
        const { phoneNumber, prefix, userId } = req.body;
        
        if (!phoneNumber || !prefix || !userId) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters' 
            });
        }
        
        console.log(`🔄 Restarting bot: ${phoneNumber} with prefix ${prefix} for user ${userId}`);
        
        // Get new balanced endpoint for the prefix
        newEndpoint = getBalancedEndpoint(prefix);
        
        if (!newEndpoint) {
            return res.json({
                success: false,
                error: `No endpoints available for prefix: ${prefix}`
            });
        }

        console.log(`🔀 Selected new endpoint: ${newEndpoint} for prefix ${prefix}`);
        
        console.log(`✅ Bot restarted successfully: ${phoneNumber} on ${newEndpoint}`);
        
        res.json({
            success: true,
            endpoint: newEndpoint,
            message: 'Bot restarted successfully with new endpoint'
        });
        
    } catch (error) {
        console.error('Restart bot error:', error);
        
        // Release endpoint on error
        if (newEndpoint) {
            releaseEndpoint(newEndpoint);
        }
        
        res.status(500).json({ 
            success: false, 
            error: `Restart failed: ${error.message}` 
        });
    }
});

// PROFESSIONAL LOADING PAGE
app.get('/loading/:userId', (req, res) => {
    const userId = req.params.userId;
    
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V3 - Loading</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
        /* ... (same loading page styles as before) ... */
        </style>
    </head>
    <body>
        <div class="loading-container">
            <div class="loading-card">
                <!-- ... (same loading page content as before) ... -->
            </div>
        </div>
        
        <script>
            // Redirect to dashboard after 3 seconds
            setTimeout(() => {
                window.location.href = '/webapp/${userId}';
            }, 3000);
        </script>
    </body>
    </html>
    `);
});

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

// Admin API endpoints
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
        console.error('Remove group error:', error);
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
            res.status(404).json({ success: false, error: 'Group not found in pending list' });
        }
    } catch (error) {
        console.error('Approve group error:', error);
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
            res.status(404).json({ success: false, error: 'Group not found in pending list' });
        }
    } catch (error) {
        console.error('Reject group error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/admin/statistics', (req, res) => {
    try {
        const stats = getStatistics();
        res.json({ success: true, statistics: stats });
    } catch (error) {
        console.error('Statistics error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ENDPOINT SESSIONS API
app.get('/api/endpoint-sessions', (req, res) => {
    try {
        const db = readDatabase();
        const sessions = db.whatsappSessions || {};
        const endpointHealth = db.endpointHealth || {};
        
        // Organize sessions by endpoint
        const sessionsByEndpoint = {};
        
        Object.entries(sessions).forEach(([sessionKey, session]) => {
            const endpoint = session.endpoint;
            
            if (!sessionsByEndpoint[endpoint]) {
                sessionsByEndpoint[endpoint] = {
                    endpoint: endpoint,
                    health: endpointHealth[endpoint] || { status: 'unknown' },
                    sessions: [],
                    totalSessions: 0,
                    connectedSessions: 0,
                    disconnectedSessions: 0
                };
            }
            
            sessionsByEndpoint[endpoint].sessions.push({
                phoneNumber: session.phoneNumber,
                mode: session.mode,
                health: session.health,
                isConnected: session.isConnected,
                messagesProcessed: session.messagesProcessed,
                errors: session.errors,
                queueSize: session.queueSize,
                lastActivity: session.lastActivity,
                welcomeSent: session.welcomeSent,
                lastUpdated: session.lastUpdated
            });
            
            sessionsByEndpoint[endpoint].totalSessions++;
            if (session.isConnected) {
                sessionsByEndpoint[endpoint].connectedSessions++;
            } else {
                sessionsByEndpoint[endpoint].disconnectedSessions++;
            }
        });
        
        // Convert to array and add empty endpoints
        Object.keys(endpointHealth).forEach(endpoint => {
            if (!sessionsByEndpoint[endpoint]) {
                sessionsByEndpoint[endpoint] = {
                    endpoint: endpoint,
                    health: endpointHealth[endpoint],
                    sessions: [],
                    totalSessions: 0,
                    connectedSessions: 0,
                    disconnectedSessions: 0
                };
            }
        });
        
        const result = Object.values(sessionsByEndpoint);
        
        res.json({
            success: true,
            endpoints: result,
            summary: {
                totalEndpoints: result.length,
                totalSessions: result.reduce((sum, ep) => sum + ep.totalSessions, 0),
                totalConnected: result.reduce((sum, ep) => sum + ep.connectedSessions, 0),
                totalDisconnected: result.reduce((sum, ep) => sum + ep.disconnectedSessions, 0),
                healthyEndpoints: result.filter(ep => ep.health.status === 'healthy').length,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Endpoint sessions API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/admin/groups', (req, res) => {
    try {
        const groups = getGroups();
        const pendingGroups = getPendingGroups();
        res.json({ success: true, groups: groups, pendingGroups: pendingGroups });
    } catch (error) {
        console.error('Get groups error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/backup-status', async (req, res) => {
    try {
        const db = readDatabase();
        res.json({
            success: true,
            lastBackup: db.statistics.lastBackup,
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

app.get('/', (req, res) => {
    try {
        const db = readDatabase();
        const stats = getStatistics();
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>BIG DADDY V3 Dashboard</title>
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
                        max-width: 600px;
                    }
                    .stats {
                        margin: 20px 0;
                        padding: 15px;
                        background: rgba(255,255,255,0.1);
                        border-radius: 10px;
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                        gap: 15px;
                    }
                    .stat-item {
                        padding: 10px;
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
                    <h1>🚀 BIG DADDY V3</h1>
                    <p>Telegram Bot Dashboard System</p>
                    
                    <div class="stats">
                        <div class="stat-item">
                            <p><strong>Server:</strong> ${SHORT_DOMAIN}</p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Status:</strong> <span class="status-badge">✅ Online</span></p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Active Sessions:</strong> ${stats.activeWhatsAppSessions}</p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Healthy Endpoints:</strong> ${stats.healthyEndpoints}/${stats.totalEndpoints}</p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Dropbox Backup:</strong> <span class="status-badge">✅ Connected</span></p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Telegram Bot:</strong> <span class="status-badge">✅ Active</span></p>
                        </div>
                    </div>
                    
                    <div>
                        <a href="/backup-status" style="color: white; margin: 10px;">📊 Backup Status</a>
                        <a href="/health" style="color: white; margin: 10px;">🏥 Health Check</a>
                        <a href="/trigger-backup" style="color: white; margin: 10px;">💾 Backup Now</a>
                        <a href="/admin/statistics" style="color: white; margin: 10px;">👑 Admin Stats</a>
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

// ==================== HELPER FUNCTIONS FOR HTML PAGES ====================

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
                max-width: 600px;
            }
            .warning-icon {
                font-size: 4rem;
                margin-bottom: 20px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="warning-icon">🔒</div>
            <h1>Access Required</h1>
            <p>To use this bot, you need to join all our sponsor channels first.</p>
            
            <h3>Required Channels:</h3>
            <ul style="text-align: left; display: inline-block;">
                ${groupsList}
            </ul>
            
            <p>After joining all channels, return to Telegram and use /start again.</p>
            
            <button onclick="window.location.href='/webapp/${userId}'" 
                    style="background: #4CAF50; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 20px;">
                Check Access Again
            </button>
        </div>
    </body>
    </html>
    `;
}

// ==================== PROFESSIONAL TELEGRAM BOT SETUP ====================

// Custom session middleware to ensure session exists
function ensureSession(ctx, next) {
    if (!ctx.session) {
        ctx.session = {};
        console.log(`🆕 ensureSession: Created session for ${ctx.from?.id}`);
    }
    return next();
}

// Function to handle automatic group detection
async function handleAutoGroupDetection(ctx) {
    try {
        const chat = ctx.chat;
        
        // Only process group events
        if (chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel')) {
            
            // Check if bot was added to the group
            if (ctx.message && ctx.message.new_chat_members) {
                const newMembers = ctx.message.new_chat_members;
                const botInfo = await bot.telegram.getMe();
                
                const botWasAdded = newMembers.some(member => member.id === botInfo.id);
                
                if (botWasAdded) {
                    console.log(`🤖 Bot was added to ${chat.type}: ${chat.title} (ID: ${chat.id})`);
                    
                    // Try to generate invite link (only for groups, not channels)
                    let inviteLink = null;
                    try {
                        if (chat.type !== 'channel') {
                            inviteLink = await generateGroupInviteLink(chat.id);
                        } else {
                            // For channels, use the public link if available
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
                    
                    if (success) {
                        // Notify admin for approval
                        await bot.telegram.sendMessage(
                            ADMIN_CHAT_ID,
                            `🆕 *New ${chat.type === 'channel' ? 'Channel' : 'Group'} Detected*\n\n` +
                            `📝 *Title:* ${chat.title}\n` +
                            `🆔 *ID:* ${chat.id}\n` +
                            `📋 *Type:* ${chat.type}\n` +
                            `🔗 *Invite Link:* ${inviteLink || 'Not available'}\n\n` +
                            `*Do you want to add this as a required sponsor?*`,
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
            
            // Check if bot was removed from group
            if (ctx.message && ctx.message.left_chat_member) {
                const leftMember = ctx.message.left_chat_member;
                const botInfo = await bot.telegram.getMe();
                
                if (leftMember.id === botInfo.id) {
                    console.log(`🚫 Bot was removed from ${chat.type}: ${chat.title} (ID: ${chat.id})`);
                    
                    removeGroup(chat.id.toString());
                    rejectGroup(chat.id.toString());
                    
                    await bot.telegram.sendMessage(
                        ADMIN_CHAT_ID,
                        `🚫 *Bot Removed from ${chat.type === 'channel' ? 'Channel' : 'Group'}*\n\n` +
                        `📝 *${chat.type === 'channel' ? 'Channel' : 'Group'}:* ${chat.title}\n` +
                        `🆔 *ID:* ${chat.id}\n\n` +
                        `This ${chat.type === 'channel' ? 'channel' : 'group'} has been automatically removed from sponsors list.`,
                        { parse_mode: 'Markdown' }
                    );
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
        
        // Initialize session with proper middleware
        bot.use(session());
        bot.use(ensureSession);

        // ==================== BOT COMMANDS ====================

        // Start command
        bot.start(async (ctx) => {
            try {
                const userId = ctx.from.id.toString();
                console.log(`🚀 Start command from user: ${userId}`);
                
                if (!ctx.session) {
                    ctx.session = {};
                    console.log(`🆕 Created session for ${userId}`);
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
                await ctx.reply('❌ Access denied  admin only');
            }
        });

        bot.command('pending', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied  admin only.');
                return;
            }
            
            const pendingGroups = getPendingGroups();
            if (pendingGroups.length === 0) {
                await ctx.reply('📭 No pending groups/channels for approval.');
                return;
            }
            
            let message = `⏳ *Pending Groups/Channels (${pendingGroups.length}):*\n\n`;
            pendingGroups.forEach((group, index) => {
                message += `${index + 1}. ${group.title}\n`;
                message += `   🆔 ID: ${group.id}\n`;
                message += `   📋 Type: ${group.type}\n`;
                message += `   ➕ Detected: ${new Date(group.detectedAt).toLocaleDateString()}\n\n`;
            });
            
            await ctx.reply(
                message,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.webApp('👑 Manage in Dashboard', `${config.webBaseUrl}/webapp/${ctx.from.id}`)]
                    ])
                }
            );
        });

        // FIXED: Proper Channel Addition Command
        bot.command('addchannel', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied sponsors only. message @phistar1 to become a sponsor');
                return;
            }
            
            const args = ctx.message.text.split(' ').slice(1);
            if (args.length < 2) {
                await ctx.reply(
                    '📝 To add a channel PROPERLY:\n\n' +
                    'Usage: `/addchannel CHANNEL_ID Channel Name`\n\n' +
                    'Example: `/addchannel -1001234567890 My Channel`\n\n' +
                    '💡 *How to get Channel ID:*\n' +
                    '1. Add @RawDataBot to your channel\n' +
                    '2. Forward any message from your channel to @RawDataBot\n' +
                    '3. It will show you the real channel ID\n' +
                    '4. Use that ID (starts with -100)\n\n' +
                    '⚠️ *CRITICAL:* Fake IDs will NOT work!',
                    { parse_mode: 'Markdown' }
                );
                return;
            }
            
            const channelId = args[0];
            const channelName = args.slice(1).join(' ');
            
            // Validate channel ID format
            if (!channelId.startsWith('-100')) {
                await ctx.reply(
                    '❌ *Invalid Channel ID!*\n\n' +
                    'Channel IDs must start with `-100`\n\n' +
                    'Get the real ID using @RawDataBot\n' +
                    'Forward a channel message to @RawDataBot and it will show you the correct ID.',
                    { parse_mode: 'Markdown' }
                );
                return;
            }
            
            // Test if bot can access this channel
            try {
                await ctx.reply(`🔍 Testing access to channel ${channelId}...`);
                
                const chat = await bot.telegram.getChat(channelId);
                const botInfo = await bot.telegram.getMe();
                const botMember = await bot.telegram.getChatMember(channelId, botInfo.id);
                
                if (!['creator', 'administrator'].includes(botMember.status)) {
                    await ctx.reply(
                        '❌ *Bot is not Admin in this channel!*\n\n' +
                        `Channel: ${chat.title}\n` +
                        `Bot Status: ${botMember.status}\n\n` +
                        'Please make the bot an ADMIN in the channel with:\n' +
                        '✅ Post Messages\n' +
                        '✅ Edit Messages  \n' +
                        '✅ **View Messages (CRITICAL)**\n' +
                        '✅ **View Members (CRITICAL)**',
                        { parse_mode: 'Markdown' }
                    );
                    return;
                }
                
                // Create channel data with REAL ID
                const channelData = {
                    id: channelId, // REAL ID
                    title: channelName,
                    username: chat.username || null,
                    inviteLink: chat.username ? `https://t.me/${chat.username}` : null,
                    type: 'channel',
                    addedAt: new Date().toISOString(),
                    isActive: true,
                    approvedBy: ADMIN_CHAT_ID,
                    isManual: true,
                    realTitle: chat.title // Store actual title from Telegram
                };
                
                const success = await addGroupWithInvite(channelData);
                
                if (success) {
                    await ctx.reply(
                        `✅ *Channel Added Successfully!*\n\n` +
                        `📝 *Name:* ${channelName}\n` +
                        `🆔 *Real ID:* ${channelId}\n` +
                        `🏷️ *Telegram Title:* ${chat.title}\n` +
                        `🔗 *Username:* ${chat.username ? '@' + chat.username : 'Private'}\n` +
                        `🤖 *Bot Status:* ${botMember.status}\n\n` +
                        `Membership verification should now work!`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    await ctx.reply('❌ Channel already exists in the list.');
                }
                
            } catch (error) {
                await ctx.reply(
                    `❌ *Cannot access channel!*\n\n` +
                    `Error: ${error.message}\n\n` +
                    `*Possible Issues:*\n` +
                    `• Wrong channel ID\n` +
                    `• Bot not in channel\n` +
                    `• Bot not admin\n` +
                    `• Channel is private\n\n` +
                    `💡 *Solution:*\n` +
                    `1. Add bot to channel as ADMIN\n` +
                    `2. Get correct ID from @RawDataBot\n` +
                    `3. Use ID that starts with -100`,
                    { parse_mode: 'Markdown' }
                );
            }
        });

        // Group management commands
        bot.command('addgroup', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied sponsors only. message @phistar1 to become a sponsor');
                return;
            }
            
            if (ctx.message.reply_to_message && ctx.message.reply_to_message.chat) {
                const chat = ctx.message.reply_to_message.chat;
                
                // Try to generate invite link
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
                    title: chat.title,
                    username: chat.username,
                    inviteLink: inviteLink,
                    type: chat.type === 'channel' ? 'channel' : 'group'
                };
                
                const success = await addGroupWithInvite(groupData);
                if (success) {
                    await ctx.reply(
                        `✅ *Sponsor Added Successfully!*\n\n` +
                        `📝 *Title:* ${chat.title}\n` +
                        `🆔 *ID:* ${chat.id}\n` +
                        `📋 *Type:* ${chat.type}\n` +
                        `🔗 *Invite Link:* ${inviteLink || 'Not available'}\n\n` +
                        `Users will now need to join this sponsor to access the bot.`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    await ctx.reply('❌ Sponsor already exists in the list.');
                }
            } else {
                await ctx.reply(
                    '📝 To add a sponsor:\n\n' +
                    '1. Add the bot to the group/channel as admin\n' +
                    '2. Make sure the bot can see members\n' +
                    '3. Reply to any message in that group with /addgroup\n\n' +
                    '💡 *Note:* The bot will automatically detect when it\'s added to new groups and ask for approval!',
                    { parse_mode: 'Markdown' }
                );
            }
        });

        bot.command('removegroup', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
                return;
            }
            
            const groups = getGroups();
            if (groups.length === 0) {
                await ctx.reply('📭 No sponsors configured.');
                return;
            }
            
            const keyboard = groups.map(group => 
                [Markup.button.callback(
                    `${group.title} (${group.type})`, 
                    `remove_group_${group.id}`
                )]
            );
            
            await ctx.reply(
                '🗑️ Select a sponsor to remove:',
                Markup.inlineKeyboard(keyboard)
            );
        });

        bot.command('listgroups', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
                return;
            }
            
            const groups = getGroups();
            if (groups.length === 0) {
                await ctx.reply('📭 No sponsors configured.');
                return;
            }
            
            let message = `📋 *Required Sponsors (${groups.length}):*\n\n`;
            groups.forEach((group, index) => {
                message += `${index + 1}. ${group.title}\n`;
                message += `   🆔 ID: ${group.id}\n`;
                message += `   📋 Type: ${group.type}\n`;
                message += `   🔗 Link: ${group.inviteLink || 'No link'}\n`;
                message += `   ➕ Added: ${new Date(group.addedAt).toLocaleDateString()}\n\n`;
            });
            
            await ctx.reply(message, { parse_mode: 'Markdown' });
        });

        // Handle group events
        bot.on('message', async (ctx) => {
            // Only process group events, let other handlers process regular messages
            if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup' || ctx.chat.type === 'channel')) {
                await handleAutoGroupDetection(ctx);
            }
        });

        // ==================== UPDATED ACTIONS - WEB REGISTRATION ====================

        // Create account process - OPEN WEB APP INSTEAD
        bot.action('create_account', async (ctx) => {
            try {
                await ctx.answerCbQuery();
                const userId = ctx.from.id.toString();
                
                console.log(`📝 Create account initiated for ${userId}`);
                
                await ctx.reply(
                    '📝 *Account Registration*\n\n' +
                    'Click the button below to open the registration form and create your account:',
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.webApp('🚀 Open Registration Form', `${config.webBaseUrl}/register/${userId}`)]
                        ])
                    }
                );
                
            } catch (error) {
                console.error('Create account error:', error);
                await ctx.answerCbQuery('❌ Error opening registration form');
            }
        });

        // Check membership - PROFESSIONAL VERSION
        bot.action('check_membership', async (ctx) => {
            try {
                await ctx.answerCbQuery('🔄 Checking your membership...');
                const userId = ctx.from.id.toString();
                
                const membershipCheck = await checkUserMembership(userId);
                
                if (membershipCheck.hasAccess) {
                    // User has access - show success message
                    await ctx.editMessageText(
                        '✅ *Access Granted!*\n\n' +
                        'You have successfully joined all required sponsors. You can now use the bot features.\n\n' +
                        'Click below to create your account:',
                        {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback('📝 Create Account', 'create_account')]
                            ])
                        }
                    );
                } else {
                    // User still doesn't have access - show join required message again
                    await showJoinRequiredMessage(ctx, membershipCheck.notJoinedGroups);
                }
            } catch (error) {
                console.error('❌ Check membership error:', error);
                await ctx.answerCbQuery('❌ Error checking membership');
            }
        });

        // Handle no link callback
        bot.action('no_link', async (ctx) => {
            await ctx.answerCbQuery('❌ No invite link available for this sponsor. Please contact admin.');
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
                await ctx.editMessageText(
                    `✅ *Sponsor Approved!*\n\n` +
                    `The sponsor has been added to required list and is now visible to users.\n\n` +
                    `Users will now need to join this sponsor to access the bot.`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await ctx.editMessageText('❌ Sponsor not found or already approved.');
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
                await ctx.editMessageText('❌ Sponsor rejected successfully.');
            } else {
                await ctx.editMessageText('❌ Sponsor not found in pending list.');
            }
            await ctx.answerCbQuery();
        });

        // Admin panel actions
        bot.action('admin_stats', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await ctx.answerCbQuery();
                await showStatistics(ctx);
            }
        });

        bot.action('admin_backup', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await ctx.answerCbQuery();
                await triggerBackup(ctx);
            }
        });

        // Add pending groups action
        bot.action('admin_pending', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.answerCbQuery('❌ Access denied.');
                return;
            }
            
            await ctx.answerCbQuery();
            const pendingGroups = getPendingGroups();
            
            if (pendingGroups.length === 0) {
                await ctx.reply('📭 No pending groups/channels for approval.');
                return;
            }
            
            let message = `⏳ *Pending Groups/Channels (${pendingGroups.length}):*\n\n`;
            pendingGroups.forEach((group, index) => {
                message += `${index + 1}. ${group.title}\n`;
                message += `   🆔 ID: ${group.id}\n`;
                message += `   📋 Type: ${group.type}\n`;
                message += `   ➕ Detected: ${new Date(group.detectedAt).toLocaleDateString()}\n\n`;
            });
            
            await ctx.reply(
                message,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.webApp('👑 Manage in Dashboard', `${config.webBaseUrl}/webapp/${ctx.from.id}`)]
                    ])
                }
            );
        });

        // Handle group removal callback
        bot.action(/remove_group_(.+)/, async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.answerCbQuery('❌ Access denied.');
                return;
            }
            
            const groupId = ctx.match[1];
            const success = removeGroup(groupId);
            
            if (success) {
                await ctx.editMessageText('✅ Sponsor removed successfully!');
            } else {
                await ctx.editMessageText('❌ Sponsor not found.');
            }
            await ctx.answerCbQuery();
        });

        // ==================== SIMPLIFIED TEXT MESSAGE HANDLER ====================
        bot.on('text', async (ctx) => {
            try {
                const userId = ctx.from.id.toString();
                const text = ctx.message.text.trim();
                
                console.log(`📝 Text received from ${userId}: "${text}"`);
                
                // Ignore commands
                if (text.startsWith('/')) {
                    return;
                }
                
                // Skip group messages
                if (ctx.chat.type !== 'private') {
                    return;
                }
                
                // If user sends text but we're not in registration mode, guide them
                if (!ctx.session || !ctx.session.setupStep) {
                    await ctx.reply(
                        '👋 Hello! To get started, please use the menu or click "Create Account" to begin registration.',
                        Markup.inlineKeyboard([
                            [Markup.button.callback('📝 Create Account', 'create_account')]
                        ])
                    );
                }
                
            } catch (error) {
                console.error('Text message handler error:', error);
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

async function handleAdminStart(ctx) {
    const userId = ctx.from.id.toString();
    const db = readDatabase();
    const adminWelcome = db.settings?.adminWelcomeMessage || "👑 *Welcome to Admin Panel*\n\nManage your bot users and monitor statistics.";
    
    await ctx.reply(
        adminWelcome,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('👑 Admin Dashboard', `${config.webBaseUrl}/webapp/${userId}`)],
                [Markup.button.callback('📊 Statistics', 'admin_stats')],
                [Markup.button.callback('💾 Backup Now', 'admin_backup')]
            ])
        }
    );
}

async function handleUserStart(ctx) {
    try {
        const userId = ctx.from.id.toString();
        const db = readDatabase();
        
        console.log(`👤 User start: ${userId}`);
        
        // Clear any existing session
        if (ctx.session) {
            ctx.session.setupStep = null;
        }
        
        const welcomeMessage = db.settings?.welcomeMessage || "👋 *Welcome to BIG DADDY V3 Bot!*\n\nTo access the bot, you need to join our sponsor channels first. After joining all required channels, you'll be able to create your account and start using the bot features.";
        
        // Check membership FIRST for all users
        const membershipCheck = await checkUserMembership(userId);
        
        if (!membershipCheck.hasAccess) {
            console.log(`🔒 User ${userId} doesn't have access to all sponsors`);
            await showJoinRequiredMessage(ctx, membershipCheck.notJoinedGroups);
            return;
        }
        
        // User has access to all sponsors - allow registration
        console.log(`✅ User has access to sponsors: ${userId}`);
        await ctx.reply(
            welcomeMessage,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📝 Create Account', 'create_account')]
                ])
            }
        );
    } catch (error) {
        console.error('❌ Handle user start error:', error);
        await ctx.reply('❌ Sorry, an error occurred. Please try again.');
    }
}

async function showJoinRequiredMessage(ctx, notJoinedGroups) {
    const keyboard = [];
    
    // Create proper join buttons for each required group/channel
    notJoinedGroups.forEach(group => {
        let link = group.inviteLink;
        
        // Generate proper links based on group type
        if (!link && group.username) {
            link = `https://t.me/${group.username}`;
        }
        
        if (link) {
            keyboard.push([Markup.button.url(`🔗 Join ${group.title}`, link)]);
        } else {
            // For private groups without links, show message
            keyboard.push([Markup.button.callback(`❌ ${group.title} (Contact Admin)`, 'no_link')]);
        }
    });
    
    // Add verification button
    keyboard.push([Markup.button.callback('✅ I Have Joined - Verify Membership', 'check_membership')]);
    
    let message = `🔒 *Access Required*\n\n` +
                 `To use this bot, you need to join *ALL* our sponsor groups/channels:\n\n`;
    
    notJoinedGroups.forEach((group, index) => {
        let linkInfo = '';
        if (group.username) {
            linkInfo = ` (@${group.username})`;
        } else if (group.inviteLink) {
            linkInfo = ` - Use button below`;
        }
        message += `${index + 1}. *${group.title}* (${group.type})${linkInfo}\n`;
    });
    
    message += `\n📋 *Instructions:*\n` +
               `1. Click the buttons above to join each sponsor\n` +
               `2. After joining ALL sponsors, click "Verify Membership"\n` +
               `3. Once verified, you can create your account\n\n` +
               `*Note:* You must join ALL sponsors to gain access.`;
    
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
    const pendingGroups = getPendingGroups();
    
    let pendingText = '';
    if (pendingGroups.length > 0) {
        pendingText = `\n⏳ *Pending Approval:* ${pendingGroups.length}`;
    }
    
    await ctx.reply(
        `👑 *Admin Panel*${pendingText}\n\n` +
        `📊 *Statistics:*\n` +
        `• Active Sessions: ${stats.activeWhatsAppSessions}\n` +
        `• Healthy Endpoints: ${stats.healthyEndpoints}/${stats.totalEndpoints}\n` +
        `• System Boots: ${stats.startupCount}\n\n` +
        `Choose an action:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('📱 Web Dashboard', `${config.webBaseUrl}/webapp/${ctx.from.id}`)],
                [Markup.button.callback('📊 Refresh Stats', 'admin_stats')],
                [Markup.button.callback('⏳ Pending Groups', 'admin_pending')],
                [Markup.button.callback('💾 Backup Now', 'admin_backup')]
            ])
        }
    );
}

async function showStatistics(ctx) {
    const stats = getStatistics();
    const db = readDatabase();
    const groups = getGroups();
    const pendingGroups = getPendingGroups();
    
    let groupsText = '';
    groups.forEach((group, index) => {
        groupsText += `\n${index + 1}. ${group.title} (${group.type})`;
    });
    
    let pendingText = '';
    pendingGroups.forEach((group, index) => {
        pendingText += `\n${index + 1}. ${group.title} (${group.type})`;
    });
    
    await ctx.reply(
        `📊 *System Statistics*\n\n` +
        `🤖 *WhatsApp Sessions:*\n` +
        `• Active: ${stats.activeWhatsAppSessions}\n\n` +
        `🔧 *Endpoints:*\n` +
        `• Total: ${stats.totalEndpoints}\n` +
        `• Healthy: ${stats.healthyEndpoints}\n` +
        `• Unhealthy: ${stats.totalEndpoints - stats.healthyEndpoints}\n\n` +
        `📋 *Sponsors:*\n` +
        `• Approved: ${groups.length}\n` +
        `• Pending: ${pendingGroups.length}\n` +
        `${groupsText || '\n• No sponsors configured'}\n\n` +
        `⏳ *Pending Sponsors:*${pendingText || '\n• No pending sponsors'}\n\n` +
        `🖥️ *System:*\n` +
        `• Server: ${stats.domain}\n` +
        `• Boot Count: ${stats.startupCount}\n` +
        `• Last Backup: ${stats.lastBackup ? new Date(stats.lastBackup).toLocaleString() : 'Never'}`,
        { parse_mode: 'Markdown' }
    );
}

async function triggerBackup(ctx) {
    await ctx.reply('🔄 Starting manual backup...');
    const result = await backupDatabaseToDropbox();
    
    if (result.success) {
        await ctx.reply('✅ Backup completed successfully!');
    } else {
        await ctx.reply(`❌ Backup failed: ${result.error}`);
    }
}

// ==================== AUTO-PING SYSTEM FOR RENDER ====================
function startAutoPing() {
    if (!IS_RENDER) {
        console.log('🚫 Auto-ping disabled (not on Render)');
        return;
    }

    const pingInterval = 14 * 60 * 1000;
    
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
        console.log('🚀 Starting BIG DADDY V3 Telegram Bot...');
        console.log(`🌐 Domain: ${SHORT_DOMAIN}`);
        console.log(`🔗 URL: ${config.webBaseUrl}`);
        console.log(`🤖 Bot Token: ${config.telegramBotToken ? '✅ Configured' : '❌ Missing'}`);
        console.log(`📦 Dropbox: ${DROPBOX_REFRESH_TOKEN ? '✅ Configured' : '❌ Missing'}`);
        console.log(`👑 Admin: ${ADMIN_CHAT_ID} (${ADMIN_USERNAME})`);
        
        initDatabase();
        initEndpointTracking();
        
        console.log('🔄 Checking for Dropbox backup...');
        await restoreDatabaseFromDropbox();
        
        const server = app.listen(config.webPort, '0.0.0.0', () => {
            console.log(`✅ Web server running on port ${config.webPort}`);
            console.log(`📊 Dashboard: ${config.webBaseUrl}`);
            console.log(`👑 Admin Panel: ${config.webBaseUrl}/webapp/${ADMIN_CHAT_ID}`);
            console.log(`📝 Registration: ${config.webBaseUrl}/register/{userId}`);
            console.log(`⏳ Loading: ${config.webBaseUrl}/loading/{userId}`);
            console.log(`🏥 Health: ${config.webBaseUrl}/health`);
            console.log(`connecting to bigdaddy database`);
            console.log(`database connected bigdaddyv3`);
        });

        startAutoPing();
        startAutoBackup();
        startMemoryCleanup();
        initDatabase();
        initEndpointTracking();
        startMembershipMonitoring();
        startSessionMonitoring();
        startHealthCheckMonitoring();

        const telegramBot = await initializeTelegramBot();
        
        if (telegramBot) {
            await telegramBot.launch();
            console.log('✅ Telegram bot started successfully');
            
            try {
                await telegramBot.telegram.sendMessage(
                    ADMIN_CHAT_ID,
                    `🤖 *Bot Started Successfully*\n\n` +
                    `🕒 Time: ${new Date().toLocaleString()}\n` +
                    `🌐 Server: ${SHORT_DOMAIN}\n` +
                    `🔗 URL: ${config.webBaseUrl}\n` +
                    `👑 Admin Panel: ${config.webBaseUrl}/webapp/${ADMIN_CHAT_ID}\n` +
                    `📝 Registration: ${config.webBaseUrl}/register/{userId}\n` +
                    `⏳ Loading: ${config.webBaseUrl}/loading/{userId}\n\n` +
                    `*System Features:*\n` +
                    `• ✅ Smart endpoint load balancing\n` +
                    `• ✅ Endpoint health monitoring\n` +
                    `• ✅ Automatic failover to healthy endpoints\n` +
                    `• ✅ Admin notifications for down endpoints\n` +
                    `• ✅ WhatsApp session monitoring\n` +
                    `• ✅ LocalStorage user accounts\n` +
                    `• ✅ Dropbox backup system\n\n` +
                    `The system is now fully operational with enhanced reliability!`,
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                console.log('⚠️ Could not send startup notification to admin');
            }
        } else {
            console.log('ℹ️  Running in web-only mode (no Telegram bot)');
        }
        
        process.once('SIGINT', () => gracefulShutdown(telegramBot, server));
        process.once('SIGTERM', () => gracefulShutdown(telegramBot, server));
        
    } catch (error) {
        console.error('❌ Failed to start servers:', error);
        process.exit(1);
    }
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
console.log(`connecting to bigdaddy database`);
console.log(`database connected bigdaddyv3`);
startServers();

module.exports = {
    readDatabase,
    isAdmin,
    getStatistics,
    backupDatabaseToDropbox,
    updateWhatsAppSessions,
    getAllWhatsAppSessions,
    healthCheckAllEndpoints,
    getBalancedEndpoint
};
