const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Dropbox } = require('dropbox');
const NodeCache = require('node-cache');
const Redis = require('ioredis');

// ==================== PERFORMANCE CONFIGURATION ====================
const IS_RENDER = process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_URL !== undefined;
const PORT = process.env.PORT || 3000;
const RENDER_DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// Performance settings
const ENABLE_REDIS = process.env.ENABLE_REDIS !== 'false';

// Admin configuration
const ADMIN_CHAT_ID = '6300694007';
const ADMIN_USERNAME = 'admin';

// Auto-detect domain name
function getShortDomainName() {
    if (!RENDER_DOMAIN) return 'local';
    
    let domain = RENDER_DOMAIN.replace(/^https?:\/\//, '');
    domain = domain.replace(/\.render\.com$/, '');
    domain = domain.replace(/\.onrender\.com$/, '');
    domain = domain.split('.')[0];
    
    return domain || 'local';
}

const SHORT_DOMAIN = getShortDomainName();

// ==================== REDIS CACHE SETUP ====================
let redisClient = null;
let useRedis = false;

async function initializeRedis() {
    if (!ENABLE_REDIS) {
        console.log('🚫 Redis disabled by configuration');
        return null;
    }

    try {
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
        redisClient = new Redis(redisUrl, {
            retryDelayOnFailover: 100,
            maxRetriesPerRequest: 3,
            lazyConnect: true,
            commandTimeout: 5000,
            disconnectTimeout: 2000
        });

        await redisClient.ping();
        console.log('✅ Redis connected successfully');
        useRedis = true;
        return redisClient;
    } catch (error) {
        console.log('❌ Redis connection failed, using memory cache:', error.message);
        useRedis = false;
        return null;
    }
}

// Cache functions with fallback to memory
const memoryCache = new NodeCache({ 
    stdTTL: 300, // 5 minutes
    checkperiod: 60,
    maxKeys: 10000
});

async function cacheGet(key) {
    if (useRedis && redisClient) {
        try {
            const data = await redisClient.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error('Redis get error:', error);
            return memoryCache.get(key);
        }
    }
    return memoryCache.get(key);
}

async function cacheSet(key, value, ttl = 300) {
    if (useRedis && redisClient) {
        try {
            await redisClient.setex(key, ttl, JSON.stringify(value));
        } catch (error) {
            console.error('Redis set error:', error);
            memoryCache.set(key, value, ttl);
        }
    } else {
        memoryCache.set(key, value, ttl);
    }
}

async function cacheDel(key) {
    if (useRedis && redisClient) {
        try {
            await redisClient.del(key);
        } catch (error) {
            console.error('Redis del error:', error);
            memoryCache.del(key);
        }
    } else {
        memoryCache.del(key);
    }
}

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
    
    // Performance optimizations
    maxMemoryMB: 512,
    backupInterval: 30 * 60 * 1000, // 30 minutes
    cleanupInterval: 10 * 60 * 1000, // 10 minutes
    cacheTTL: 300, // 5 minutes
    batchSize: 50,
    rateLimitDelay: 500,
    
    // Database optimizations
    writeBatchSize: 100,
    writeBatchDelay: 1000
};

// ==================== OPTIMIZED DROPBOX INTEGRATION ====================
let dbx = null;
let isDropboxInitialized = false;

async function getDropboxAccessToken() {
    const cacheKey = 'dropbox_access_token';
    const cachedToken = await cacheGet(cacheKey);
    if (cachedToken) return cachedToken;

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
                timeout: 10000
            }
        );

        if (!response.data.access_token) {
            throw new Error('No access token in response');
        }

        console.log('✅ Dropbox access token obtained successfully');
        await cacheSet(cacheKey, response.data.access_token, 3500); // Cache for almost 1 hour
        return response.data.access_token;
        
    } catch (error) {
        console.error('❌ Failed to get Dropbox access token:', error.message);
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
            await cacheDel('dropbox_access_token');
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
        
        // Update database with backup info
        const db = await readDatabase();
        db.backups = db.backups || [];
        db.backups.push({
            type: 'auto_backup',
            timestamp: new Date().toISOString(),
            success: true
        });
        
        if (db.backups.length > 50) {
            db.backups = db.backups.slice(-50);
        }
        
        await writeDatabase(db);
        
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
            
            const db = await readDatabase();
            db.backups = db.backups || [];
            db.backups.push({
                type: 'restore',
                timestamp: new Date().toISOString(),
                success: true
            });
            await writeDatabase(db);
            
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

// ==================== OPTIMIZED DATABASE SYSTEM ====================
const DB_PATH = path.join(__dirname, 'database.json');
let dbWriteQueue = [];
let dbWriteInProgress = false;
let lastDbRead = null;
let dbCache = null;

// Batch writing for performance
async function processWriteQueue() {
    if (dbWriteInProgress || dbWriteQueue.length === 0) return;
    
    dbWriteInProgress = true;
    
    try {
        // Get current database state
        const currentDb = await readDatabase();
        
        // Apply all queued operations
        while (dbWriteQueue.length > 0) {
            const operation = dbWriteQueue.shift();
            try {
                await operation(currentDb);
            } catch (error) {
                console.error('Database operation error:', error);
            }
        }
        
        // Write to file
        await writeDatabaseDirect(currentDb);
        console.log(`💾 Batch write completed: ${dbWriteQueue.length} operations`);
        
    } catch (error) {
        console.error('Batch write error:', error);
    } finally {
        dbWriteInProgress = false;
        
        // Process next batch if any
        if (dbWriteQueue.length > 0) {
            setTimeout(processWriteQueue, config.writeBatchDelay);
        }
    }
}

function queueDbOperation(operation) {
    dbWriteQueue.push(operation);
    
    if (dbWriteQueue.length >= config.writeBatchSize) {
        processWriteQueue();
    } else if (!dbWriteInProgress) {
        setTimeout(processWriteQueue, config.writeBatchDelay);
    }
}

async function initDatabase() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const initialData = {
                users: {},
                settings: {
                    welcomeMessage: "👋 *Welcome to BIG DADDY V3 Bot!*\n\nI see you're new here! To get started, I need a few details from you:\n\n1. 👤 Your Full Name\n2. 📧 Your Email Address\n\nLet's create your account:",
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
                pendingGroups: [],
                membershipChecks: {},
                version: '4.0'
            };
            await writeDatabaseDirect(initialData);
            console.log('✅ Database initialized');
        } else {
            const db = await readDatabase();
            if (!db.settings) db.settings = {};
            if (!db.settings.webWelcomeMessage) db.settings.webWelcomeMessage = "🎉 Welcome to your dashboard!";
            if (!db.settings.welcomeMessage) db.settings.welcomeMessage = "👋 *Welcome to BIG DADDY V3 Bot!*\n\nI see you're new here! To get started, I need a few details from you:\n\n1. 👤 Your Full Name\n2. 📧 Your Email Address\n\nLet's create your account:";
            if (!db.settings.adminWelcomeMessage) db.settings.adminWelcomeMessage = "👑 *Welcome to Admin Panel*\n\nManage your bot users and monitor statistics.";
            if (!db.groups) db.groups = [];
            if (!db.pendingGroups) db.pendingGroups = [];
            if (!db.membershipChecks) db.membershipChecks = {};
            await writeDatabase(db);
        }
        
        const db = await readDatabase();
        db.statistics.startupCount = (db.statistics.startupCount || 0) + 1;
        db.statistics.lastStartup = new Date().toISOString();
        db.statistics.domain = SHORT_DOMAIN;
        
        const today = new Date().toISOString().split('T')[0];
        if (db.statistics.lastReset !== today) {
            db.statistics.usersToday = 0;
            db.statistics.lastReset = today;
        }
        
        await writeDatabase(db);
        
        console.log(`🚀 BIG DADDY V4 - Optimized for high performance`);
        
    } catch (error) {
        console.error('❌ Error initializing database:', error);
    }
}

async function readDatabase() {
    // Use memory cache for frequent reads
    if (dbCache && lastDbRead && (Date.now() - lastDbRead < 5000)) {
        return dbCache;
    }

    try {
        const cacheKey = 'database_full';
        const cached = await cacheGet(cacheKey);
        if (cached) {
            dbCache = cached;
            lastDbRead = Date.now();
            return cached;
        }

        const data = fs.readFileSync(DB_PATH, 'utf8');
        const parsed = JSON.parse(data);
        
        // Cache the database
        await cacheSet(cacheKey, parsed, 10); // Cache for 10 seconds
        dbCache = parsed;
        lastDbRead = Date.now();
        
        return parsed;
    } catch (error) {
        console.error('❌ Error reading database:', error);
        return { users: {}, settings: {}, statistics: {}, backups: [], groups: [], pendingGroups: [], membershipChecks: {} };
    }
}

async function writeDatabaseDirect(data) {
    try {
        data.statistics = data.statistics || {};
        data.statistics.totalUsers = Object.keys(data.users || {}).length;
        data.statistics.lastUpdate = new Date().toISOString();
        data.statistics.domain = SHORT_DOMAIN;
        
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        
        // Update cache
        dbCache = data;
        lastDbRead = Date.now();
        await cacheSet('database_full', data, 10);
        
        return true;
    } catch (error) {
        console.error('❌ Error writing database:', error);
        return false;
    }
}

async function writeDatabase(data) {
    return new Promise((resolve) => {
        queueDbOperation(async (currentDb) => {
            Object.assign(currentDb, data);
            await writeDatabaseDirect(currentDb);
            resolve(true);
        });
    });
}

// ==================== OPTIMIZED USER MANAGEMENT ====================
async function getUser(userId) {
    const cacheKey = `user_${userId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const db = await readDatabase();
    const user = db.users[userId] || null;
    
    if (user) {
        await cacheSet(cacheKey, user, config.cacheTTL);
    }
    
    return user;
}

async function createOrUpdateUser(userId, userData) {
    return new Promise((resolve) => {
        queueDbOperation(async (db) => {
            const isNewUser = !db.users[userId];
            
            if (!db.users[userId]) {
                db.users[userId] = {
                    id: userId,
                    firstName: '',
                    lastName: '',
                    email: '',
                    createdAt: new Date().toISOString(),
                    ...userData
                };
                
                const today = new Date().toISOString().split('T')[0];
                if (db.statistics.lastReset !== today) {
                    db.statistics.usersToday = 0;
                    db.statistics.lastReset = today;
                }
                db.statistics.usersToday = (db.statistics.usersToday || 0) + 1;
            } else {
                db.users[userId] = { ...db.users[userId], ...userData };
            }
            
            db.backups = db.backups || [];
            db.backups.push({
                type: 'user_update',
                userId: userId,
                timestamp: new Date().toISOString(),
                isNewUser: isNewUser
            });
            
            if (db.backups.length > 100) {
                db.backups = db.backups.slice(-100);
            }

            // Update cache
            await cacheSet(`user_${userId}`, db.users[userId], config.cacheTTL);
            await cacheDel('database_full'); // Invalidate full cache
            
            resolve(true);
        });
    });
}

async function setUserProfile(userId, firstName, lastName, email) {
    return createOrUpdateUser(userId, { 
        firstName: firstName,
        lastName: lastName,
        email: email,
        profileCompleted: true,
        lastUpdated: new Date().toISOString()
    });
}

async function deleteUser(userId) {
    return new Promise((resolve) => {
        queueDbOperation(async (db) => {
            if (db.users[userId]) {
                const userData = db.users[userId];
                delete db.users[userId];
                
                db.backups = db.backups || [];
                db.backups.push({
                    type: 'user_deleted',
                    userId: userId,
                    userData: userData,
                    timestamp: new Date().toISOString(),
                    deletedBy: 'admin'
                });

                // Clear cache
                await cacheDel(`user_${userId}`);
                await cacheDel('database_full');
                
                resolve(true);
            }
            resolve(false);
        });
    });
}

function isAdmin(userId) {
    return userId.toString() === ADMIN_CHAT_ID.toString();
}

async function getStatistics() {
    const cacheKey = 'statistics';
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const db = await readDatabase();
    const users = Object.values(db.users);
    
    const today = new Date().toISOString().split('T')[0];
    const usersCreatedToday = users.filter(user => 
        user.createdAt && user.createdAt.startsWith(today)
    ).length;
    
    const stats = {
        totalUsers: users.length,
        usersToday: usersCreatedToday,
        usersWithProfile: users.filter(user => user.profileCompleted).length,
        usersWithoutProfile: users.filter(user => !user.profileCompleted).length,
        lastBackup: db.statistics.lastBackup,
        startupCount: db.statistics.startupCount,
        domain: SHORT_DOMAIN
    };

    await cacheSet(cacheKey, stats, 60); // Cache for 1 minute
    return stats;
}

// ==================== OPTIMIZED GROUP MANAGEMENT ====================
async function addPendingGroup(groupData) {
    return new Promise((resolve) => {
        queueDbOperation(async (db) => {
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
                
                await cacheDel('pending_groups');
                resolve(true);
            }
            resolve(false);
        });
    });
}

async function approveGroup(groupId) {
    return new Promise((resolve) => {
        queueDbOperation(async (db) => {
            if (!db.pendingGroups) {
                resolve(false);
                return;
            }
            
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
                    approvedBy: ADMIN_CHAT_ID,
                    lastVerified: new Date().toISOString()
                };
                
                db.groups.push(enhancedGroupData);
                
                // Clear relevant caches
                await cacheDel('pending_groups');
                await cacheDel('groups_list');
                await cacheDel('database_full');
                
                resolve(true);
            }
            resolve(false);
        });
    });
}

function rejectGroup(groupId) {
    return new Promise((resolve) => {
        queueDbOperation(async (db) => {
            if (!db.pendingGroups) {
                resolve(false);
                return;
            }
            
            const initialLength = db.pendingGroups.length;
            db.pendingGroups = db.pendingGroups.filter(g => g.id !== groupId);
            
            if (db.pendingGroups.length !== initialLength) {
                await cacheDel('pending_groups');
                resolve(true);
            }
            resolve(false);
        });
    });
}

async function getPendingGroups() {
    const cacheKey = 'pending_groups';
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const db = await readDatabase();
    const pendingGroups = db.pendingGroups || [];
    
    await cacheSet(cacheKey, pendingGroups, 300);
    return pendingGroups;
}

async function addGroupWithInvite(groupData) {
    return new Promise((resolve) => {
        queueDbOperation(async (db) => {
            if (!db.groups) db.groups = [];
            
            const existingGroup = db.groups.find(g => g.id === groupData.id);
            if (existingGroup) {
                resolve(false);
                return;
            }

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
                approvedBy: ADMIN_CHAT_ID,
                lastVerified: new Date().toISOString()
            };
            
            db.groups.push(enhancedGroupData);
            
            await cacheDel('groups_list');
            await cacheDel('database_full');
            
            resolve(true);
        });
    });
}

function addGroup(groupData) {
    return new Promise((resolve) => {
        queueDbOperation(async (db) => {
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
                
                await cacheDel('groups_list');
                await cacheDel('database_full');
                
                resolve(true);
            }
            resolve(false);
        });
    });
}

function removeGroup(groupId) {
    return new Promise((resolve) => {
        queueDbOperation(async (db) => {
            if (!db.groups) {
                resolve(false);
                return;
            }
            
            const initialLength = db.groups.length;
            db.groups = db.groups.filter(g => g.id !== groupId);
            
            if (db.groups.length !== initialLength) {
                await cacheDel('groups_list');
                await cacheDel('database_full');
                resolve(true);
            }
            resolve(false);
        });
    });
}

async function getGroups() {
    const cacheKey = 'groups_list';
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const db = await readDatabase();
    const groups = db.groups || [];
    
    await cacheSet(cacheKey, groups, 300);
    return groups;
}

// ==================== OPTIMIZED MEMBERSHIP VERIFICATION ====================
let bot = null;

async function updateUserMembership(userId, isMember) {
    const cacheKey = `membership_${userId}`;
    await cacheSet(cacheKey, { isMember, lastChecked: new Date().toISOString() }, 300); // 5 minutes

    return new Promise((resolve) => {
        queueDbOperation(async (db) => {
            if (!db.membershipChecks) db.membershipChecks = {};
            
            db.membershipChecks[userId] = {
                isMember: isMember,
                lastChecked: new Date().toISOString()
            };
            
            if (db.users[userId]) {
                db.users[userId].hasAccess = isMember;
                db.users[userId].lastMembershipCheck = new Date().toISOString();
            }
            
            resolve(true);
        });
    });
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

// Optimized membership checking with caching and batching
async function checkUserMembership(userId) {
    const cacheKey = `membership_result_${userId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
        return cached;
    }

    try {
        const groups = await getGroups();
        
        if (groups.length === 0) {
            const result = { hasAccess: true, notJoinedGroups: [] };
            await cacheSet(cacheKey, result, 60); // Cache for 1 minute
            await updateUserMembership(userId, true);
            return result;
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
                
                const chatMember = await bot.telegram.getChatMember(group.id, userId);
                const validStatuses = ['creator', 'administrator', 'member'];
                
                if (group.type !== 'channel') {
                    validStatuses.push('restricted');
                }
                
                const isMember = validStatuses.includes(chatMember.status);
                
                if (!isMember) {
                    allGroupsJoined = false;
                    notJoinedGroups.push(group);
                }
                
            } catch (error) {
                console.error(`❌ Error checking ${group.title}:`, error.message);
                allGroupsJoined = false;
                notJoinedGroups.push(group);
            }
            
            // Rate limiting between checks
            await new Promise(resolve => setTimeout(resolve, config.rateLimitDelay));
        }
        
        const result = {
            hasAccess: allGroupsJoined,
            notJoinedGroups: notJoinedGroups
        };
        
        // Cache the result
        await cacheSet(cacheKey, result, 300); // Cache for 5 minutes
        await updateUserMembership(userId, allGroupsJoined);
        
        return result;
        
    } catch (error) {
        console.error('❌ Error in checkUserMembership:', error);
        const result = { hasAccess: false, notJoinedGroups: await getGroups() };
        await cacheSet(cacheKey, result, 60); // Cache error result for 1 minute
        await updateUserMembership(userId, false);
        return result;
    }
}

// Optimized bot status checking
async function checkBotAdminStatus() {
    const cacheKey = 'bot_admin_status';
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const groups = await getGroups();
    const report = [];
    
    for (const group of groups) {
        try {
            const botInfo = await bot.telegram.getMe();
            const chatMember = await bot.telegram.getChatMember(group.id, botInfo.id);
            
            report.push({
                title: group.title,
                type: group.type,
                status: chatMember.status,
                isAdmin: ['creator', 'administrator'].includes(chatMember.status),
                canCheckMembers: ['creator', 'administrator'].includes(chatMember.status)
            });
            
        } catch (error) {
            report.push({
                title: group.title,
                type: group.type,
                status: 'ERROR',
                isAdmin: false,
                canCheckMembers: false,
                error: error.message
            });
        }
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    await cacheSet(cacheKey, report, 300); // Cache for 5 minutes
    return report;
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

// ==================== OPTIMIZED MEMBERSHIP MONITORING ====================
async function monitorMemberships() {
    try {
        console.log('🔍 Starting optimized membership monitoring...');
        const db = await readDatabase();
        const users = Object.keys(db.users || {});
        const groups = await getGroups();
        
        if (groups.length === 0 || !bot) return;
        
        let checked = 0;
        let restricted = 0;
        
        // Process users in batches
        for (let i = 0; i < users.length; i += config.batchSize) {
            const batch = users.slice(i, i + config.batchSize);
            const batchPromises = batch.map(async (userId) => {
                if (userId === ADMIN_CHAT_ID) return;
                
                const membershipCheck = await checkUserMembership(userId);
                if (!membershipCheck.hasAccess) {
                    restricted++;
                }
                checked++;
            });
            
            await Promise.allSettled(batchPromises);
            
            // Progress reporting
            if (checked % 100 === 0) {
                console.log(`📊 Membership check progress: ${checked}/${users.length}`);
            }
            
            // Rate limiting between batches
            if (i + config.batchSize < users.length) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        console.log(`✅ Membership check completed: ${checked} users checked, ${restricted} restricted`);
        
    } catch (error) {
        console.error('Error in membership monitoring:', error);
    }
}

function startMembershipMonitoring() {
    // Initial delay to let system stabilize
    setTimeout(() => {
        monitorMemberships();
        // Run every 15 minutes instead of 5
        setInterval(monitorMemberships, 15 * 60 * 1000);
    }, 2 * 60 * 1000);
    
    console.log('🔍 Optimized membership monitoring started (every 15 minutes)');
}

// ==================== OPTIMIZED MEMORY MANAGEMENT ====================
function startMemoryCleanup() {
    setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
        
        if (heapUsedMB > config.maxMemoryMB * 0.7) {
            console.log('⚠️ High memory usage detected, running cleanup...');
            performMemoryCleanup();
        }
        
        // Clean old cache entries
        if (memoryCache.keys().length > 5000) {
            const keys = memoryCache.keys();
            const toDelete = keys.slice(0, 1000);
            toDelete.forEach(key => memoryCache.del(key));
            console.log(`🗑️ Cleaned ${toDelete.length} cache entries`);
        }
        
    }, config.cleanupInterval);
}

function performMemoryCleanup() {
    try {
        // Clear memory cache but keep recent entries
        const keys = memoryCache.keys();
        if (keys.length > 2000) {
            const toKeep = keys.slice(-1000);
            const newCache = new NodeCache({ stdTTL: 300 });
            
            toKeep.forEach(key => {
                const value = memoryCache.get(key);
                if (value) newCache.set(key, value);
            });
            
            memoryCache = newCache;
        }
        
        if (global.gc) {
            global.gc();
        }
        
        console.log('✅ Memory cleanup completed');
        
    } catch (error) {
        console.error('Memory cleanup error:', error);
    }
}

// ==================== OPTIMIZED AUTO-BACKUP SYSTEM ====================
function startAutoBackup() {
    console.log(`🔄 Starting optimized backups every ${config.backupInterval / 60000} minutes`);
    
    // Initial backup after system stabilizes
    setTimeout(async () => {
        console.log('🔄 Running initial automatic backup...');
        await backupDatabaseToDropbox().catch(console.error);
    }, 5 * 60 * 1000);

    setInterval(async () => {
        console.log('🔄 Running scheduled automatic backup...');
        const result = await backupDatabaseToDropbox().catch(console.error);
        
        if (result && result.success) {
            const db = await readDatabase();
            db.statistics.lastBackup = new Date().toISOString();
            await writeDatabase(db);
        }
    }, config.backupInterval);

    process.on('SIGINT', async () => {
        console.log('🚨 Process exiting, performing final backup...');
        await processWriteQueue(); // Process any pending writes
        await backupDatabaseToDropbox().catch(console.error);
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('🚨 Process terminating, performing final backup...');
        await processWriteQueue(); // Process any pending writes
        await backupDatabaseToDropbox().catch(console.error);
        process.exit(0);
    });
}

// ==================== EXPRESS WEB SERVER WITH OPTIMIZATIONS ====================
const app = express();

// Optimized middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static('public', {
    maxAge: '1h',
    etag: false
}));

// Compression middleware
app.use(require('compression')());

// Rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// ==================== WEB ROUTES (ALL ORIGINAL FUNCTIONALITY PRESERVED) ====================

// Registration Form Route with caching
app.get('/register/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const cacheKey = `register_form_${userId}`;
        const cached = await cacheGet(cacheKey);
        
        if (cached) {
            res.send(cached);
            return;
        }

        const user = await getUser(userId);
        const formHtml = generateRegistrationForm(userId, user);
        
        await cacheSet(cacheKey, formHtml, 300);
        res.send(formHtml);
        
    } catch (error) {
        console.error('Registration form error:', error);
        res.status(500).send('Internal server error');
    }
});

// Handle Registration Form Submission
app.post('/register/:userId', express.json(), async (req, res) => {
    try {
        const userId = req.params.userId;
        const { firstName, lastName, email } = req.body;
        
        if (!firstName || !lastName || !email) {
            return res.json({ success: false, error: 'All fields are required' });
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.json({ success: false, error: 'Please enter a valid email address' });
        }
        
        const success = await setUserProfile(userId, firstName, lastName, email);
        
        if (success) {
            console.log(`✅ User registered via web: ${userId}`);
            
            await cacheDel(`user_${userId}`);
            await cacheDel('statistics');
            await cacheDel('database_full');
            
            if (bot) {
                const stats = await getStatistics();
                bot.telegram.sendMessage(
                    ADMIN_CHAT_ID,
                    `👤 *New Web Registration*\n\n📛 Name: ${firstName} ${lastName}\n📧 Email: ${email}\n🆔 User ID: ${userId}\n\n📊 Total Users: ${stats.totalUsers}\n📈 Today: ${stats.usersToday}`,
                    { parse_mode: 'Markdown' }
                ).catch(console.error);
            }
            
            res.json({ 
                success: true, 
                message: 'Account created successfully!',
                redirectUrl: `/webapp/${userId}`
            });
        } else {
            res.json({ success: false, error: 'Failed to create account' });
        }
        
    } catch (error) {
        console.error('Registration submission error:', error);
        res.json({ success: false, error: 'Internal server error' });
    }
});

// Web App Dashboard Route with caching
app.get('/webapp/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const cacheKey = `webapp_${userId}`;
        const cached = await cacheGet(cacheKey);
        
        if (cached) {
            res.send(cached);
            return;
        }

        const user = await getUser(userId);
        let dashboardHtml = '';
        
        if (userId === ADMIN_CHAT_ID) {
            dashboardHtml = await generateAdminDashboard();
        } else if (!checkUserAccess(userId)) {
            dashboardHtml = generateAccessDeniedPage(userId);
        } else if (!user || !user.profileCompleted) {
            dashboardHtml = generateSetupRequiredPage();
        } else {
            dashboardHtml = generateUserDashboard(user);
        }

        await cacheSet(cacheKey, dashboardHtml, 60);
        res.send(dashboardHtml);
        
    } catch (error) {
        console.error('Web App error:', error);
        res.status(500).send('Internal server error');
    }
});

// Health check endpoint
app.get('/health', async (req, res) => {
    const db = await readDatabase();
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        statistics: db.statistics,
        domain: SHORT_DOMAIN,
        dropboxEnabled: true,
        telegramBot: true,
        cache: {
            redis: useRedis,
            memory: memoryCache.getStats()
        }
    });
});

// Admin API endpoints
app.delete('/admin/delete-user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const success = await deleteUser(userId);
        
        if (success) {
            res.json({ success: true, message: 'User deleted successfully' });
        } else {
            res.status(404).json({ success: false, error: 'User not found' });
        }
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/admin/remove-group/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const success = await removeGroup(groupId);
        
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

app.delete('/admin/reject-group/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const success = await rejectGroup(groupId);
        
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

app.get('/admin/statistics', async (req, res) => {
    try {
        const stats = await getStatistics();
        res.json({ success: true, statistics: stats });
    } catch (error) {
        console.error('Statistics error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/admin/groups', async (req, res) => {
    try {
        const groups = await getGroups();
        const pendingGroups = await getPendingGroups();
        res.json({ success: true, groups: groups, pendingGroups: pendingGroups });
    } catch (error) {
        console.error('Get groups error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/backup-status', async (req, res) => {
    try {
        const db = await readDatabase();
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

// Home page with caching
app.get('/', async (req, res) => {
    try {
        const cacheKey = 'home_page';
        const cached = await cacheGet(cacheKey);
        
        if (cached) {
            res.send(cached);
            return;
        }

        const db = await readDatabase();
        const stats = await getStatistics();
        
        const homeHtml = generateHomePage(stats);
        await cacheSet(cacheKey, homeHtml, 300);
        res.send(homeHtml);
        
    } catch (error) {
        console.error('Home page error:', error);
        res.status(500).send('Internal server error');
    }
});

// ==================== HTML GENERATION FUNCTIONS (PRESERVED) ====================

function generateRegistrationForm(userId, existingUser = null) {
    const isEdit = existingUser && existingUser.profileCompleted;
    const firstName = existingUser?.firstName || '';
    const lastName = existingUser?.lastName || '';
    const email = existingUser?.email || '';
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V4 - ${isEdit ? 'Update Profile' : 'Create Account'}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; color: white; }
            .container { max-width: 400px; margin: 0 auto; background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 30px; border-radius: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
            .header { text-align: center; margin-bottom: 30px; }
            .logo { font-size: 24px; font-weight: bold; margin-bottom: 10px; color: #f39c12; }
            .subtitle { opacity: 0.9; margin-bottom: 5px; }
            .user-id { background: rgba(255,255,255,0.2); padding: 5px 10px; border-radius: 10px; font-size: 12px; margin-bottom: 20px; }
            .form-group { margin-bottom: 20px; }
            label { display: block; margin-bottom: 8px; font-weight: bold; }
            input { width: 100%; padding: 12px 15px; border: none; border-radius: 10px; background: rgba(255,255,255,0.9); font-size: 16px; color: #333; }
            input:focus { outline: none; background: white; box-shadow: 0 0 0 2px #f39c12; }
            .btn { width: 100%; padding: 15px; border: none; border-radius: 10px; background: #4CAF50; color: white; font-size: 16px; font-weight: bold; cursor: pointer; transition: background 0.3s; margin-bottom: 15px; }
            .btn:hover { background: #45a049; }
            .btn-secondary { background: #3498db; }
            .btn-secondary:hover { background: #2980b9; }
            .message { padding: 10px; border-radius: 10px; margin-bottom: 15px; text-align: center; display: none; }
            .success { background: rgba(76, 175, 80, 0.3); border: 1px solid #4CAF50; }
            .error { background: rgba(231, 76, 60, 0.3); border: 1px solid #e74c3c; }
            .loading { display: none; text-align: center; margin-bottom: 15px; }
            .spinner { border: 3px solid rgba(255,255,255,0.3); border-radius: 50%; border-top: 3px solid white; width: 20px; height: 20px; animation: spin 1s linear infinite; margin: 0 auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="logo">🚀 BIG DADDY V4</div>
                <div class="subtitle">${isEdit ? 'Update Your Profile' : 'Create Your Account'}</div>
                <div class="user-id">User ID: ${userId}</div>
            </div>
            
            <div id="message" class="message"></div>
            <div id="loading" class="loading">
                <div class="spinner"></div>
                <div>Processing...</div>
            </div>
            
            <form id="registrationForm">
                <div class="form-group">
                    <label for="firstName">👤 First Name *</label>
                    <input type="text" id="firstName" name="firstName" value="${firstName}" placeholder="Enter your first name" required>
                </div>
                
                <div class="form-group">
                    <label for="lastName">👤 Last Name *</label>
                    <input type="text" id="lastName" name="lastName" value="${lastName}" placeholder="Enter your last name" required>
                </div>
                
                <div class="form-group">
                    <label for="email">📧 Email Address *</label>
                    <input type="email" id="email" name="email" value="${email}" placeholder="Enter your email address" required>
                </div>
                
                <button type="submit" class="btn">${isEdit ? '💾 Update Profile' : '✅ Create Account'}</button>
            </form>
            
            <button class="btn btn-secondary" onclick="closeWebApp()">❌ Close</button>
        </div>
        
        <script>
            const form = document.getElementById('registrationForm');
            const message = document.getElementById('message');
            const loading = document.getElementById('loading');
            
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const formData = new FormData(form);
                const data = { firstName: formData.get('firstName'), lastName: formData.get('lastName'), email: formData.get('email') };
                
                if (!data.firstName || !data.lastName || !data.email) {
                    showMessage('Please fill in all required fields', 'error'); return;
                }
                
                const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
                if (!emailRegex.test(data.email)) {
                    showMessage('Please enter a valid email address', 'error'); return;
                }
                
                loading.style.display = 'block'; form.style.display = 'none';
                
                try {
                    const response = await fetch('/register/${userId}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
                    const result = await response.json();
                    
                    if (result.success) {
                        showMessage(result.message, 'success');
                        setTimeout(() => {
                            if (window.Telegram && Telegram.WebApp) { Telegram.WebApp.close(); } 
                            else if (result.redirectUrl) { window.location.href = result.redirectUrl; }
                        }, 2000);
                    } else {
                        showMessage(result.error, 'error'); form.style.display = 'block';
                    }
                } catch (error) {
                    showMessage('Network error. Please try again.', 'error'); form.style.display = 'block';
                } finally {
                    loading.style.display = 'none';
                }
            });
            
            function showMessage(text, type) {
                message.textContent = text; message.className = 'message ' + type; message.style.display = 'block';
            }
            
            function closeWebApp() {
                if (window.Telegram && Telegram.WebApp) { Telegram.WebApp.close(); } else { window.close(); }
            }
            
            if (window.Telegram && Telegram.WebApp) { Telegram.WebApp.ready(); Telegram.WebApp.expand(); }
        </script>
    </body>
    </html>`;
}

function generateAccessDeniedPage(userId) {
    const groups = getGroups();
    let groupsList = '';
    groups.forEach(group => { groupsList += `<li>${group.title} (${group.type})</li>`; });
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V4 - Access Denied</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); margin: 0; padding: 20px; min-height: 100vh; color: white; text-align: center; }
            .container { max-width: 500px; margin: 50px auto; background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 30px; border-radius: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
            .logo { font-size: 24px; font-weight: bold; margin-bottom: 20px; }
            .groups-list { text-align: left; background: rgba(255,255,255,0.1); padding: 20px; border-radius: 10px; margin: 20px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="logo">🔒 BIG DADDY V4</div>
            <h2>Access Restricted</h2>
            <p>To access your dashboard, you need to join all our sponsor groups/channels.</p>
            <div class="groups-list">
                <h3>Required Sponsors:</h3>
                <ul>${groupsList || '<li>No sponsors configured</li>'}</ul>
            </div>
            <p>Please join all sponsors above and then return to the Telegram bot to verify your membership.</p>
        </div>
    </body>
    </html>`;
}

async function generateAdminDashboard() {
    const stats = await getStatistics();
    const db = await readDatabase();
    const users = Object.values(db.users);
    const groups = await getGroups();
    const pendingGroups = await getPendingGroups();
    
    const recentUsers = users.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
    
    const pendingGroupsSection = pendingGroups.length > 0 ? `
    <div class="users-list">
        <h3>⏳ Pending Groups/Channels (${pendingGroups.length})</h3>
        ${pendingGroups.map(group => `
            <div class="user-item">
                <div class="user-info">
                    <strong>${group.title}</strong>
                    <br>
                    <small>ID: ${group.id} | Type: ${group.type} | Detected: ${new Date(group.detectedAt).toLocaleDateString()}</small>
                </div>
                <div class="user-actions">
                    <button class="btn btn-primary" onclick="approveGroup('${group.id}')">Approve</button>
                    <button class="btn btn-danger" onclick="rejectGroup('${group.id}')">Reject</button>
                </div>
            </div>
        `).join('')}
    </div>` : '';
    
    const groupsSection = `
    <div class="users-list">
        <h3>📋 Approved Sponsors (${groups.length})</h3>
        ${groups.map(group => `
            <div class="user-item">
                <div class="user-info">
                    <strong>${group.title}</strong>
                    <br>
                    <small>ID: ${group.id} | Type: ${group.type} | Added: ${new Date(group.addedAt).toLocaleDateString()}</small>
                    <br>
                    <small>🔗 ${group.inviteLink || 'No link available'}</small>
                </div>
                <div class="user-actions">
                    <button class="btn btn-danger" onclick="removeGroup('${group.id}')">Remove</button>
                </div>
            </div>
        `).join('')}
        ${groups.length === 0 ? '<p>No sponsors configured</p>' : ''}
    </div>`;
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V4 - Admin Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%); margin: 0; padding: 20px; min-height: 100vh; color: white; }
            .container { max-width: 800px; margin: 0 auto; }
            .header { text-align: center; margin-bottom: 30px; }
            .logo { font-size: 28px; font-weight: bold; margin-bottom: 10px; color: #f39c12; }
            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 30px; }
            .stat-card { background: rgba(255,255,255,0.1); padding: 20px; border-radius: 15px; text-align: center; backdrop-filter: blur(10px); }
            .stat-number { font-size: 24px; font-weight: bold; color: #f39c12; }
            .users-list { background: rgba(255,255,255,0.1); border-radius: 15px; padding: 20px; margin-bottom: 20px; backdrop-filter: blur(10px); }
            .user-item { display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.1); }
            .user-info { flex: 1; }
            .user-actions { display: flex; gap: 10px; }
            .btn { padding: 8px 15px; border: none; border-radius: 8px; cursor: pointer; font-size: 12px; }
            .btn-danger { background: #e74c3c; color: white; }
            .btn-primary { background: #3498db; color: white; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="logo">👑 BIG DADDY V4 - ADMIN</div>
                <p>Administrative Control Panel</p>
            </div>
            
            <div class="stats-grid">
                <div class="stat-card"><div class="stat-number">${stats.totalUsers}</div><div>Total Users</div></div>
                <div class="stat-card"><div class="stat-number">${stats.usersToday}</div><div>Today's Users</div></div>
                <div class="stat-card"><div class="stat-number">${stats.usersWithProfile}</div><div>Completed Profiles</div></div>
                <div class="stat-card"><div class="stat-number">${stats.startupCount}</div><div>System Boots</div></div>
            </div>
            
            ${pendingGroupsSection}
            ${groupsSection}
            
            <div class="users-list">
                <h3>Recent Users (Last 10)</h3>
                ${recentUsers.map(user => `
                    <div class="user-item">
                        <div class="user-info">
                            <strong>${user.firstName || 'Unknown'} ${user.lastName || ''}</strong>
                            <br>
                            <small>ID: ${user.id} | Email: ${user.email || 'Not provided'} | Created: ${new Date(user.createdAt).toLocaleDateString()}</small>
                        </div>
                        <div class="user-actions">
                            <button class="btn btn-primary" onclick="viewUser('${user.id}')">View</button>
                            <button class="btn btn-danger" onclick="deleteUser('${user.id}')">Delete</button>
                        </div>
                    </div>
                `).join('')}
                ${recentUsers.length === 0 ? '<p>No users found</p>' : ''}
            </div>
            
            <div style="text-align: center; margin-top: 20px;">
                <button class="btn btn-primary" onclick="refreshData()">🔄 Refresh Data</button>
                <button class="btn btn-danger" onclick="closeWebApp()">❌ Close</button>
            </div>
        </div>
        
        <script>
            function refreshData() { location.reload(); }
            function closeWebApp() { if (window.Telegram && Telegram.WebApp) { Telegram.WebApp.close(); } else { window.close(); } }
            function viewUser(userId) { alert('View user: ' + userId); }
            
            function deleteUser(userId) {
                if (confirm('Are you sure you want to delete user ' + userId + '?')) {
                    fetch('/admin/delete-user/' + userId, { method: 'DELETE' })
                        .then(response => response.json())
                        .then(data => { if (data.success) { alert('User deleted successfully'); location.reload(); } else { alert('Error: ' + data.error); } });
                }
            }
            
            function removeGroup(groupId) {
                if (confirm('Are you sure you want to remove this sponsor?')) {
                    fetch('/admin/remove-group/' + groupId, { method: 'DELETE' })
                        .then(response => response.json())
                        .then(data => { if (data.success) { alert('Sponsor removed successfully'); location.reload(); } else { alert('Error: ' + data.error); } });
                }
            }
            
            function approveGroup(groupId) {
                if (confirm('Are you sure you want to approve this sponsor?')) {
                    fetch('/admin/approve-group/' + groupId, { method: 'POST' })
                        .then(response => response.json())
                        .then(data => { if (data.success) { alert('Sponsor approved successfully'); location.reload(); } else { alert('Error: ' + data.error); } });
                }
            }
            
            function rejectGroup(groupId) {
                if (confirm('Are you sure you want to reject this sponsor?')) {
                    fetch('/admin/reject-group/' + groupId, { method: 'DELETE' })
                        .then(response => response.json())
                        .then(data => { if (data.success) { alert('Sponsor rejected successfully'); location.reload(); } else { alert('Error: ' + data.error); } });
                }
            }
            
            if (window.Telegram && Telegram.WebApp) { Telegram.WebApp.ready(); Telegram.WebApp.expand(); }
        </script>
    </body>
    </html>`;
}

function generateSetupRequiredPage() {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V4 - Setup Required</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin: 0; padding: 20px; min-height: 100vh; color: white; text-align: center; }
            .container { max-width: 400px; margin: 50px auto; background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 30px; border-radius: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
            .logo { font-size: 24px; font-weight: bold; margin-bottom: 20px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="logo">🚀 BIG DADDY V4</div>
            <h2>Setup Required</h2>
            <p>Please complete your profile setup in the Telegram bot to access your dashboard.</p>
            <p>Go back to the bot and provide your name and email address.</p>
        </div>
    </body>
    </html>`;
}

function generateUserDashboard(user) {
    const welcomeMessage = "🎉 Welcome to your dashboard!";
    const firstName = user.firstName || 'User';
    const lastName = user.lastName || '';
    const email = user.email || 'Not provided';
    const memberSince = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'Recently';
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V4 Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin: 0; padding: 20px; min-height: 100vh; color: white; }
            .container { max-width: 400px; margin: 0 auto; background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 25px; border-radius: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
            .header { text-align: center; margin-bottom: 25px; }
            .logo { font-size: 24px; font-weight: bold; margin-bottom: 10px; }
            .welcome { font-size: 18px; margin-bottom: 20px; text-align: center; }
            .user-card { background: rgba(255,255,255,0.15); padding: 20px; border-radius: 15px; margin-bottom: 20px; }
            .user-info { display: flex; flex-direction: column; gap: 10px; }
            .info-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.1); }
            .info-label { font-weight: bold; min-width: 120px; }
            .info-value { text-align: right; flex: 1; }
            .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 20px 0; }
            .stat-item { background: rgba(255,255,255,0.1); padding: 15px; border-radius: 12px; text-align: center; }
            .actions { display: flex; gap: 10px; justify-content: center; margin-top: 20px; }
            .btn { background: #4CAF50; color: white; border: none; padding: 12px 20px; border-radius: 10px; cursor: pointer; font-size: 14px; flex: 1; }
            .btn-close { background: #e74c3c; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="logo">🚀 BIG DADDY V4</div>
                <div class="welcome">${welcomeMessage}</div>
            </div>
            
            <div class="user-card">
                <div class="user-info">
                    <div class="info-item"><span class="info-label">👤 Name:</span><span class="info-value"><strong>${firstName} ${lastName}</strong></span></div>
                    <div class="info-item"><span class="info-label">📧 Email:</span><span class="info-value">${email}</span></div>
                    <div class="info-item"><span class="info-label">🆔 User ID:</span><span class="info-value">${user.id}</span></div>
                    <div class="info-item"><span class="info-label">📅 Member since:</span><span class="info-value">${memberSince}</span></div>
                </div>
            </div>
            
            <div class="stats">
                <div class="stat-item"><div>🌐 Server</div><div><strong>${SHORT_DOMAIN}</strong></div></div>
                <div class="stat-item"><div>✅ Status</div><div><strong>Active</strong></div></div>
            </div>
            
            <div class="actions">
                <button class="btn" onclick="refreshData()">🔄 Refresh</button>
                <button class="btn btn-close" onclick="closeWebApp()">❌ Close</button>
            </div>
        </div>
        
        <script>
            function refreshData() { location.reload(); }
            function closeWebApp() { if (window.Telegram && Telegram.WebApp) { Telegram.WebApp.close(); } else { window.close(); } }
            if (window.Telegram && Telegram.WebApp) { Telegram.WebApp.ready(); Telegram.WebApp.expand(); }
        </script>
    </body>
    </html>`;
}

function generateHomePage(stats) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V4 Dashboard</title>
        <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; min-height: 100vh; }
            .container { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 40px; border-radius: 15px; display: inline-block; max-width: 600px; }
            .stats { margin: 20px 0; padding: 15px; background: rgba(255,255,255,0.1); border-radius: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }
            .stat-item { padding: 10px; }
            .status-badge { display: inline-block; padding: 5px 10px; border-radius: 15px; background: #4CAF50; color: white; font-size: 12px; margin: 2px; }
            .performance { margin-top: 20px; padding: 15px; background: rgba(255,255,255,0.1); border-radius: 10px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 BIG DADDY V4</h1>
            <p><strong>High-Performance Telegram Bot System</strong></p>
            
            <div class="stats">
                <div class="stat-item"><p><strong>Server:</strong> ${SHORT_DOMAIN}</p></div>
                <div class="stat-item"><p><strong>Status:</strong> <span class="status-badge">✅ Online</span></p></div>
                <div class="stat-item"><p><strong>Total Users:</strong> ${stats.totalUsers}</p></div>
                <div class="stat-item"><p><strong>Today's Users:</strong> ${stats.usersToday}</p></div>
                <div class="stat-item"><p><strong>Dropbox Backup:</strong> <span class="status-badge">✅ Connected</span></p></div>
                <div class="stat-item"><p><strong>Telegram Bot:</strong> <span class="status-badge">✅ Active</span></p></div>
            </div>
            
            <div class="performance">
                <h3>⚡ Performance Features</h3>
                <p>✅ Redis Caching | ✅ Batch Processing | ✅ Rate Limiting</p>
                <p>✅ Memory Optimization | ✅ Database Batching | ✅ Async Operations</p>
            </div>
            
            <div>
                <a href="/backup-status" style="color: white; margin: 10px;">📊 Backup Status</a>
                <a href="/health" style="color: white; margin: 10px;">🏥 Health Check</a>
                <a href="/trigger-backup" style="color: white; margin: 10px;">💾 Backup Now</a>
                <a href="/admin/statistics" style="color: white; margin: 10px;">👑 Admin Stats</a>
            </div>
        </div>
    </body>
    </html>`;
}

// ==================== TELEGRAM BOT SETUP (COMPLETE IMPLEMENTATION) ====================

// Custom session middleware
function ensureSession(ctx, next) {
    if (!ctx.session) {
        ctx.session = {};
    }
    return next();
}

// Auto group detection
async function handleAutoGroupDetection(ctx) {
    try {
        const chat = ctx.chat;
        
        if (chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel')) {
            
            if (ctx.message && ctx.message.new_chat_members) {
                const newMembers = ctx.message.new_chat_members;
                const botInfo = await bot.telegram.getMe();
                
                const botWasAdded = newMembers.some(member => member.id === botInfo.id);
                
                if (botWasAdded) {
                    console.log(`🤖 Bot was added to ${chat.type}: ${chat.title} (ID: ${chat.id})`);
                    
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
                    
                    const success = await addPendingGroup(groupData);
                    
                    if (success) {
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
            
            if (ctx.message && ctx.message.left_chat_member) {
                const leftMember = ctx.message.left_chat_member;
                const botInfo = await bot.telegram.getMe();
                
                if (leftMember.id === botInfo.id) {
                    console.log(`🚫 Bot was removed from ${chat.type}: ${chat.title} (ID: ${chat.id})`);
                    
                    await removeGroup(chat.id.toString());
                    await rejectGroup(chat.id.toString());
                    
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
        
        // Initialize session
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
                await ctx.reply('❌ Access denied. Admin only.');
            }
        });

        bot.command('stats', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await showStatistics(ctx);
            } else {
                await ctx.reply('❌ Access denied. Admin only.');
            }
        });

        bot.command('users', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await listUsers(ctx);
            } else {
                await ctx.reply('❌ Access denied. Admin only.');
            }
        });

        // Check bot admin status
        bot.command('checkbot', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
                return;
            }
            
            await ctx.reply('🔍 Checking bot admin status in all sponsors...');
            const adminReport = await checkBotAdminStatus();
            
            let reportMessage = '👑 *Bot Admin Status Report*\n\n';
            adminReport.forEach(item => {
                if (item.isAdmin) {
                    reportMessage += `✅ *${item.title}* (${item.type})\n`;
                    reportMessage += `   Status: ${item.status}\n`;
                    reportMessage += `   Can Check Members: ${item.canCheckMembers ? '✅ Yes' : '❌ No'}\n\n`;
                } else {
                    reportMessage += `❌ *${item.title}* (${item.type})\n`;
                    reportMessage += `   Status: ${item.status}\n`;
                    reportMessage += `   Error: ${item.error || 'Bot not admin'}\n\n`;
                }
            });
            
            await ctx.reply(reportMessage, { parse_mode: 'Markdown' });
        });

        // Debug channel access
        bot.command('debugchannel', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
                return;
            }

            await ctx.reply('🔧 Starting channel debug...');
            const groups = await getGroups();
            let debugReport = '🔧 *Channel Debug Report*\n\n';
            
            for (const group of groups) {
                try {
                    debugReport += `📋 *${group.title}* (${group.type})\n`;
                    debugReport += `   ID: ${group.id}\n`;
                    
                    try {
                        const chat = await bot.telegram.getChat(group.id);
                        debugReport += `   ✅ Bot Access: Yes (${chat.title})\n`;
                        
                        const botInfo = await bot.telegram.getMe();
                        const botMember = await bot.telegram.getChatMember(group.id, botInfo.id);
                        debugReport += `   🤖 Bot Status: ${botMember.status}\n`;
                        debugReport += `   👑 Is Admin: ${['creator', 'administrator'].includes(botMember.status) ? '✅ Yes' : '❌ No'}\n`;
                        
                    } catch (error) {
                        debugReport += `   ❌ Bot Access: No - ${error.message}\n`;
                    }
                    
                    debugReport += `   🔗 Invite: ${group.inviteLink || 'None'}\n`;
                    debugReport += `   👤 Username: ${group.username || 'None'}\n\n`;
                    
                } catch (error) {
                    debugReport += `   💥 Error: ${error.message}\n\n`;
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            await ctx.reply(debugReport, { parse_mode: 'Markdown' });
        });

        bot.command('pending', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
                return;
            }
            
            const pendingGroups = await getPendingGroups();
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

        // Fixed channel addition command
        bot.command('addchannel', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
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
                
                const channelData = {
                    id: channelId,
                    title: channelName,
                    username: chat.username || null,
                    inviteLink: chat.username ? `https://t.me/${chat.username}` : null,
                    type: 'channel',
                    addedAt: new Date().toISOString(),
                    isActive: true,
                    approvedBy: ADMIN_CHAT_ID,
                    isManual: true,
                    realTitle: chat.title
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
                await ctx.reply('❌ Access denied. Admin only.');
                return;
            }
            
            if (ctx.message.reply_to_message && ctx.message.reply_to_message.chat) {
                const chat = ctx.message.reply_to_message.chat;
                
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
            
            const groups = await getGroups();
            if (groups.length === 0) {
                await ctx.reply('📭 No sponsors configured.');
                return;
            }
            
            const keyboard = groups.map(group => 
                [Markup.button.callback(`${group.title} (${group.type})`, `remove_group_${group.id}`)]
            );
            
            await ctx.reply('🗑️ Select a sponsor to remove:', Markup.inlineKeyboard(keyboard));
        });

        bot.command('listgroups', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
                return;
            }
            
            const groups = await getGroups();
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
            if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup' || ctx.chat.type === 'channel')) {
                await handleAutoGroupDetection(ctx);
            }
        });

        // ==================== BOT ACTIONS ====================

        // Create account process
        bot.action('create_account', async (ctx) => {
            try {
                await ctx.answerCbQuery();
                const userId = ctx.from.id.toString();
                
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

        // Update profile
        bot.action('update_profile', async (ctx) => {
            try {
                await ctx.answerCbQuery();
                const userId = ctx.from.id.toString();
                
                await ctx.reply(
                    '✏️ *Update Profile*\n\n' +
                    'Click the button below to update your profile information:',
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.webApp('📝 Update Profile', `${config.webBaseUrl}/register/${userId}`)]
                        ])
                    }
                );
            } catch (error) {
                console.error('Update profile error:', error);
                await ctx.answerCbQuery('❌ Error opening profile update');
            }
        });

        // Check membership
        bot.action('check_membership', async (ctx) => {
            try {
                await ctx.answerCbQuery('🔄 Checking your membership...');
                const userId = ctx.from.id.toString();
                
                const membershipCheck = await checkUserMembership(userId);
                
                if (membershipCheck.hasAccess) {
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
            const success = await rejectGroup(groupId);
            
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

        bot.action('admin_users', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await ctx.answerCbQuery();
                await listUsers(ctx);
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
            const pendingGroups = await getPendingGroups();
            
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
            const success = await removeGroup(groupId);
            
            if (success) {
                await ctx.editMessageText('✅ Sponsor removed successfully!');
            } else {
                await ctx.editMessageText('❌ Sponsor not found.');
            }
            await ctx.answerCbQuery();
        });

        // Text message handler
        bot.on('text', async (ctx) => {
            try {
                const userId = ctx.from.id.toString();
                const text = ctx.message.text.trim();
                
                if (text.startsWith('/')) return;
                if (ctx.chat.type !== 'private') return;
                
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
    const db = await readDatabase();
    const adminWelcome = db.settings?.adminWelcomeMessage || "👑 *Welcome to Admin Panel*\n\nManage your bot users and monitor statistics.";
    
    await ctx.reply(
        adminWelcome,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('👑 Admin Dashboard', `${config.webBaseUrl}/webapp/${userId}`)],
                [Markup.button.callback('📊 Statistics', 'admin_stats')],
                [Markup.button.callback('👥 User List', 'admin_users')],
                [Markup.button.callback('🤖 Check Bot Status', 'checkbot')],
                [Markup.button.callback('🔧 Debug Channels', 'debugchannel')],
                [Markup.button.callback('💾 Backup Now', 'admin_backup')]
            ])
        }
    );
}

async function handleUserStart(ctx) {
    try {
        const userId = ctx.from.id.toString();
        const user = await getUser(userId);
        const db = await readDatabase();
        
        console.log(`👤 User start: ${userId}, profile completed: ${user?.profileCompleted}`);
        
        if (ctx.session) {
            ctx.session.setupStep = null;
            ctx.session.firstName = null;
            ctx.session.lastName = null;
            ctx.session.email = null;
        }
        
        const welcomeMessage = db.settings?.welcomeMessage || "👋 *Welcome to BIG DADDY V3 Bot!*\n\nI see you're new here! To get started, I need a few details from you:\n\n1. 👤 Your Full Name\n2. 📧 Your Email Address\n\nLet's create your account:";
        
        if (user && user.profileCompleted) {
            console.log(`✅ Existing user with completed profile: ${userId}`);
            const membershipCheck = await checkUserMembership(userId);
            
            if (!membershipCheck.hasAccess) {
                console.log(`🔒 User ${userId} doesn't have access to all sponsors`);
                await showJoinRequiredMessage(ctx, membershipCheck.notJoinedGroups);
                return;
            }
            
            await ctx.reply(
                `🎉 *Welcome back ${user.firstName}!*\n\n` +
                `Your profile is already set up.\n\n` +
                `Access your dashboard below:`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.webApp('🚀 Open Dashboard', `${config.webBaseUrl}/webapp/${userId}`)],
                        [Markup.button.callback('✏️ Update Profile', 'update_profile')]
                    ])
                }
            );
        } else {
            console.log(`🆕 New user or incomplete profile: ${userId}`);
            await ctx.reply(
                welcomeMessage,
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
        } else {
            keyboard.push([Markup.button.callback(`❌ ${group.title} (Contact Admin)`, 'no_link')]);
        }
    });
    
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
    const stats = await getStatistics();
    const pendingGroups = await getPendingGroups();
    
    let pendingText = '';
    if (pendingGroups.length > 0) {
        pendingText = `\n⏳ *Pending Approval:* ${pendingGroups.length}`;
    }
    
    await ctx.reply(
        `👑 *Admin Panel*${pendingText}\n\n` +
        `📊 *Statistics:*\n` +
        `• Total Users: ${stats.totalUsers}\n` +
        `• Today's Users: ${stats.usersToday}\n` +
        `• Completed Profiles: ${stats.usersWithProfile}\n` +
        `• System Boots: ${stats.startupCount}\n\n` +
        `Choose an action:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('📱 Web Dashboard', `${config.webBaseUrl}/webapp/${ctx.from.id}`)],
                [Markup.button.callback('📊 Refresh Stats', 'admin_stats')],
                [Markup.button.callback('👥 Manage Users', 'admin_users')],
                [Markup.button.callback('🤖 Check Bot Status', 'checkbot')],
                [Markup.button.callback('⏳ Pending Groups', 'admin_pending')],
                [Markup.button.callback('💾 Backup Now', 'admin_backup')]
            ])
        }
    );
}

async function showStatistics(ctx) {
    const stats = await getStatistics();
    const db = await readDatabase();
    const groups = await getGroups();
    const pendingGroups = await getPendingGroups();
    
    const users = Object.values(db.users);
    const recentUsers = users.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
    
    let recentUsersText = '';
    recentUsers.forEach((user, index) => {
        recentUsersText += `\n${index + 1}. ${user.firstName || 'Unknown'} ${user.lastName || ''} (${user.id})`;
    });
    
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
        `👥 *Users:*\n` +
        `• Total: ${stats.totalUsers}\n` +
        `• Today: ${stats.usersToday}\n` +
        `• With Profile: ${stats.usersWithProfile}\n` +
        `• Without Profile: ${stats.usersWithoutProfile}\n\n` +
        `📋 *Sponsors:*\n` +
        `• Approved: ${groups.length}\n` +
        `• Pending: ${pendingGroups.length}\n` +
        `${groupsText || '\n• No sponsors configured'}\n\n` +
        `⏳ *Pending Sponsors:*${pendingText || '\n• No pending sponsors'}\n\n` +
        `🖥️ *System:*\n` +
        `• Server: ${stats.domain}\n` +
        `• Boot Count: ${stats.startupCount}\n` +
        `• Last Backup: ${stats.lastBackup ? new Date(stats.lastBackup).toLocaleString() : 'Never'}\n\n` +
        `📈 *Recent Users:*${recentUsersText || '\nNo users yet'}`,
        { parse_mode: 'Markdown' }
    );
}

async function listUsers(ctx) {
    const db = await readDatabase();
    const users = Object.values(db.users);
    
    if (users.length === 0) {
        await ctx.reply('📭 No users found in the database.');
        return;
    }
    
    const userList = users.slice(0, 10).map((user, index) => 
        `${index + 1}. ${user.firstName || 'Unknown'} ${user.lastName || ''}\n   📧 ${user.email || 'No email'}\n   🆔 ${user.id}\n   📅 ${new Date(user.createdAt).toLocaleDateString()}\n`
    ).join('\n');
    
    await ctx.reply(
        `👥 *User List* (${users.length} total)\n\n${userList}\n\n` +
        `Use the web dashboard for full user management.`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('👑 Full Management', `${config.webBaseUrl}/webapp/${ctx.from.id}`)]
            ])
        }
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

// ==================== OPTIMIZED AUTO-PING SYSTEM ====================
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

// ==================== START SERVICES ====================
async function startServers() {
    try {
        console.log('🚀 Starting BIG DADDY V4 - High Performance Edition');
        console.log(`🌐 Domain: ${SHORT_DOMAIN}`);
        console.log(`🔗 URL: ${config.webBaseUrl}`);
        console.log(`⚡ Performance: Redis=${ENABLE_REDIS}`);
        console.log(`🤖 Bot Token: ${config.telegramBotToken ? '✅ Configured' : '❌ Missing'}`);
        console.log(`📦 Dropbox: ${DROPBOX_REFRESH_TOKEN ? '✅ Configured' : '❌ Missing'}`);
        console.log(`👑 Admin: ${ADMIN_CHAT_ID} (${ADMIN_USERNAME})`);
        
        await initializeRedis();
        await initDatabase();
        await restoreDatabaseFromDropbox();
        
        const server = app.listen(config.webPort, '0.0.0.0', () => {
            console.log(`✅ Web server running on port ${config.webPort}`);
            console.log(`📊 Dashboard: ${config.webBaseUrl}`);
            console.log(`👑 Admin Panel: ${config.webBaseUrl}/webapp/${ADMIN_CHAT_ID}`);
        });

        startAutoPing();
        startAutoBackup();
        startMemoryCleanup();
        startMembershipMonitoring();

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

async function gracefulShutdown(telegramBot, server) {
    console.log('🛑 Shutting down gracefully...');
    
    await processWriteQueue();
    await backupDatabaseToDropbox().catch(console.error);
    
    if (telegramBot) {
        await telegramBot.stop();
    }
    
    if (server) {
        server.close(() => {
            console.log('✅ Server shut down successfully');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
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
startServers();

// Export functions for testing
module.exports = {
    readDatabase,
    getUser,
    createOrUpdateUser,
    deleteUser,
    isAdmin,
    getStatistics,
    backupDatabaseToDropbox,
    cacheGet,
    cacheSet,
    cacheDel
};
