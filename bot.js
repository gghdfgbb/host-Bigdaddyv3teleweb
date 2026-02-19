const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
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

const SHORT_DOMAIN = "bigdaddyV3data";

// ==================== MULTI-DATABASE SYSTEM ====================
class MultiDatabase {
    constructor() {
        this.dbPaths = [
            path.join(__dirname, 'database_admin.json'),    // Admin data
            path.join(__dirname, 'database_api.json'),      // API/endpoint data
            path.join(__dirname, 'database_users1.json'),   // User data - 1
            path.join(__dirname, 'database_users2.json'),   // User data - 2
            path.join(__dirname, 'database_users3.json')    // User data - 3
        ];
        this.initAllDatabases();
    }

    initAllDatabases() {
        this.dbPaths.forEach((dbPath, index) => {
            if (!fs.existsSync(dbPath)) {
                let initialData;
                
                if (index === 0) { // Admin database
                    initialData = {
                        settings: {
                            welcomeMessage: "👋 *Welcome to BIG DADDY V3 Bot!*\n\nTo access the bot, you need to join our sponsor channels first.",
                            webWelcomeMessage: "🎉 Welcome to your dashboard!",
                            adminWelcomeMessage: "👑 *Welcome to Admin Panel*"
                        },
                        admin: {
                            chatId: ADMIN_CHAT_ID,
                            username: ADMIN_USERNAME,
                            lastActive: new Date().toISOString()
                        },
                        groups: [],
                        pendingGroups: [],
                        backups: [],
                        version: '4.0'
                    };
                } else if (index === 1) { // API/endpoint database
                    initialData = {
                        endpointUsage: {},
                        endpointHealth: {},
                        whatsappSessions: {},
                        membershipChecks: {},
                        healthStats: {}
                    };
                } else { // User databases
                    initialData = {
                        users: {},
                        statistics: {
                            totalUsers: 0,
                            usersToday: 0,
                            lastReset: new Date().toISOString().split('T')[0],
                            startupCount: 0
                        }
                    };
                }
                
                fs.writeFileSync(dbPath, JSON.stringify(initialData, null, 2));
            }
        });
        console.log('✅ All 5 databases initialized (admin, api, users1-3)');
    }

    // Smart user distribution - Consistent hashing
    getDatabasePath(userId) {
        if (userId === ADMIN_CHAT_ID) {
            return this.dbPaths[0]; // Admin goes to admin DB
        }
        
        // Consistent hashing for users
        const hash = crypto.createHash('md5').update(userId.toString()).digest('hex');
        const dbIndex = (parseInt(hash.substr(0, 8), 16) % 3) + 2; // 2, 3, 4 (user DBs)
        return this.dbPaths[dbIndex];
    }

    readDatabase(dbIndex) {
        try {
            const data = fs.readFileSync(this.dbPaths[dbIndex], 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error(`❌ Error reading database ${dbIndex}:`, error);
            return this.getEmptyDB(dbIndex);
        }
    }

    writeDatabase(dbIndex, data) {
        try {
            fs.writeFileSync(this.dbPaths[dbIndex], JSON.stringify(data, null, 2));
            return true;
        } catch (error) {
            console.error(`❌ Error writing database ${dbIndex}:`, error);
            return false;
        }
    }

    // USER MANAGEMENT - ALWAYS CONSISTENT
    getUser(userId) {
        // Admin check first
        if (userId === ADMIN_CHAT_ID) {
            const adminDb = this.readDatabase(0);
            return adminDb.users ? adminDb.users[userId] : null;
        }
        
        // Search all user databases (2, 3, 4)
        for (let i = 2; i <= 4; i++) {
            const db = this.readDatabase(i);
            if (db.users && db.users[userId]) {
                return db.users[userId];
            }
        }
        return null;
    }

    createOrUpdateUser(userId, userData) {
        if (userId === ADMIN_CHAT_ID) {
            const adminDb = this.readDatabase(0);
            adminDb.users = adminDb.users || {};
            adminDb.users[userId] = userData;
            return this.writeDatabase(0, adminDb);
        }
        
        const dbPath = this.getDatabasePath(userId);
        const dbIndex = this.dbPaths.indexOf(dbPath);
        const db = this.readDatabase(dbIndex);
        
        const isNewUser = !db.users[userId];
        
        if (!db.users[userId]) {
            db.users[userId] = {
                id: userId,
                firstName: '',
                lastName: '',
                email: '',
                createdAt: new Date().toISOString(),
                lastLogin: new Date().toISOString(),
                profileCompleted: false,
                hasAccess: false,
                ...userData
            };
            
            // Update statistics
            const today = new Date().toISOString().split('T')[0];
            if (db.statistics.lastReset !== today) {
                db.statistics.usersToday = 0;
                db.statistics.lastReset = today;
            }
            db.statistics.usersToday++;
            db.statistics.totalUsers++;
            
            console.log(`✅ New user created in DB${dbIndex}: ${userId}`);
        } else {
            db.users[userId] = { ...db.users[userId], ...userData };
            db.users[userId].lastLogin = new Date().toISOString();
            console.log(`✅ User updated in DB${dbIndex}: ${userId}`);
        }
        
        return this.writeDatabase(dbIndex, db);
    }

    deleteUser(userId) {
        let deleted = false;
        // Search and delete from all user databases
        for (let i = 2; i <= 4; i++) {
            const db = this.readDatabase(i);
            if (db.users && db.users[userId]) {
                delete db.users[userId];
                db.statistics.totalUsers--;
                this.writeDatabase(i, db);
                deleted = true;
                console.log(`🗑️ User ${userId} deleted from DB${i}`);
            }
        }
        return deleted;
    }

    getAllUsers() {
        const allUsers = {};
        // Combine users from all user databases
        for (let i = 2; i <= 4; i++) {
            const db = this.readDatabase(i);
            if (db.users) {
                Object.assign(allUsers, db.users);
            }
        }
        return allUsers;
    }

    getEmptyDB(dbIndex) {
        if (dbIndex === 0) {
            return { settings: {}, admin: {}, groups: [], pendingGroups: [], backups: [] };
        } else if (dbIndex === 1) {
            return { endpointUsage: {}, endpointHealth: {}, whatsappSessions: {}, membershipChecks: {} };
        } else {
            return { users: {}, statistics: { totalUsers: 0, usersToday: 0, lastReset: '', startupCount: 0 } };
        }
    }

    // Get total user count from all databases
    getTotalUserCount() {
        let total = 0;
        for (let i = 2; i <= 4; i++) {
            const db = this.readDatabase(i);
            total += db.statistics?.totalUsers || 0;
        }
        return total;
    }

    // Get today's new users
    getTodayUsers() {
        let today = 0;
        const todayDate = new Date().toISOString().split('T')[0];
        
        for (let i = 2; i <= 4; i++) {
            const db = this.readDatabase(i);
            if (db.statistics?.lastReset === todayDate) {
                today += db.statistics?.usersToday || 0;
            }
        }
        return today;
    }

    // Group management (stored in admin DB)
    addGroup(groupData) {
        const db = this.readDatabase(0);
        if (!db.groups) db.groups = [];
        
        const existing = db.groups.find(g => g.id === groupData.id);
        if (!existing) {
            db.groups.push({
                ...groupData,
                addedAt: new Date().toISOString(),
                isActive: true
            });
            return this.writeDatabase(0, db);
        }
        return false;
    }

    getGroups() {
        const db = this.readDatabase(0);
        return db.groups || [];
    }

    removeGroup(groupId) {
        const db = this.readDatabase(0);
        if (!db.groups) return false;
        
        const initialLength = db.groups.length;
        db.groups = db.groups.filter(g => g.id !== groupId);
        
        if (db.groups.length !== initialLength) {
            return this.writeDatabase(0, db);
        }
        return false;
    }

    // Pending groups management
    addPendingGroup(groupData) {
        const db = this.readDatabase(0);
        if (!db.pendingGroups) db.pendingGroups = [];
        
        const existing = db.pendingGroups.find(g => g.id === groupData.id);
        if (!existing) {
            db.pendingGroups.push({
                id: groupData.id,
                title: groupData.title,
                username: groupData.username,
                inviteLink: groupData.inviteLink,
                type: groupData.type,
                detectedAt: new Date().toISOString(),
                status: 'pending'
            });
            return this.writeDatabase(0, db);
        }
        return false;
    }

    getPendingGroups() {
        const db = this.readDatabase(0);
        return db.pendingGroups || [];
    }

    approveGroup(groupId) {
        const db = this.readDatabase(0);
        if (!db.pendingGroups) return false;
        
        const pendingGroup = db.pendingGroups.find(g => g.id === groupId);
        if (pendingGroup) {
            // Remove from pending
            db.pendingGroups = db.pendingGroups.filter(g => g.id !== groupId);
            
            // Add to active groups
            if (!db.groups) db.groups = [];
            
            db.groups.push({
                id: pendingGroup.id,
                title: pendingGroup.title,
                username: pendingGroup.username,
                inviteLink: pendingGroup.inviteLink,
                type: pendingGroup.type,
                addedAt: new Date().toISOString(),
                isActive: true,
                approvedBy: ADMIN_CHAT_ID,
                lastVerified: new Date().toISOString()
            });
            
            return this.writeDatabase(0, db);
        }
        return false;
    }

    rejectGroup(groupId) {
        const db = this.readDatabase(0);
        if (!db.pendingGroups) return false;
        
        const initialLength = db.pendingGroups.length;
        db.pendingGroups = db.pendingGroups.filter(g => g.id !== groupId);
        
        if (db.pendingGroups.length !== initialLength) {
            return this.writeDatabase(0, db);
        }
        return false;
    }

    // Membership checks (stored in API DB)
    updateUserMembership(userId, isMember) {
        const db = this.readDatabase(1);
        if (!db.membershipChecks) db.membershipChecks = {};
        
        db.membershipChecks[userId] = {
            isMember: isMember,
            lastChecked: new Date().toISOString()
        };
        
        // Also update user record
        const user = this.getUser(userId);
        if (user) {
            user.hasAccess = isMember;
            user.lastMembershipCheck = new Date().toISOString();
            this.createOrUpdateUser(userId, user);
        }
        
        return this.writeDatabase(1, db);
    }

    checkUserAccess(userId) {
        const user = this.getUser(userId);
        const groups = this.getGroups();
        
        if (groups.length === 0) {
            return true;
        }
        
        return user && user.hasAccess === true;
    }

    // Endpoint usage (stored in API DB)
    updateEndpointUsage(endpoint, data) {
        const db = this.readDatabase(1);
        if (!db.endpointUsage) db.endpointUsage = {};
        
        db.endpointUsage[endpoint] = {
            ...db.endpointUsage[endpoint],
            ...data
        };
        
        return this.writeDatabase(1, db);
    }

    getEndpointUsage(endpoint) {
        const db = this.readDatabase(1);
        return db.endpointUsage ? db.endpointUsage[endpoint] : null;
    }

    getAllEndpointUsage() {
        const db = this.readDatabase(1);
        return db.endpointUsage || {};
    }

    // Endpoint health (stored in API DB)
    updateEndpointHealth(endpoint, data) {
        const db = this.readDatabase(1);
        if (!db.endpointHealth) db.endpointHealth = {};
        
        db.endpointHealth[endpoint] = {
            ...db.endpointHealth[endpoint],
            ...data
        };
        
        return this.writeDatabase(1, db);
    }

    getEndpointHealth(endpoint) {
        const db = this.readDatabase(1);
        return db.endpointHealth ? db.endpointHealth[endpoint] : null;
    }

    getAllEndpointHealth() {
        const db = this.readDatabase(1);
        return db.endpointHealth || {};
    }

    // WhatsApp sessions (stored in API DB)
    updateWhatsAppSession(sessionKey, data) {
        const db = this.readDatabase(1);
        if (!db.whatsappSessions) db.whatsappSessions = {};
        
        db.whatsappSessions[sessionKey] = {
            ...db.whatsappSessions[sessionKey],
            ...data,
            lastUpdated: new Date().toISOString()
        };
        
        return this.writeDatabase(1, db);
    }

    getWhatsAppSession(sessionKey) {
        const db = this.readDatabase(1);
        return db.whatsappSessions ? db.whatsappSessions[sessionKey] : null;
    }

    getAllWhatsAppSessions() {
        const db = this.readDatabase(1);
        return db.whatsappSessions || {};
    }

    // Settings (stored in Admin DB)
    updateSettings(settings) {
        const db = this.readDatabase(0);
        db.settings = { ...db.settings, ...settings };
        return this.writeDatabase(0, db);
    }

    getSettings() {
        const db = this.readDatabase(0);
        return db.settings || {};
    }

    // Backup all databases to Dropbox
    async backupAllDatabasesToDropbox(dbx) {
        try {
            const backupFolder = `/${SHORT_DOMAIN}`;
            
            // Create backup folder
            try {
                await dbx.filesCreateFolderV2({ path: backupFolder });
            } catch (e) {
                if (e.status !== 409) throw e; // Ignore if folder exists
            }
            
            // Backup each database
            const results = [];
            for (let i = 0; i < this.dbPaths.length; i++) {
                if (fs.existsSync(this.dbPaths[i])) {
                    const dbBuffer = fs.readFileSync(this.dbPaths[i]);
                    const fileName = path.basename(this.dbPaths[i]);
                    
                    await dbx.filesUpload({
                        path: `${backupFolder}/${fileName}`,
                        contents: dbBuffer,
                        mode: { '.tag': 'overwrite' }
                    });
                    
                    results.push({ db: fileName, status: 'success' });
                    console.log(`✅ ${fileName} backed up to Dropbox`);
                }
            }
            
            return { success: true, results };
        } catch (error) {
            console.error('❌ Backup failed:', error);
            return { success: false, error: error.message };
        }
    }

    // Restore all databases from Dropbox
    async restoreAllDatabasesFromDropbox(dbx) {
        try {
            const backupFolder = `/${SHORT_DOMAIN}`;
            
            // List backup files
            const files = await dbx.filesListFolder({ path: backupFolder });
            
            let restored = 0;
            for (const file of files.result.entries) {
                if (file.name.endsWith('.json')) {
                    const download = await dbx.filesDownload({ path: `${backupFolder}/${file.name}` });
                    const filePath = path.join(__dirname, file.name);
                    fs.writeFileSync(filePath, download.result.fileBinary);
                    restored++;
                    console.log(`✅ Restored ${file.name}`);
                }
            }
            
            return restored > 0;
        } catch (error) {
            if (error.status === 409) return false; // No backup folder
            console.error('❌ Restore failed:', error);
            return false;
        }
    }
}

// Initialize multi-database
const multiDB = new MultiDatabase();

// ==================== DROPBOX CONFIGURATION ====================
const DROPBOX_APP_KEY = 'ho5ep3i58l3tvgu';
const DROPBOX_APP_SECRET = '9fy0w0pgaafyk3e';
const DROPBOX_REFRESH_TOKEN = 'Vjhcbg66GMgAAAAAAAAAARJPgSupFcZdyXFkXiFx7VP-oXv_64RQKmtTLUYfPtm3';

const config = {
    telegramBotToken: '8494420933:AAFHmIvlFBj6zGuGZQ2nZTA7g08XiraVMV8',
    webPort: PORT,
    webBaseUrl: RENDER_DOMAIN,
    
    dropboxAppKey: DROPBOX_APP_KEY,
    dropboxAppSecret: DROPBOX_APP_SECRET,
    dropboxRefreshToken: DROPBOX_REFRESH_TOKEN,
    
    maxMemoryMB: 450,
    backupInterval: 5 * 60 * 1000, // 5 minutes for multi-db
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

        console.log('📤 Backing up all 5 databases to Dropbox...');
        const result = await multiDB.backupAllDatabasesToDropbox(dbx);
        
        return result;
        
    } catch (error) {
        console.error('❌ Error backing up databases to Dropbox:', error.message);
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

        console.log('🔍 Checking for Dropbox database backups...');
        const restored = await multiDB.restoreAllDatabasesFromDropbox(dbx);
        
        if (restored) {
            console.log('✅ All databases restored from Dropbox successfully');
            return true;
        } else {
            console.log('📭 No database backups found in Dropbox, starting fresh');
            return false;
        }

    } catch (error) {
        console.error('❌ Error restoring databases from Dropbox:', error.message);
        return false;
    }
}

// ==================== UPDATED DATABASE FUNCTIONS ====================

function getUser(userId) {
    return multiDB.getUser(userId);
}

function createOrUpdateUser(userId, userData) {
    return multiDB.createOrUpdateUser(userId, userData);
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
    return multiDB.deleteUser(userId);
}

function isAdmin(userId) {
    return userId.toString() === ADMIN_CHAT_ID.toString();
}

function getStatistics() {
    const users = Object.values(multiDB.getAllUsers());
    
    const today = new Date().toISOString().split('T')[0];
    const usersCreatedToday = users.filter(user => 
        user.createdAt && user.createdAt.startsWith(today)
    ).length;
    
    // Count active WhatsApp sessions
    const activeSessions = Object.values(multiDB.getAllWhatsAppSessions()).filter(session => 
        session.isConnected === true
    ).length;
    
    // Count healthy endpoints
    const healthyEndpoints = Object.values(multiDB.getAllEndpointHealth()).filter(health => 
        health.status === 'healthy'
    ).length;
    
    return {
        totalUsers: multiDB.getTotalUserCount(),
        usersToday: multiDB.getTodayUsers(),
        usersWithProfile: users.filter(user => user.profileCompleted).length,
        usersWithoutProfile: users.filter(user => !user.profileCompleted).length,
        activeWhatsAppSessions: activeSessions,
        healthyEndpoints: healthyEndpoints,
        totalEndpoints: Object.keys(multiDB.getAllEndpointHealth()).length,
        lastBackup: new Date().toISOString(),
        startupCount: 1, // Will be updated separately
        domain: SHORT_DOMAIN
    };
}

// ==================== SMART ENDPOINT LOAD BALANCING ====================

const ENDPOINTS = {
    'none': [
        'https://phistar1-c947308e2c22.herokuapp.com',
        'https://phistar2-493eb81a8e3e.herokuapp.com',
        'https://phistar3-b4eb0b108f15.herokuapp.com',
        'https://phistar4-40ef33b1d848.herokuapp.com',
        'https://phistar5-9d6623621776.herokuapp.com',
        'https://phistar6-83c5dff4c830.herokuapp.com',
        'https://phistar7-d3e6e30389df.herokuapp.com',
        'https://phistar8-93095652d71d.herokuapp.com',
        'https://phistar9-63c850998740.herokuapp.com',
        'https://phistar10-1ab85557c6ce.herokuapp.com'
    ],
    '.': [
        'https://phistar11-fd8fc97b716e.herokuapp.com',
        'https://phistar12-f5c2e5aae32f.herokuapp.com',
        'https://phistar13-783c751b1a3b.herokuapp.com',
        'https://phistar14-651590b1a5c5.herokuapp.com',
        'https://phistar15-0e21b409358f.herokuapp.com',
        'https://phistar16-7d52ba611493.herokuapp.com',
        'https://phistar17-b8a29b887790.herokuapp.com',
        'https://phistar18-b523956cce8e.herokuapp.com',
        'https://phistar19-db3dfe9d95fe.herokuapp.com',
        'https://phistar20-5daf898f0473.herokuapp.com'
    ],
    '!': [
        'https://phistar21-7cb87c2741af.herokuapp.com',
        'https://phistar22-438d590945c2.herokuapp.com',
        'https://phistar23-cf0a8f798992.herokuapp.com',
        'https://phistar24-482aba0011b2.herokuapp.com',
        'https://phistar25-edc42bc36c5f.herokuapp.com',
        'https://phistar26-6d2f9ef6fab1.herokuapp.com'
    ],
    '/': [
        'https://phistar30-ffd06985fac2.herokuapp.com',
        'https://phistar27-f2644961d4f8.herokuapp.com',
        'https://phistar28-78f801e09394.herokuapp.com',
        'https://phistar29-5e98e208351e.herokuapp.com'
    ],
    ',': [
        'https://phistar31-721a8521b030.herokuapp.com'
    ]
};

// ==================== UPDATED INITIALIZATION WITH CLEANUP ====================

// Replace the existing initEndpointTracking function with this updated version:
function initEndpointTracking() {
    console.log(`🔀 Endpoint tracking initialized with multi-database system`);
    
    // Clean up old endpoints that are not in current configuration
    cleanupRemovedEndpoints();
    
    // Initialize ALL endpoints with userCount: 0 and health status
    Object.keys(ENDPOINTS).forEach(prefix => {
        ENDPOINTS[prefix].forEach(endpoint => {
            // Initialize endpoint usage
            let usage = multiDB.getEndpointUsage(endpoint);
            if (!usage) {
                multiDB.updateEndpointUsage(endpoint, {
                    userCount: 0,
                    lastUsed: null,
                    prefix: prefix,
                    totalAssigned: 0,
                    addedAt: new Date().toISOString()
                });
            }
            
            // Initialize endpoint health
            let health = multiDB.getEndpointHealth(endpoint);
            if (!health) {
                multiDB.updateEndpointHealth(endpoint, {
                    status: 'unknown',
                    lastChecked: null,
                    responseTime: null,
                    errorCount: 0,
                    successCount: 0,
                    lastError: null,
                    sessionsCount: 0
                });
            }
        });
    });
}

// Add cleanupRemovedEndpoints function
function cleanupRemovedEndpoints() {
    console.log('🧹 Checking for removed endpoints in database...');
    
    // Get all current endpoints from configuration
    const currentEndpoints = [];
    Object.values(ENDPOINTS).forEach(endpointList => {
        currentEndpoints.push(...endpointList);
    });
    
    // Get database entries
    const endpointHealth = multiDB.getAllEndpointHealth();
    const endpointUsage = multiDB.getAllEndpointUsage();
    
    let cleanedHealth = 0;
    let cleanedUsage = 0;
    let cleanedUsers = 0;
    
    // Clean endpointHealth
    Object.keys(endpointHealth).forEach(endpoint => {
        if (!currentEndpoints.includes(endpoint)) {
            console.log(`🗑️ Removing old endpoint health: ${endpoint}`);
            
            // Get API database
            const db = multiDB.readDatabase(1);
            if (db.endpointHealth && db.endpointHealth[endpoint]) {
                delete db.endpointHealth[endpoint];
                cleanedHealth++;
            }
            multiDB.writeDatabase(1, db);
        }
    });
    
    // Clean endpointUsage
    Object.keys(endpointUsage).forEach(endpoint => {
        if (!currentEndpoints.includes(endpoint)) {
            console.log(`🗑️ Removing old endpoint usage: ${endpoint}`);
            
            // Get API database
            const db = multiDB.readDatabase(1);
            if (db.endpointUsage && db.endpointUsage[endpoint]) {
                delete db.endpointUsage[endpoint];
                cleanedUsage++;
            }
            multiDB.writeDatabase(1, db);
        }
    });
    
    // Clean user activeBots
    const allUsers = multiDB.getAllUsers();
    Object.keys(allUsers).forEach(userId => {
        const user = allUsers[userId];
        if (user && user.activeBots) {
            const initialLength = user.activeBots.length;
            user.activeBots = user.activeBots.filter(bot => 
                bot.endpoint && currentEndpoints.includes(bot.endpoint)
            );
            
            if (user.activeBots.length !== initialLength) {
                cleanedUsers++;
                console.log(`🔄 Cleaned removed endpoints from user ${userId}`);
                multiDB.createOrUpdateUser(userId, user);
            }
        }
    });
    
    if (cleanedHealth > 0 || cleanedUsage > 0 || cleanedUsers > 0) {
        console.log(`✅ Cleanup completed: ${cleanedHealth} health records, ${cleanedUsage} usage records, ${cleanedUsers} users updated`);
    } else {
        console.log('✅ No old endpoints found in database');
    }
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
// Add this function to get all current endpoints
function getAllCurrentEndpoints() {
    const allEndpoints = [];
    Object.values(ENDPOINTS).forEach(endpointList => {
        allEndpoints.push(...endpointList);
    });
    return allEndpoints;
}
// Update healthCheckAllEndpoints to only check current endpoints
async function healthCheckAllEndpoints() {
    console.log('🔍 Performing health check on all current endpoints...');
    
    const currentEndpoints = getAllCurrentEndpoints();
    let healthyCount = 0;
    let unhealthyCount = 0;
    let downCount = 0;
    
    const healthResults = {};
    
    for (const endpoint of currentEndpoints) {
        try {
            const health = await checkEndpointHealth(endpoint);
            healthResults[endpoint] = health;
            
            // Update database
            const currentHealth = multiDB.getEndpointHealth(endpoint) || {};
            multiDB.updateEndpointHealth(endpoint, {
                ...currentHealth,
                ...health,
                lastChecked: new Date().toISOString()
            });
            
            if (health.status === 'healthy') {
                healthyCount++;
                multiDB.updateEndpointHealth(endpoint, {
                    successCount: (currentHealth.successCount || 0) + 1,
                    errorCount: 0 // Reset error count on success
                });
            } else {
                if (health.status === 'down') {
                    downCount++;
                } else {
                    unhealthyCount++;
                }
                multiDB.updateEndpointHealth(endpoint, {
                    errorCount: (currentHealth.errorCount || 0) + 1,
                    lastError: health.error
                });
                
                // Notify admin if endpoint is down
                if (health.status === 'down' && bot) {
                    const errorCount = (currentHealth.errorCount || 0) + 1;
                    if (errorCount === 1 || errorCount % 5 === 0) {
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
    
    console.log(`✅ Health check completed: ${healthyCount} healthy, ${unhealthyCount} unhealthy, ${downCount} down`);
    
    return {
        healthy: healthyCount,
        unhealthy: unhealthyCount,
        down: downCount,
        total: currentEndpoints.length,
        results: healthResults
    };
}


// Update getBalancedEndpoint to only consider current endpoints
function getBalancedEndpoint(prefix) {
    const endpoints = ENDPOINTS[prefix] || [];
    
    if (endpoints.length === 0) {
        console.log(`❌ No endpoints configured for prefix: ${prefix}`);
        return null;
    }
    
    console.log(`🔍 Looking for healthy endpoints for prefix: ${prefix}`);
    
    // Filter only healthy endpoints
    const healthyEndpoints = endpoints.filter(endpoint => {
        const health = multiDB.getEndpointHealth(endpoint);
        return health && health.status === 'healthy';
    });
    
    if (healthyEndpoints.length === 0) {
        console.log(`❌ No healthy endpoints available for prefix: ${prefix}`);
        // Fallback to any endpoint if no healthy ones
        console.log(`🔄 Falling back to any endpoint for prefix: ${prefix}`);
        return getFallbackEndpoint(endpoints);
    }
    
    console.log(`✅ Found ${healthyEndpoints.length} healthy endpoints for prefix ${prefix}`);
    
    // Find endpoint with least users among healthy ones
    let minUsers = Infinity;
    let selectedEndpoint = null;
    
    healthyEndpoints.forEach(endpoint => {
        const usage = multiDB.getEndpointUsage(endpoint);
        const health = multiDB.getEndpointHealth(endpoint);
        
        console.log(`🔍 Endpoint ${endpoint}: ${usage?.userCount || 0} users, ${health?.responseTime || 'N/A'}ms response`);
        
        const userCount = usage?.userCount || 0;
        if (userCount < minUsers) {
            minUsers = userCount;
            selectedEndpoint = endpoint;
        } else if (userCount === minUsers) {
            // If same user count, choose the one with better response time
            const currentHealth = multiDB.getEndpointHealth(selectedEndpoint);
            const currentResponseTime = currentHealth?.responseTime || Infinity;
            const newResponseTime = health?.responseTime || Infinity;
            
            if (newResponseTime < currentResponseTime) {
                selectedEndpoint = endpoint;
            }
        }
    });
    
    if (selectedEndpoint) {
        // Update usage count
        const currentUsage = multiDB.getEndpointUsage(selectedEndpoint) || {};
        multiDB.updateEndpointUsage(selectedEndpoint, {
            userCount: (currentUsage.userCount || 0) + 1,
            lastUsed: new Date().toISOString(),
            totalAssigned: (currentUsage.totalAssigned || 0) + 1
        });
        
        console.log(`🔀 Load balancing: Selected ${selectedEndpoint} for prefix ${prefix} (now has ${(currentUsage.userCount || 0) + 1} users)`);
    } else {
        console.log(`❌ No endpoint selected for prefix: ${prefix}`);
    }
    
    return selectedEndpoint;
}

// Fallback endpoint selection when no healthy endpoints
function getFallbackEndpoint(endpoints) {
    let minUsers = Infinity;
    let selectedEndpoint = null;
    
    endpoints.forEach(endpoint => {
        const usage = multiDB.getEndpointUsage(endpoint) || {};
        console.log(`🔍 Fallback endpoint ${endpoint}: ${usage.userCount || 0} users`);
        
        if ((usage.userCount || 0) < minUsers) {
            minUsers = usage.userCount || 0;
            selectedEndpoint = endpoint;
        }
    });
    
    if (selectedEndpoint) {
        // Update usage count
        const currentUsage = multiDB.getEndpointUsage(selectedEndpoint) || {};
        multiDB.updateEndpointUsage(selectedEndpoint, {
            userCount: (currentUsage.userCount || 0) + 1,
            lastUsed: new Date().toISOString(),
            totalAssigned: (currentUsage.totalAssigned || 0) + 1
        });
        
        console.log(`🔄 Fallback: Selected ${selectedEndpoint} (now has ${(currentUsage.userCount || 0) + 1} users)`);
    }
    
    return selectedEndpoint;
}

// Release endpoint when user stops bot
function releaseEndpoint(endpoint) {
    const usage = multiDB.getEndpointUsage(endpoint);
    if (usage) {
        if (usage.userCount > 0) {
            usage.userCount--;
        }
        multiDB.updateEndpointUsage(endpoint, usage);
        
        console.log(`🔀 Load balancing: Released ${endpoint} (now has ${usage.userCount} users)`);
    } else {
        console.log(`⚠️ Cannot release endpoint ${endpoint}: not found in endpointUsage`);
    }
}

// ==================== OPTIMIZED MEMORY MANAGEMENT ====================

// Optimized memory cache with aggressive cleanup
const memoryCache = new NodeCache({ 
    stdTTL: 300, // 5 minutes instead of 1 hour
    checkperiod: 60,
    maxKeys: 100 // Limit total cache entries
});

// Emergency restart prevention
let emergencyRestartCount = 0;
let lastEmergencyRestart = 0;

function checkEmergencyRestart() {
    const now = Date.now();
    if (now - lastEmergencyRestart < 300000) { // 5 minutes
        emergencyRestartCount++;
    } else {
        emergencyRestartCount = 0;
    }
    lastEmergencyRestart = now;
    
    if (emergencyRestartCount > 3) {
        console.log('🚨 EMERGENCY: Too many restarts, stopping auto-recovery');
        process.exit(1); // Let Render handle it
    }
}

function startAggressiveMemoryCleanup() {
    setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
        
        console.log(`🧠 Memory: ${heapUsedMB.toFixed(2)}MB / 450MB`);
        
        // Cleanup at 70% memory usage instead of 80%
        if (heapUsedMB > config.maxMemoryMB * 0.7) {
            console.log('⚠️ High memory - running aggressive cleanup');
            
            // Clear all caches
            memoryCache.flushAll();
            verificationJobs.clear();
            
            // Clear stale connections
            const now = Date.now();
            for (const [key, client] of connectedClients.entries()) {
                if (now - client.lastActivity > 300000) { // 5 minutes
                    connectedClients.delete(key);
                }
            }
            
            if (global.gc) {
                global.gc();
            }
        }
        
        // Force cleanup every 100 users
        if (multiDB.getTotalUserCount() % 100 === 0) {
            performMemoryCleanup();
        }
        
    }, 30000); // Check every 30 seconds
}

function startMemoryCleanup() {
    setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
        
        console.log(`🧠 Memory usage: ${heapUsedMB.toFixed(2)}MB / ${config.maxMemoryMB}MB`);
        
        if (heapUsedMB > config.maxMemoryMB * 0.7) { // 70% instead of 80%
            console.log('⚠️ High memory usage detected, running cleanup...');
            performMemoryCleanup();
        }
        
        const keys = memoryCache.keys();
        if (keys.length > 100) { // Reduced from 1000
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

// ==================== OPTIMIZED WHATSAPP SESSIONS MANAGEMENT ====================

// Function to update WhatsApp sessions from endpoints
async function updateWhatsAppSessions() {
    try {
        console.log('🔄 Updating WhatsApp sessions from all endpoints...');
        
        const allEndpoints = new Set();
        
        // Collect all unique endpoints from endpointUsage
        const endpointUsage = multiDB.getAllEndpointUsage();
        Object.keys(endpointUsage).forEach(endpoint => {
            allEndpoints.add(endpoint);
        });
        
        // Also collect from user activeBots
        const allUsers = multiDB.getAllUsers();
        Object.values(allUsers).forEach(user => {
            if (user.activeBots) {
                user.activeBots.forEach(bot => {
                    if (bot.endpoint) {
                        allEndpoints.add(bot.endpoint);
                    }
                });
            }
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
                        
                        multiDB.updateWhatsAppSession(sessionKey, {
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
                        });
                        
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

// Function to get WhatsApp sessions for a specific user
function getUserWhatsAppSessions(userId) {
    const user = getUser(userId);
    
    if (!user || !user.activeBots) {
        return [];
    }
    
    const userSessions = [];
    
    user.activeBots.forEach(bot => {
        if (bot.number && bot.endpoint) {
            const sessionKey = `${bot.endpoint}_${bot.number}`;
            const sessionData = multiDB.getWhatsAppSession(sessionKey);
            
            if (sessionData) {
                userSessions.push({
                    ...sessionData,
                    prefix: bot.prefix,
                    startTime: bot.startTime,
                    status: bot.status || 'unknown'
                });
            } else {
                // If no session data found, create basic session info
                userSessions.push({
                    phoneNumber: bot.number,
                    endpoint: bot.endpoint,
                    prefix: bot.prefix,
                    mode: 'unknown',
                    health: 'unknown',
                    messagesProcessed: 0,
                    errors: 0,
                    queueSize: 0,
                    welcomeSent: false,
                    lastActivity: 'unknown',
                    isConnected: false,
                    status: bot.status || 'unknown',
                    startTime: bot.startTime,
                    lastUpdated: new Date().toISOString()
                });
            }
        }
    });
    
    return userSessions;
}

// Function to get all WhatsApp sessions (for admin)
function getAllWhatsAppSessions() {
    return multiDB.getAllWhatsAppSessions();
}

// Start optimized session monitoring
function startSessionMonitoring() {
    console.log('🔄 Starting optimized WhatsApp session monitoring (every 5 minutes)');
    
    // Update every 5 minutes (increased from 2)
    setInterval(updateWhatsAppSessions, 5 * 60 * 1000);
}

// Start optimized health check monitoring
function startHealthCheckMonitoring() {
    console.log('🔄 Starting optimized endpoint health monitoring (every 10 minutes)');
    
    // Health check every 10 minutes (increased from 5)
    setInterval(healthCheckAllEndpoints, 10 * 60 * 1000);
}

// ==================== REAL-TIME NOTIFICATIONS ====================

const connectedClients = new Map();

// Notify client of connection status
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

// ==================== ENHANCED GROUP/CHANNEL MANAGEMENT ====================

function addPendingGroup(groupData) {
    return multiDB.addPendingGroup(groupData);
}

async function approveGroup(groupId) {
    const success = multiDB.approveGroup(groupId);
    
    if (success && bot) {
        const groups = multiDB.getGroups();
        const group = groups.find(g => g.id === groupId);
        
        if (group) {
            await bot.telegram.sendMessage(
                ADMIN_CHAT_ID,
                `✅ *Sponsor Approved Successfully!*\n\n` +
                `📝 *Title:* ${group.title}\n` +
                `📋 *Type:* ${group.type}\n` +
                `🔗 *Link:* ${group.inviteLink || 'Manual join required'}\n\n` +
                `This sponsor is now visible to users and required for access.`,
                { parse_mode: 'Markdown' }
            );
        }
    }
    
    return success;
}

function rejectGroup(groupId) {
    return multiDB.rejectGroup(groupId);
}

function getPendingGroups() {
    return multiDB.getPendingGroups();
}

async function addGroupWithInvite(groupData) {
    try {
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
        
        return multiDB.addGroup(enhancedGroupData);
    } catch (error) {
        console.error('Error adding group with invite:', error);
        return false;
    }
}

function addGroup(groupData) {
    return multiDB.addGroup(groupData);
}

function removeGroup(groupId) {
    return multiDB.removeGroup(groupId);
}

function getGroups() {
    return multiDB.getGroups();
}

function updateUserMembership(userId, isMember) {
    return multiDB.updateUserMembership(userId, isMember);
}

function checkUserAccess(userId) {
    return multiDB.checkUserAccess(userId);
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
        const users = Object.keys(multiDB.getAllUsers());
        const groups = getGroups();
        
        if (groups.length === 0 || !bot) return;
        
        let checked = 0;
        let restricted = 0;
        
        for (const userId of users) {
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

// ==================== OPTIMIZED AUTO-BACKUP SYSTEM ====================
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
            console.log('✅ Backup completed successfully');
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

// ==================== IMPROVED AUTO-PING SYSTEM FOR RENDER ====================
function startAutoPing() {
    if (!IS_RENDER) {
        console.log('🚫 Auto-ping disabled (not on Render)');
        return;
    }

    const pingInterval = 5 * 60 * 1000; // 5 minutes (reduced from 14)
    let consecutiveFailures = 0;
    const maxFailures = 3;
    
    async function pingServer() {
        try {
            const response = await axios.get(`${config.webBaseUrl}/health`, { 
                timeout: 10000 
            });
            
            console.log(`✅ Auto-ping successful: ${response.data.status}`);
            consecutiveFailures = 0; // Reset failure count
            
            // Log memory usage with ping
            const memoryUsage = process.memoryUsage();
            const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
            console.log(`🧠 Memory during ping: ${heapUsedMB.toFixed(2)}MB`);
            
        } catch (error) {
            consecutiveFailures++;
            console.warn(`⚠️ Auto-ping failed (${consecutiveFailures}/${maxFailures}): ${error.message}`);
            
            // Emergency action if multiple pings fail
            if (consecutiveFailures >= maxFailures) {
                console.error('🚨 Multiple ping failures - possible service disruption');
                
                // Try to notify admin via bot if possible
                if (bot) {
                    try {
                        await bot.telegram.sendMessage(
                            ADMIN_CHAT_ID,
                            `🚨 *Auto-Ping Alert*\n\n` +
                            `Multiple consecutive ping failures detected!\n` +
                            `🌐 Server: ${config.webBaseUrl}\n` +
                            `❌ Failures: ${consecutiveFailures}\n` +
                            `🕒 Time: ${new Date().toLocaleString()}\n\n` +
                            `Service may be experiencing issues.`,
                            { parse_mode: 'Markdown' }
                        );
                    } catch (botError) {
                        console.error('Cannot notify admin via bot:', botError.message);
                    }
                }
            }
            
            // Retry sooner after failure
            if (consecutiveFailures > 0) {
                console.log(`🔄 Retrying ping in 2 minutes...`);
                setTimeout(pingServer, 2 * 60 * 1000);
            }
        }
    }

    // Start pinging after 30 seconds (reduced from 1 minute)
    setTimeout(() => {
        console.log(`🔔 Starting auto-ping (every ${pingInterval/60000} minutes)`);
        pingServer();
        setInterval(pingServer, pingInterval);
    }, 30000);

    console.log(`🔄 Auto-ping configured for Render free tier (every ${pingInterval/60000} minutes)`);
}

// ==================== EXPRESS WEB SERVER ====================
const app = express();

// Serve static files from views directory
app.use(express.static('views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== ADDITIONAL PING ENDPOINTS ====================

// Add simple ping endpoints for better monitoring
app.get('/ping', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'BIG_DADDY_V3',
        multiDB: true,
        totalUsers: multiDB.getTotalUserCount()
    });
});

app.get('/simple-health', (req, res) => {
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
    
    res.status(200).json({ 
        status: 'healthy',
        memory: `${heapUsedMB.toFixed(2)}MB`,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        databases: multiDB.dbPaths.map(p => path.basename(p)),
        totalUsers: multiDB.getTotalUserCount()
    });
});

// ==================== UPDATED REGISTRATION FORM ROUTES ====================

// Registration Form Route - Serve external HTML file
app.get('/register/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        
        // Check if user exists and has completed profile
        if (user && user.profileCompleted) {
            // User already has profile, redirect to profile edit
            return res.redirect(`/profile/${userId}`);
        }
        
        // Serve the external HTML file
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

// Handle Registration Form Submission
app.post('/register/:userId', express.json(), (req, res) => {
    try {
        const userId = req.params.userId;
        const { firstName, lastName, email } = req.body;
        
        console.log(`📝 Registration form submitted for ${userId}:`, { firstName, lastName, email });
        
        // Validate required fields
        if (!firstName || !lastName || !email) {
            return res.json({ 
                success: false, 
                error: 'All fields are required' 
            });
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.json({ 
                success: false, 
                error: 'Please enter a valid email address' 
            });
        }
        
        // Save user profile
        const success = setUserProfile(userId, firstName, lastName, email);
        
        if (success) {
            console.log(`✅ User registered via web: ${userId}`);
            
            // Notify admin
            if (bot) {
                const stats = getStatistics();
                bot.telegram.sendMessage(
                    ADMIN_CHAT_ID,
                    `👤 *New Web Registration*\n\n📛 Name: ${firstName} ${lastName}\n📧 Email: ${email}\n🆔 User ID: ${userId}\n\n📊 Total Users: ${stats.totalUsers}\n📈 Today: ${stats.usersToday}`,
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
        console.error('Registration submission error:', error);
        res.json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ==================== PROFILE MANAGEMENT ROUTES ====================

// Profile Edit Page
app.get('/profile/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        
        if (!user || !user.profileCompleted) {
            return res.redirect(`/register/${userId}`);
        }

        // Generate profile edit page HTML (same as before)
        res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>BIG DADDY V3 - Edit Profile</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
            :root {
                /* Dark Theme */
                --primary: #E53935;
                --primary-dark: #C62828;
                --primary-light: #EF5350;
                --secondary: #1E1E2D;
                --secondary-dark: #151521;
                --accent: #FF5252;
                --text-primary: #FFFFFF;
                --text-secondary: #B0B0C0;
                --text-tertiary: #7E7E8F;
                --success: #4CAF50;
                --error: #F44336;
                --warning: #FF9800;
                --info: #2196F3;
                --border-radius: 12px;
                --border-radius-sm: 6px;
                --box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
                --box-shadow-sm: 0 4px 12px rgba(0, 0, 0, 0.15);
                --transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
                --glass-effect: rgba(30, 30, 45, 0.7);
                --glass-border: 1px solid rgba(255, 255, 255, 0.1);
                --glass-blur: blur(10px);
                --premium-gold: #FFD700;
                --premium-gradient: linear-gradient(135deg, #FFD700, #FFA500);
            }

            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: 'Poppins', sans-serif;
                background-color: var(--secondary);
                color: var(--text-primary);
                line-height: 1.6;
                background-image: radial-gradient(circle at 25% 25%, rgba(229, 57, 53, 0.1) 0%, transparent 50%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
            }

            .profile-container {
                width: 100%;
                max-width: 500px;
            }

            .profile-card {
                background: var(--glass-effect);
                backdrop-filter: var(--glass-blur);
                border-radius: var(--border-radius);
                padding: 40px;
                border: var(--glass-border);
                box-shadow: var(--box-shadow);
                position: relative;
                overflow: hidden;
            }

            .profile-card::before {
                content: '';
                position: absolute;
                top: -50%;
                right: -50%;
                width: 200px;
                height: 200px;
                background: radial-gradient(circle, rgba(229, 57, 53, 0.2) 0%, transparent 70%);
                border-radius: 50%;
            }

            .logo-container {
                text-align: center;
                margin-bottom: 30px;
                position: relative;
                z-index: 2;
            }

            .logo-container h1 {
                font-size: 1.8rem;
                font-weight: 700;
                color: var(--primary);
                text-transform: uppercase;
                letter-spacing: 1px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                margin-bottom: 5px;
            }

            .logo-icon {
                font-size: 2rem;
            }

            .subtitle {
                color: var(--text-tertiary);
                font-size: 0.9rem;
            }

            .form-group {
                margin-bottom: 20px;
                position: relative;
                z-index: 2;
            }

            .form-group label {
                display: block;
                margin-bottom: 8px;
                color: var(--text-secondary);
                font-weight: 500;
                font-size: 0.9rem;
            }

            .form-control {
                width: 100%;
                padding: 12px 16px;
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: var(--border-radius-sm);
                color: var(--text-primary);
                font-family: 'Poppins', sans-serif;
                font-size: 0.9rem;
                transition: var(--transition);
            }

            .form-control:focus {
                outline: none;
                border-color: var(--primary);
                background: rgba(255, 255, 255, 0.08);
                box-shadow: 0 0 0 2px rgba(229, 57, 53, 0.2);
            }

            .form-control::placeholder {
                color: var(--text-tertiary);
            }

            .btn {
                width: 100%;
                padding: 14px;
                border: none;
                border-radius: var(--border-radius-sm);
                font-family: 'Poppins', sans-serif;
                font-size: 0.9rem;
                font-weight: 600;
                cursor: pointer;
                transition: var(--transition);
                position: relative;
                overflow: hidden;
            }

            .btn-primary {
                background: linear-gradient(135deg, var(--primary), var(--primary-dark));
                color: white;
                box-shadow: var(--box-shadow-sm);
            }

            .btn-primary:hover {
                transform: translateY(-2px);
                box-shadow: 0 5px 15px rgba(229, 57, 53, 0.4);
            }

            .btn-outline {
                background: transparent;
                border: 1px solid var(--text-tertiary);
                color: var(--text-primary);
                margin-top: 10px;
            }

            .btn-outline:hover {
                background: rgba(255, 255, 255, 0.05);
                border-color: var(--primary);
                color: var(--primary);
            }

            .alert {
                padding: 12px 16px;
                border-radius: var(--border-radius-sm);
                margin-bottom: 20px;
                font-size: 0.9rem;
                display: none;
            }

            .alert-success {
                background: rgba(76, 175, 80, 0.1);
                border: 1px solid rgba(76, 175, 80, 0.3);
                color: var(--success);
            }

            .alert-error {
                background: rgba(244, 67, 54, 0.1);
                border: 1px solid rgba(244, 67, 54, 0.3);
                color: var(--error);
            }

            .user-info {
                background: rgba(255, 255, 255, 0.05);
                padding: 20px;
                border-radius: var(--border-radius-sm);
                margin-bottom: 25px;
                border-left: 3px solid var(--primary);
            }

            .user-info h3 {
                color: var(--primary);
                margin-bottom: 10px;
                font-size: 1.1rem;
            }

            .user-details p {
                color: var(--text-secondary);
                margin-bottom: 5px;
                font-size: 0.9rem;
            }

            @media (max-width: 768px) {
                .profile-card {
                    padding: 30px 20px;
                }
                
                .logo-container h1 {
                    font-size: 1.5rem;
                }
            }
            </style>
        </head>
        <body>
            <div class="profile-container">
                <div class="profile-card">
                    <div class="logo-container">
                        <h1>
                            <span class="logo-icon">👤</span>
                            EDIT PROFILE
                        </h1>
                        <div class="subtitle">Update your personal information</div>
                    </div>

                    <div class="user-info">
                        <h3>Current Profile</h3>
                        <div class="user-details">
                            <p><strong>Name:</strong> ${user.firstName} ${user.lastName}</p>
                            <p><strong>Email:</strong> ${user.email}</p>
                            <p><strong>Member since:</strong> ${new Date(user.createdAt).toLocaleDateString()}</p>
                        </div>
                    </div>

                    <div id="alert" class="alert"></div>

                    <form id="profileForm">
                        <div class="form-group">
                            <label for="firstName">First Name</label>
                            <input type="text" id="firstName" class="form-control" value="${user.firstName}" required>
                        </div>

                        <div class="form-group">
                            <label for="lastName">Last Name</label>
                            <input type="text" id="lastName" class="form-control" value="${user.lastName}" required>
                        </div>

                        <div class="form-group">
                            <label for="email">Email Address</label>
                            <input type="email" id="email" class="form-control" value="${user.email}" required>
                        </div>

                        <button type="submit" class="btn btn-primary">Update Profile</button>
                        <button type="button" onclick="window.location.href='/webapp/${userId}'" class="btn btn-outline">
                            Back to Dashboard
                        </button>
                    </form>
                </div>
            </div>

            <script>
                const form = document.getElementById('profileForm');
                const alert = document.getElementById('alert');

                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    
                    const formData = {
                        firstName: document.getElementById('firstName').value.trim(),
                        lastName: document.getElementById('lastName').value.trim(),
                        email: document.getElementById('email').value.trim()
                    };

                    // Basic validation
                    if (!formData.firstName || !formData.lastName || !formData.email) {
                        showAlert('Please fill in all fields', 'error');
                        return;
                    }

                    // Email validation
                    const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
                    if (!emailRegex.test(formData.email)) {
                        showAlert('Please enter a valid email address', 'error');
                        return;
                    }

                    try {
                        const response = await fetch('/api/update-profile/${userId}', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify(formData)
                        });

                        const data = await response.json();

                        if (data.success) {
                            showAlert('Profile updated successfully!', 'success');
                            // Update user info display
                            document.querySelector('.user-details').innerHTML = \`
                                <p><strong>Name:</strong> \${formData.firstName} \${formData.lastName}</p>
                                <p><strong>Email:</strong> \${formData.email}</p>
                                <p><strong>Member since:</strong> ${new Date(user.createdAt).toLocaleDateString()}</p>
                            \`;
                        } else {
                            showAlert(data.error || 'Failed to update profile', 'error');
                        }
                    } catch (error) {
                        showAlert('Network error. Please try again.', 'error');
                    }
                });

                function showAlert(message, type) {
                    alert.textContent = message;
                    alert.className = 'alert ' + (type === 'success' ? 'alert-success' : 'alert-error');
                    alert.style.display = 'block';
                    
                    setTimeout(() => {
                        alert.style.display = 'none';
                    }, 5000);
                }
            </script>
        </body>
        </html>
        `);
        
    } catch (error) {
        console.error('Profile page error:', error);
        res.status(500).send('Internal server error');
    }
});

// API endpoint to update profile
app.post('/api/update-profile/:userId', express.json(), (req, res) => {
    try {
        const userId = req.params.userId;
        const { firstName, lastName, email } = req.body;
        
        console.log(`📝 Profile update for ${userId}:`, { firstName, lastName, email });
        
        // Validate required fields
        if (!firstName || !lastName || !email) {
            return res.json({ 
                success: false, 
                error: 'All fields are required' 
            });
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.json({ 
                success: false, 
                error: 'Please enter a valid email address' 
            });
        }
        
        // Update user profile
        const success = setUserProfile(userId, firstName, lastName, email);
        
        if (success) {
            console.log(`✅ Profile updated for user: ${userId}`);
            res.json({ 
                success: true, 
                message: 'Profile updated successfully' 
            });
        } else {
            res.json({ 
                success: false, 
                error: 'Failed to update profile' 
            });
        }
        
    } catch (error) {
        console.error('Profile update error:', error);
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
        const user = getUser(userId);
        
        if (userId === ADMIN_CHAT_ID) {
            return res.sendFile(path.join(__dirname, 'views', 'admin.html'));
        }
        
        // FIXED: Check membership BEFORE showing access denied
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
        console.error('Web App error:', error);
        res.status(500).send('Internal server error');
    }
});

// API endpoint for user data
app.get('/api/user/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        const settings = multiDB.getSettings();
        
        if (!user) {
            return res.json({ success: false, error: 'User not found' });
        }
        
        res.json({
            success: true,
            user: user,
            domain: SHORT_DOMAIN,
            welcomeMessage: settings?.webWelcomeMessage || "🎉 Welcome to your dashboard!"
        });
        
    } catch (error) {
        console.error('API user error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// API endpoint for admin users list
app.get('/admin/users', (req, res) => {
    try {
        const users = Object.values(multiDB.getAllUsers());
        
        // Sort by creation date, newest first
        const sortedUsers = users.sort((a, b) => 
            new Date(b.createdAt) - new Date(a.createdAt)
        );
        
        res.json({
            success: true,
            users: sortedUsers
        });
        
    } catch (error) {
        console.error('Admin users API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== UPDATED WHATSAPP SESSIONS API ====================

// Get WhatsApp sessions for a user
app.get('/api/whatsapp-sessions/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const sessions = getUserWhatsAppSessions(userId);
        
        res.json({
            success: true,
            sessions: sessions,
            total: sessions.length,
            connected: sessions.filter(s => s.isConnected).length,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('WhatsApp sessions API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

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
        const endpointUsage = multiDB.getAllEndpointUsage();
        const endpointHealth = multiDB.getAllEndpointHealth();
        
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

// ==================== ADD THESE MISSING ENDPOINT MANAGEMENT ROUTES ====================

// POST /admin/endpoints/add - Add new endpoint to a prefix
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
            ENDPOINTS[prefix] = []; // Create new prefix if doesn't exist
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
        multiDB.updateEndpointUsage(endpointUrl, {
            userCount: 0,
            lastUsed: null,
            prefix: prefix,
            totalAssigned: 0,
            addedAt: new Date().toISOString()
        });
        
        multiDB.updateEndpointHealth(endpointUrl, {
            status: 'unknown',
            lastChecked: null,
            responseTime: null,
            errorCount: 0,
            successCount: 0,
            lastError: null,
            sessionsCount: 0
        });
        
        console.log(`✅ New endpoint added: ${endpointUrl} to prefix: ${prefix}`);
        
        // Run health check on new endpoint
        setTimeout(async () => {
            try {
                const health = await checkEndpointHealth(endpointUrl);
                multiDB.updateEndpointHealth(endpointUrl, {
                    ...health,
                    lastChecked: new Date().toISOString()
                });
                console.log(`✅ Health check for new endpoint ${endpointUrl}: ${health.status}`);
            } catch (error) {
                console.error(`❌ Health check failed for new endpoint ${endpointUrl}:`, error.message);
            }
        }, 2000);
        
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

// DELETE /admin/endpoints/remove - Remove endpoint from system
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
        
        // Remove from user activeBots that use this endpoint
        let usersAffected = 0;
        const allUsers = multiDB.getAllUsers();
        Object.keys(allUsers).forEach(userId => {
            const user = allUsers[userId];
            if (user && user.activeBots) {
                const initialLength = user.activeBots.length;
                user.activeBots = user.activeBots.filter(bot => bot.endpoint !== endpointUrl);
                
                if (user.activeBots.length !== initialLength) {
                    usersAffected++;
                    console.log(`🔄 Cleaned endpoint from user ${userId}`);
                    multiDB.createOrUpdateUser(userId, user);
                }
            }
        });
        
        // Clear endpoint from database
        const db = multiDB.readDatabase(1); // API database
        if (db.endpointHealth && db.endpointHealth[endpointUrl]) {
            delete db.endpointHealth[endpointUrl];
        }
        if (db.endpointUsage && db.endpointUsage[endpointUrl]) {
            delete db.endpointUsage[endpointUrl];
        }
        if (db.whatsappSessions) {
            Object.keys(db.whatsappSessions).forEach(key => {
                if (key.includes(endpointUrl)) {
                    delete db.whatsappSessions[key];
                }
            });
        }
        multiDB.writeDatabase(1, db);
        
        res.json({
            success: true,
            message: `Endpoint removed successfully from prefix: ${removedFromPrefix}`,
            endpoint: endpointUrl,
            usersAffected: usersAffected,
            cleanup: {
                endpointUsage: true,
                endpointHealth: true,
                userBots: usersAffected,
                whatsappSessions: true
            }
        });
        
    } catch (error) {
        console.error('Remove endpoint error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /admin/endpoints/move - Move endpoint to different prefix
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
        const usage = multiDB.getEndpointUsage(endpointUrl);
        if (usage) {
            usage.prefix = newPrefix;
            usage.lastUpdated = new Date().toISOString();
            multiDB.updateEndpointUsage(endpointUrl, usage);
        }
        
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

// Add cleanup endpoint to admin panel
app.post('/admin/endpoints/cleanup', async (req, res) => {
    try {
        console.log('🧹 Manual endpoint cleanup triggered');
        
        // Run cleanup
        cleanupRemovedEndpoints();
        
        // Run health check on current endpoints
        const healthCheck = await healthCheckAllEndpoints();
        
        res.json({
            success: true,
            message: 'Endpoint cleanup and health check completed',
            cleanup: 'Completed',
            healthCheck: {
                total: healthCheck.total,
                healthy: healthCheck.healthy,
                unhealthy: healthCheck.unhealthy,
                down: healthCheck.down
            },
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get endpoint statistics
app.get('/admin/endpoints/stats', (req, res) => {
    try {
        const endpointUsage = multiDB.getAllEndpointUsage();
        const endpointHealth = multiDB.getAllEndpointHealth();
        
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
        const health = multiDB.getAllEndpointHealth();
        
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
        const stats = multiDB.getAllEndpointUsage();
        const health = multiDB.getAllEndpointHealth();
        
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
        
        // Update user data with bot information
        const user = getUser(userId);
        if (user) {
            user.activeBots = user.activeBots || [];
            
            // Remove any existing bot for this user
            user.activeBots = user.activeBots.filter(bot => 
                bot.number !== phoneNumber
            );
            
            // Add new bot with pairing status
            user.activeBots.push({
                number: phoneNumber,
                prefix: prefix,
                endpoint: endpoint,
                status: 'pairing', // Start as pairing
                startTime: new Date().toISOString(),
                lastChecked: new Date().toISOString()
            });
            
            multiDB.createOrUpdateUser(userId, user);
            
            // ✅ ADD DROPBOX BACKUP
            await backupDatabaseToDropbox().catch(error => {
                console.error('❌ Dropbox backup failed after pairing:', error.message);
            });
            
            console.log(`✅ Bot assigned for user ${userId}: ${phoneNumber} on ${endpoint}`);
        }
        
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

// Update bot status after pairing (called from frontend)
app.post('/api/update-bot-status', async (req, res) => {
    try {
        const { phoneNumber, status, userId, endpoint } = req.body;
        
        if (!phoneNumber || !status || !userId) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters' 
            });
        }
        
        console.log(`🔄 Updating bot status: ${phoneNumber} -> ${status} for user ${userId}`);
        
        const user = getUser(userId);
        if (user && user.activeBots) {
            const bot = user.activeBots.find(bot => bot.number === phoneNumber);
            if (bot) {
                bot.status = status;
                bot.lastChecked = new Date().toISOString();
                
                if (status === 'connected') {
                    bot.connectedAt = new Date().toISOString();
                }
                
                multiDB.createOrUpdateUser(userId, user);
                
                console.log(`✅ Bot status updated: ${phoneNumber} -> ${status}`);
                
                res.json({
                    success: true,
                    message: 'Bot status updated successfully'
                });
            } else {
                res.json({
                    success: false,
                    error: 'Bot not found for this user'
                });
            }
        } else {
            res.json({
                success: false,
                error: 'User not found or no active bots'
            });
        }
        
    } catch (error) {
        console.error('Update bot status error:', error);
        res.status(500).json({ 
            success: false, 
            error: `Status update failed: ${error.message}` 
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
        
        const user = getUser(userId);
        let userEndpoint = null;
        
        if (user && user.activeBots) {
            const activeBot = user.activeBots.find(bot => bot.number === phoneNumber);
            if (activeBot) {
                userEndpoint = activeBot.endpoint;
                
                // Remove the bot from user's active bots
                user.activeBots = user.activeBots.filter(
                    bot => bot.number !== phoneNumber
                );
                multiDB.createOrUpdateUser(userId, user);
                
                // Release endpoint
                releaseEndpoint(userEndpoint);
                
                console.log(`✅ Bot stopped successfully: ${phoneNumber}`);
                
                res.json({
                    success: true,
                    message: 'Bot stopped successfully',
                    endpoint: userEndpoint
                });
            } else {
                res.json({
                    success: false,
                    error: 'No active bot found for this phone number'
                });
            }
        } else {
            res.json({
                success: false,
                error: 'User not found or no active bots'
            });
        }
        
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
        
        // First, stop the current bot if it exists
        const user = getUser(userId);
        
        if (user && user.activeBots) {
            const activeBot = user.activeBots.find(bot => bot.number === phoneNumber);
            if (activeBot) {
                // Release the old endpoint
                releaseEndpoint(activeBot.endpoint);
            }
            
            // Remove old bot entry
            user.activeBots = user.activeBots.filter(
                bot => bot.number !== phoneNumber
            );
            multiDB.createOrUpdateUser(userId, user);
        }
        
        // Get new balanced endpoint for the prefix
        newEndpoint = getBalancedEndpoint(prefix);
        
        if (!newEndpoint) {
            return res.json({
                success: false,
                error: `No endpoints available for prefix: ${prefix}`
            });
        }

        console.log(`🔀 Selected new endpoint: ${newEndpoint} for prefix ${prefix}`);
        
        // Update user data with new bot information
        if (user) {
            user.activeBots = user.activeBots || [];
            
            // Add new bot with new endpoint
            user.activeBots.push({
                number: phoneNumber,
                prefix: prefix,
                endpoint: newEndpoint,
                status: 'pairing',
                startTime: new Date().toISOString(),
                lastChecked: new Date().toISOString()
            });
            
            multiDB.createOrUpdateUser(userId, user);
        }
        
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

// Start background verification
app.post('/api/start-verification', async (req, res) => {
    try {
        const { phoneNumber, endpoint, userId, prefix, attempts = 6 } = req.body;
        
        const jobId = `${userId}_${phoneNumber}`;
        
        // Store verification job
        verificationJobs.set(jobId, {
            phoneNumber,
            endpoint,
            userId,
            prefix,
            attemptsRemaining: attempts,
            status: 'active',
            startTime: new Date(),
            nextCheck: new Date(Date.now() + 2 * 60 * 1000) // Check in 2 minutes
        });
        
        console.log(`📱 Started background verification for ${phoneNumber}`);
        
        res.json({ 
            success: true, 
            message: 'Background verification started',
            jobId 
        });
    } catch (error) {
        console.error('Error starting verification:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Check verification status
app.get('/api/verification-status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Find active verification jobs for this user
        const userJobs = Array.from(verificationJobs.entries())
            .filter(([key, job]) => key.startsWith(userId + '_'))
            .map(([key, job]) => job);
        
        if (userJobs.length > 0) {
            res.json({
                success: true,
                verification: userJobs[0] // Return the first active job
            });
        } else {
            res.json({
                success: true,
                verification: null
            });
        }
    } catch (error) {
        console.error('Error checking verification status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Clear verification job
app.post('/api/clear-verification', async (req, res) => {
    try {
        const { userId } = req.body;
        
        // Find and remove verification jobs for this user
        const keysToDelete = Array.from(verificationJobs.keys())
            .filter(key => key.startsWith(userId + '_'));
        
        keysToDelete.forEach(key => verificationJobs.delete(key));
        
        res.json({ success: true, message: 'Verification cleared' });
    } catch (error) {
        console.error('Error clearing verification:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Background verification worker (runs every 30 seconds)
setInterval(async () => {
    const now = new Date();
    
    for (const [jobId, job] of verificationJobs.entries()) {
        if (job.status === 'active' && job.nextCheck <= now) {
            try {
                console.log(`🔍 Checking verification for ${job.phoneNumber}`);
                
                const checkUrl = `${job.endpoint}/checkverification?phoneNumber=${job.phoneNumber}`;
                const response = await fetch(checkUrl, { timeout: 10000 });
                
                if (response.ok) {
                    const data = await response.json();
                    
                    if (data.success && data.connected) {
                        // User connected!
                        console.log(`✅ ${job.phoneNumber} is now connected!`);
                        
                        job.status = 'completed';
                        job.connected = true;
                        
                        // Update user's bot status in database
                        const user = getUser(job.userId);
                        if (user) {
                            user.activeBots = [{
                                number: job.phoneNumber,
                                endpoint: job.endpoint,
                                prefix: job.prefix,
                                status: 'connected',
                                connectedAt: new Date()
                            }];
                            multiDB.createOrUpdateUser(job.userId, user);
                        }
                        
                        // You could add notification logic here (email, push, etc.)
                        
                    } else {
                        // Not connected yet
                        job.attemptsRemaining--;
                        
                        if (job.attemptsRemaining > 0) {
                            job.nextCheck = new Date(Date.now() + 2 * 60 * 1000); // Check again in 2 minutes
                            console.log(`⏳ ${job.phoneNumber} not connected yet. Attempts left: ${job.attemptsRemaining}`);
                        } else {
                            // Out of attempts
                            job.status = 'failed';
                            console.log(`❌ ${job.phoneNumber} verification failed - out of attempts`);
                        }
                    }
                } else {
                    // Endpoint unavailable
                    job.attemptsRemaining--;
                    console.log(`⚠️ ${job.phoneNumber} endpoint unavailable. Attempts left: ${job.attemptsRemaining}`);
                    
                    if (job.attemptsRemaining > 0) {
                        job.nextCheck = new Date(Date.now() + 2 * 60 * 1000);
                    } else {
                        job.status = 'failed';
                    }
                }
            } catch (error) {
                console.error(`Error checking ${job.phoneNumber}:`, error.message);
                job.attemptsRemaining--;
                
                if (job.attemptsRemaining > 0) {
                    job.nextCheck = new Date(Date.now() + 2 * 60 * 1000);
                } else {
                    job.status = 'failed';
                }
            }
        }
    }
}, 30000); // Run every 30 seconds

// ==================== PROFESSIONAL LOADING PAGE ====================
app.get('/loading/:userId', (req, res) => {
    const userId = req.params.userId;
    
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V3 - Loading</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
        :root {
            /* Dark Theme */
            --primary: #E53935;
            --primary-dark: #C62828;
            --primary-light: #EF5350;
            --secondary: #1E1E2D;
            --secondary-dark: #151521;
            --accent: #FF5252;
            --text-primary: #FFFFFF;
            --text-secondary: #B0B0C0;
            --text-tertiary: #7E7E8F;
            --success: #4CAF50;
            --error: #F44336;
            --warning: #FF9800;
            --info: #2196F3;
            --border-radius: 12px;
            --border-radius-sm: 6px;
            --box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            --box-shadow-sm: 0 4px 12px rgba(0, 0, 0, 0.15);
            --transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
            --glass-effect: rgba(30, 30, 45, 0.7);
            --glass-border: 1px solid rgba(255, 255, 255, 0.1);
            --glass-blur: blur(10px);
            --premium-gold: #FFD700;
            --premium-gradient: linear-gradient(135deg, #FFD700, #FFA500);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Poppins', sans-serif;
            background-color: var(--secondary);
            color: var(--text-primary);
            line-height: 1.6;
            background-image: radial-gradient(circle at 25% 25%, rgba(229, 57, 53, 0.1) 0%, transparent 50%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }

        .loading-container {
            width: 100%;
            max-width: 500px;
        }

        .loading-card {
            background: var(--glass-effect);
            backdrop-filter: var(--glass-blur);
            border-radius: var(--border-radius);
            padding: 50px 40px;
            border: var(--glass-border);
            box-shadow: var(--box-shadow);
            position: relative;
            overflow: hidden;
        }

        .loading-card::before {
            content: '';
            position: absolute;
            top: -50%;
            right: -50%;
            width: 200px;
            height: 200px;
            background: radial-gradient(circle, rgba(229, 57, 53, 0.2) 0%, transparent 70%);
            border-radius: 50%;
        }

        .loading-card::after {
            content: '';
            position: absolute;
            bottom: -30%;
            left: -30%;
            width: 150px;
            height: 150px;
            background: radial-gradient(circle, rgba(255, 82, 82, 0.15) 0%, transparent 70%);
            border-radius: 50%;
        }

        .logo-container {
            margin-bottom: 30px;
            position: relative;
            z-index: 2;
        }

        .logo-container h1 {
            font-size: 2.2rem;
            font-weight: 700;
            color: var(--primary);
            text-transform: uppercase;
            letter-spacing: 2px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            margin-bottom: 8px;
        }

        .logo-icon {
            font-size: 2.5rem;
            animation: float 3s ease-in-out infinite;
        }

        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-10px); }
        }

        .version {
            font-size: 0.8rem;
            background: linear-gradient(135deg, var(--primary), var(--accent));
            color: white;
            padding: 4px 12px;
            border-radius: 20px;
            font-weight: 600;
            display: inline-block;
        }

        .loader-wrapper {
            margin: 40px 0;
            position: relative;
            z-index: 2;
        }

        .main-loader {
            width: 80px;
            height: 80px;
            margin: 0 auto 25px;
            position: relative;
        }

        .loader-ring {
            position: absolute;
            width: 100%;
            height: 100%;
            border: 3px solid transparent;
            border-top: 3px solid var(--primary);
            border-radius: 50%;
            animation: spin 1.5s linear infinite;
        }

        .loader-ring:nth-child(2) {
            width: 70%;
            height: 70%;
            top: 15%;
            left: 15%;
            border-top: 3px solid var(--accent);
            animation: spin 1s linear infinite reverse;
        }

        .loader-ring:nth-child(3) {
            width: 40%;
            height: 40%;
            top: 30%;
            left: 30%;
            border-top: 3px solid var(--primary-light);
            animation: spin 0.5s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .loading-text {
            font-size: 1.3rem;
            font-weight: 600;
            margin-bottom: 15px;
            background: linear-gradient(to right, var(--primary), var(--accent));
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            position: relative;
            z-index: 2;
        }

        .loading-subtext {
            font-size: 0.9rem;
            color: var(--text-tertiary);
            margin-bottom: 30px;
            position: relative;
            z-index: 2;
        }

        .progress-container {
            width: 100%;
            height: 6px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 3px;
            overflow: hidden;
            margin: 25px 0;
            position: relative;
            z-index: 2;
        }

        .progress-bar {
            height: 100%;
            background: linear-gradient(90deg, var(--primary), var(--accent));
            border-radius: 3px;
            width: 0%;
            animation: progress 2s ease-in-out infinite;
            position: relative;
            overflow: hidden;
        }

        .progress-bar::after {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
            animation: shimmer 2s ease-in-out infinite;
        }

        @keyframes progress {
            0% { width: 0%; }
            50% { width: 70%; }
            100% { width: 100%; }
        }

        @keyframes shimmer {
            0% { left: -100%; }
            100% { left: 100%; }
        }

        .features-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-top: 35px;
            position: relative;
            z-index: 2;
        }

        .feature-card {
            background: rgba(255, 255, 255, 0.05);
            padding: 20px 15px;
            border-radius: var(--border-radius-sm);
            border: 1px solid rgba(255, 255, 255, 0.1);
            transition: var(--transition);
            text-align: center;
        }

        .feature-card:hover {
            background: rgba(255, 255, 255, 0.08);
            transform: translateY(-3px);
            border-color: rgba(229, 57, 53, 0.3);
        }

        .feature-icon {
            font-size: 1.8rem;
            margin-bottom: 10px;
            display: block;
        }

        .feature-text {
            font-size: 0.8rem;
            color: var(--text-secondary);
            font-weight: 500;
        }

        .status-indicators {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin-top: 25px;
            position: relative;
            z-index: 2;
        }

        .status-item {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.8rem;
            color: var(--text-tertiary);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--success);
            animation: pulse 2s infinite;
        }

        .status-dot.primary {
            background: var(--primary);
            animation-delay: 0.5s;
        }

        .status-dot.warning {
            background: var(--warning);
            animation-delay: 1s;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(1.2); }
        }

        .loading-stats {
            display: flex;
            justify-content: space-around;
            margin-top: 25px;
            position: relative;
            z-index: 2;
        }

        .stat {
            text-align: center;
        }

        .stat-number {
            font-size: 1.2rem;
            font-weight: 700;
            color: var(--primary);
            display: block;
        }

        .stat-label {
            font-size: 0.7rem;
            color: var(--text-tertiary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        /* Particle background */
        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 1;
        }

        .particle {
            position: absolute;
            background: var(--primary);
            border-radius: 50%;
            opacity: 0.3;
            animation: float-particle 6s infinite linear;
        }

        .particle:nth-child(1) {
            width: 4px;
            height: 4px;
            top: 20%;
            left: 10%;
            animation-delay: 0s;
        }

        .particle:nth-child(2) {
            width: 6px;
            height: 6px;
            top: 60%;
            left: 80%;
            animation-delay: 1s;
        }

        .particle:nth-child(3) {
            width: 3px;
            height: 3px;
            top: 80%;
            left: 20%;
            animation-delay: 2s;
        }

        .particle:nth-child(4) {
            width: 5px;
            height: 5px;
            top: 30%;
            left: 70%;
            animation-delay: 3s;
        }

        .particle:nth-child(5) {
            width: 4px;
            height: 4px;
            top: 70%;
            left: 40%;
            animation-delay: 4s;
        }

        @keyframes float-particle {
            0%, 100% {
                transform: translateY(0px) translateX(0px);
                opacity: 0.3;
            }
            25% {
                transform: translateY(-20px) translateX(10px);
                opacity: 0.5;
            }
            50% {
                transform: translateY(-10px) translateX(20px);
                opacity: 0.3;
            }
            75% {
                transform: translateY(-15px) translateX(-10px);
                opacity: 0.4;
            }
        }

        /* Glow effects */
        .glow-effect {
            position: absolute;
            width: 200px;
            height: 200px;
            background: radial-gradient(circle, rgba(229, 57, 53, 0.1) 0%, transparent 70%);
            border-radius: 50%;
            filter: blur(20px);
            z-index: 1;
        }

        .glow-1 {
            top: -100px;
            right: -100px;
            animation: glow-pulse 4s ease-in-out infinite;
        }

        .glow-2 {
            bottom: -80px;
            left: -80px;
            animation: glow-pulse 4s ease-in-out infinite reverse;
        }

        @keyframes glow-pulse {
            0%, 100% { opacity: 0.3; transform: scale(1); }
            50% { opacity: 0.6; transform: scale(1.1); }
        }

        /* Responsive design */
        @media (max-width: 768px) {
            .loading-container {
                padding: 20px;
            }
            
            .loading-card {
                padding: 30px 20px;
            }
            
            .logo-container h1 {
                font-size: 1.8rem;
            }
            
            .features-grid {
                grid-template-columns: 1fr;
                gap: 10px;
            }
            
            .loading-stats {
                flex-direction: column;
                gap: 15px;
            }
        }
        </style>
    </head>
    <body>
        <div class="loading-container">
            <div class="loading-card">
                <!-- Background elements -->
                <div class="particles">
                    <div class="particle"></div>
                    <div class="particle"></div>
                    <div class="particle"></div>
                    <div class="particle"></div>
                    <div class="particle"></div>
                </div>
                <div class="glow-effect glow-1"></div>
                <div class="glow-effect glow-2"></div>
                
                <!-- Main content -->
                <div class="logo-container">
                    <h1>
                        <span class="logo-icon">🚀</span>
                        BIG DADDY V3
                    </h1>
                    <span class="version">MULTI-DB EDITION</span>
                </div>
                
                <div class="loader-wrapper">
                    <div class="main-loader">
                        <div class="loader-ring"></div>
                        <div class="loader-ring"></div>
                        <div class="loader-ring"></div>
                    </div>
                    
                    <div class="loading-text">Initializing Multi-Database System</div>
                    <div class="loading-subtext">5 databases synchronized...</div>
                    
                    <div class="progress-container">
                        <div class="progress-bar"></div>
                    </div>
                </div>
                
                <div class="features-grid">
                    <div class="feature-card">
                        <span class="feature-icon">💾</span>
                        <div class="feature-text">5 Database Files</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">⚡</span>
                        <div class="feature-text">High Performance</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">🔒</span>
                        <div class="feature-text">Secure Access</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">📊</span>
                        <div class="feature-text">Live Analytics</div>
                    </div>
                </div>
                
                <div class="status-indicators">
                    <div class="status-item">
                        <div class="status-dot"></div>
                        <span>System Online</span>
                    </div>
                    <div class="status-item">
                        <div class="status-dot primary"></div>
                        <span>Loading Data</span>
                    </div>
                    <div class="status-item">
                        <div class="status-dot warning"></div>
                        <span>Secure Connection</span>
                    </div>
                </div>
                
                <div class="loading-stats">
                    <div class="stat">
                        <span class="stat-number" id="userCount">0</span>
                        <span class="stat-label">Total Users</span>
                    </div>
                    <div class="stat">
                        <span class="stat-number" id="botCount">0</span>
                        <span class="stat-label">Bots Running</span>
                    </div>
                    <div class="stat">
                        <span class="stat-number" id="uptime">100%</span>
                        <span class="stat-label">Uptime</span>
                    </div>
                </div>
            </div>
        </div>
        
        <script>
            // Animated counter for stats
            function animateCounter(element, target, duration = 2000) {
                let start = 0;
                const increment = target / (duration / 16);
                const timer = setInterval(() => {
                    start += increment;
                    if (start >= target) {
                        element.textContent = target;
                        clearInterval(timer);
                    } else {
                        element.textContent = Math.floor(start);
                    }
                }, 16);
            }
            
            // Simulate loading progress
            setTimeout(() => {
                animateCounter(document.getElementById('userCount'), ${multiDB.getTotalUserCount()});
                animateCounter(document.getElementById('botCount'), 28);
            }, 500);
            
            // Redirect to dashboard after 3 seconds
            setTimeout(() => {
                window.location.href = '/webapp/${userId}';
            }, 3000);
            
            // Add some random console-like messages for effect
            const messages = [
                "✓ Multi-database system initialized",
                "✓ 5 databases synchronized", 
                "✓ User data distributed",
                "✓ Dropbox backup connected",
                "✓ Security protocols active",
                "✓ Dashboard ready in 3s"
            ];
            
            let messageIndex = 0;
            const messageInterval = setInterval(() => {
                if (messageIndex < messages.length) {
                    console.log(messages[messageIndex]);
                    messageIndex++;
                } else {
                    clearInterval(messageInterval);
                }
            }, 400);
        </script>
    </body>
    </html>
    `);
});

// Health check endpoint for auto-ping
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        statistics: getStatistics(),
        domain: SHORT_DOMAIN,
        dropboxEnabled: isDropboxInitialized,
        telegramBot: true,
        multiDB: true,
        databaseFiles: multiDB.dbPaths.map(p => path.basename(p)),
        totalUsers: multiDB.getTotalUserCount()
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
        console.error('Delete user error:', error);
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

// ==================== ENDPOINT SESSIONS API ====================

// Get all sessions organized by endpoint
app.get('/api/endpoint-sessions', (req, res) => {
    try {
        const sessions = getAllWhatsAppSessions();
        const endpointHealth = multiDB.getAllEndpointHealth();
        
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
        res.json({
            success: true,
            lastBackup: new Date().toISOString(),
            totalUsers: multiDB.getTotalUserCount(),
            startupCount: 1,
            domain: SHORT_DOMAIN,
            dropboxEnabled: isDropboxInitialized,
            telegramBot: true,
            multiDB: true,
            databaseFiles: multiDB.dbPaths.map(p => path.basename(p))
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
        const stats = getStatistics();
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>BIG DADDY V3 Multi-DB Dashboard</title>
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
                    .db-badge {
                        display: inline-block;
                        padding: 5px 10px;
                        border-radius: 15px;
                        background: #2196F3;
                        color: white;
                        font-size: 12px;
                        margin: 2px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🚀 BIG DADDY V3 MULTI-DB</h1>
                    <p>5 Database System for 100k+ Users</p>
                    
                    <div class="stats">
                        <div class="stat-item">
                            <p><strong>Server:</strong> ${SHORT_DOMAIN}</p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Status:</strong> <span class="status-badge">✅ Online</span></p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Total Users:</strong> ${stats.totalUsers}</p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Today's Users:</strong> ${stats.usersToday}</p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Databases:</strong> <span class="db-badge">5 Files</span></p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Dropbox Backup:</strong> <span class="status-badge">✅ Connected</span></p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Telegram Bot:</strong> <span class="status-badge">✅ Active</span></p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Multi-DB:</strong> <span class="status-badge">✅ Enabled</span></p>
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

function generateSetupRequiredPage() {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Setup Required - BIG DADDY V3</title>
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
            .info-icon {
                font-size: 4rem;
                margin-bottom: 20px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="info-icon">ℹ️</div>
            <h1>Setup Required</h1>
            <p>Please complete your account setup in Telegram first.</p>
            <p>Return to the Telegram bot and use the "Create Account" button to get started.</p>
            
            <button onclick="window.close()" 
                    style="background: #4CAF50; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 20px;">
                Close
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

        bot.command('users', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await listUsers(ctx);
            } else {
                await ctx.reply('❌ Access denied  admin only.');
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

        // Update profile - OPEN WEB APP
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

        // Admin endpoint management command
        bot.command('endpoints', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
                return;
            }
            
            const endpointHealth = multiDB.getAllEndpointHealth();
            
            let message = `🔧 *Endpoint Management*\n\n`;
            
            Object.keys(ENDPOINTS).forEach(prefix => {
                message += `*${prefix.toUpperCase()} Prefix:*\n`;
                ENDPOINTS[prefix].forEach(endpoint => {
                    const health = endpointHealth[endpoint] || { status: 'unknown' };
                    const usage = multiDB.getEndpointUsage(endpoint) || { userCount: 0 };
                    
                    message += `• ${endpoint}\n`;
                    message += `  👥 ${usage.userCount} users | 🏥 ${health.status} | ⏱️ ${health.responseTime || 'N/A'}ms\n`;
                });
                message += `\n`;
            });
            
            message += `*Available Commands:*\n`;
            message += `/addendpoint - Add new endpoint\n`;
            message += `/removeendpoint - Remove endpoint\n`;
            message += `/testendpoint - Test endpoint health\n`;
            message += `/endpointstats - Show endpoint statistics`;
            
            await ctx.reply(message, { parse_mode: 'Markdown' });
        });

        // Add endpoint command
        bot.command('addendpoint', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
                return;
            }
            
            const args = ctx.message.text.split(' ').slice(1);
            if (args.length < 2) {
                await ctx.reply(
                    '📝 *Add Endpoint*\n\n' +
                    'Usage: `/addendpoint PREFIX ENDPOINT_URL`\n\n' +
                    'Example: `/addendpoint none https://new-endpoint.herokuapp.com`\n\n' +
                    '*Available Prefixes:*\n' +
                    Object.keys(ENDPOINTS).map(p => `• \`${p}\``).join('\n'),
                    { parse_mode: 'Markdown' }
                );
                return;
            }
            
            const prefix = args[0];
            const endpointUrl = args[1];
            
            // Validate prefix
            if (!ENDPOINTS[prefix]) {
                await ctx.reply(
                    `❌ Invalid prefix: ${prefix}\n\n` +
                    `Available prefixes: ${Object.keys(ENDPOINTS).join(', ')}`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }
            
            // Validate URL
            try {
                new URL(endpointUrl);
            } catch (error) {
                await ctx.reply('❌ Invalid endpoint URL format');
                return;
            }
            
            // Check if endpoint already exists
            for (const existingPrefix in ENDPOINTS) {
                if (ENDPOINTS[existingPrefix].includes(endpointUrl)) {
                    await ctx.reply(`❌ Endpoint already exists in prefix: ${existingPrefix}`);
                    return;
                }
            }
            
            // Add endpoint
            ENDPOINTS[prefix].push(endpointUrl);
            
            // Update database
            multiDB.updateEndpointUsage(endpointUrl, {
                userCount: 0,
                lastUsed: null,
                prefix: prefix,
                totalAssigned: 0,
                addedAt: new Date().toISOString()
            });
            
            multiDB.updateEndpointHealth(endpointUrl, {
                status: 'unknown',
                lastChecked: null,
                responseTime: null,
                errorCount: 0,
                successCount: 0
            });
            
            await ctx.reply(
                `✅ *Endpoint Added Successfully!*\n\n` +
                `🔗 *URL:* ${endpointUrl}\n` +
                `🏷️ *Prefix:* ${prefix}\n` +
                `📊 *Total in prefix:* ${ENDPOINTS[prefix].length} endpoints`,
                { parse_mode: 'Markdown' }
            );
        });

        // Remove endpoint command
        bot.command('removeendpoint', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
                return;
            }
            
            const args = ctx.message.text.split(' ').slice(1);
            if (args.length < 1) {
                await ctx.reply(
                    '🗑️ *Remove Endpoint*\n\n' +
                    'Usage: `/removeendpoint ENDPOINT_URL`\n\n' +
                    'Example: `/removeendpoint https://old-endpoint.herokuapp.com`\n\n' +
                    '⚠️ *Warning:* This will remove the endpoint from all users and clean up all related data.',
                    { parse_mode: 'Markdown' }
                );
                return;
            }
            
            const endpointUrl = args[0];
            let removedFromPrefix = null;
            
            // Find and remove endpoint
            for (const prefix in ENDPOINTS) {
                const index = ENDPOINTS[prefix].indexOf(endpointUrl);
                if (index > -1) {
                    ENDPOINTS[prefix].splice(index, 1);
                    removedFromPrefix = prefix;
                    break;
                }
            }
            
            if (!removedFromPrefix) {
                await ctx.reply('❌ Endpoint not found in any prefix');
                return;
            }
            
            // Clean up database
            let usersAffected = 0;
            
            // Remove from user activeBots
            const allUsers = multiDB.getAllUsers();
            Object.keys(allUsers).forEach(userId => {
                const user = allUsers[userId];
                if (user.activeBots) {
                    const initialLength = user.activeBots.length;
                    user.activeBots = user.activeBots.filter(bot => bot.endpoint !== endpointUrl);
                    if (user.activeBots.length !== initialLength) {
                        usersAffected++;
                        multiDB.createOrUpdateUser(userId, user);
                    }
                }
            });
            
            await ctx.reply(
                `✅ *Endpoint Removed Successfully!*\n\n` +
                `🔗 *URL:* ${endpointUrl}\n` +
                `🏷️ *Removed from prefix:* ${removedFromPrefix}\n` +
                `👥 *Users affected:* ${usersAffected}\n` +
                `🗑️ *Cleanup:* Database entries removed`,
                { parse_mode: 'Markdown' }
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
    const settings = multiDB.getSettings();
    const adminWelcome = settings?.adminWelcomeMessage || "👑 *Welcome to Admin Panel*\n\nManage your bot users and monitor statistics.";
    
    await ctx.reply(
        adminWelcome,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('👑 Admin Dashboard', `${config.webBaseUrl}/webapp/${userId}`)],
                [Markup.button.callback('📊 Statistics', 'admin_stats')],
                [Markup.button.callback('👥 User List', 'admin_users')],
                [Markup.button.callback('💾 Backup Now', 'admin_backup')]
            ])
        }
    );
}

async function handleUserStart(ctx) {
    try {
        const userId = ctx.from.id.toString();
        const user = getUser(userId);
        const settings = multiDB.getSettings();
        
        console.log(`👤 User start: ${userId}, profile completed: ${user?.profileCompleted}`);
        
        // Clear any existing session
        if (ctx.session) {
            ctx.session.setupStep = null;
            ctx.session.firstName = null;
            ctx.session.lastName = null;
            ctx.session.email = null;
        }
        
        const welcomeMessage = settings?.welcomeMessage || "👋 *Welcome to BIG DADDY V3 Bot!*\n\nTo access the bot, you need to join our sponsor channels first. After joining all required channels, you'll be able to create your account and start using the bot features.";
        
        // Check membership FIRST for all users
        const membershipCheck = await checkUserMembership(userId);
        
        if (!membershipCheck.hasAccess) {
            console.log(`🔒 User ${userId} doesn't have access to all sponsors`);
            await showJoinRequiredMessage(ctx, membershipCheck.notJoinedGroups);
            return;
        }
        
        // User has access to all sponsors - now check if they have profile
        if (user && user.profileCompleted) {
            // Existing user with completed profile
            console.log(`✅ Existing user with completed profile: ${userId}`);
            
            await ctx.reply(
                `🎉 *Welcome back ${user.firstName}!*\n\n` +
                `Your profile is already set up.\n\n` +
                `Access your dashboard below:`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.webApp('🚀 Open Dashboard', `${config.webBaseUrl}/loading/${userId}`)],
                        [Markup.button.callback('✏️ Update Profile', 'update_profile')]
                    ])
                }
            );
        } else {
            // User has access but no profile - allow registration
            console.log(`🆕 User has access but no profile: ${userId}`);
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
                [Markup.button.callback('⏳ Pending Groups', 'admin_pending')],
                [Markup.button.callback('💾 Backup Now', 'admin_backup')]
            ])
        }
    );
}

async function showStatistics(ctx) {
    const stats = getStatistics();
    const groups = getGroups();
    const pendingGroups = getPendingGroups();
    
    const users = Object.values(multiDB.getAllUsers());
    const recentUsers = users
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 5);
    
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
    const users = Object.values(multiDB.getAllUsers());
    
    if (users.length === 0) {
        await ctx.reply('📭 No users found in the database.');
        return;
    }
    
    const userList = users
        .slice(0, 10)
        .map((user, index) => 
            `${index + 1}. ${user.firstName || 'Unknown'} ${user.lastName || ''}\n   📧 ${user.email || 'No email'}\n   🆔 ${user.id}\n   📅 ${new Date(user.createdAt).toLocaleDateString()}\n`
        )
        .join('\n');
    
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

// ==================== START SERVERS ====================
async function startServers() {
    try {
        console.log('🚀 Starting BIG DADDY V3 Multi-Database Telegram Bot...');
        console.log(`🌐 Domain: ${SHORT_DOMAIN}`);
        console.log(`🔗 URL: ${config.webBaseUrl}`);
        console.log(`🤖 Bot Token: ${config.telegramBotToken ? '✅ Configured' : '❌ Missing'}`);
        console.log(`📦 Dropbox: ${DROPBOX_REFRESH_TOKEN ? '✅ Configured' : '❌ Missing'}`);
        console.log(`👑 Admin: ${ADMIN_CHAT_ID} (${ADMIN_USERNAME})`);
        console.log(`💾 Databases: ${multiDB.dbPaths.length} files`);
        
        initEndpointTracking();
        
        console.log('🔄 Checking for Dropbox backup...');
        await restoreDatabaseFromDropbox();
        
        const server = app.listen(config.webPort, '0.0.0.0', () => {
            console.log(`✅ Web server running on port ${config.webPort}`);
            console.log(`📊 Dashboard: ${config.webBaseUrl}`);
            console.log(`👑 Admin Panel: ${config.webBaseUrl}/webapp/${ADMIN_CHAT_ID}`);
            console.log(`📝 Registration: ${config.webBaseUrl}/register/{userId}`);
            console.log(`👤 Profile: ${config.webBaseUrl}/profile/{userId}`);
            console.log(`⏳ Loading: ${config.webBaseUrl}/loading/{userId}`);
            console.log(`🏥 Health: ${config.webBaseUrl}/health`);
            console.log(`🔔 Ping: ${config.webBaseUrl}/ping`);
            console.log(`🚀 Auto-deploy: ${IS_RENDER ? 'Enabled' : 'Disabled'}`);
            console.log(`connecting to bigdaddy database`);
            console.log(`database connected bigdaddyv3`);
        });

        // Start all monitoring systems
        startAutoPing();
        startAutoBackup();
        startMemoryCleanup();
        startAggressiveMemoryCleanup();
        startMembershipMonitoring();
        startSessionMonitoring();
        startHealthCheckMonitoring();

        // Additional safety ping for Render
        setInterval(() => {
            // Quick self-ping every 4 minutes as backup
            if (IS_RENDER) {
                axios.get(`${config.webBaseUrl}/ping`, { timeout: 5000 })
                    .then(() => console.log('🔔 Safety ping OK'))
                    .catch(() => console.log('⚠️ Safety ping failed'));
            }
        }, 4 * 60 * 1000);

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
                    `💾 *New Multi-Database System:*\n` +
                    `• database_admin.json (Admin data)\n` +
                    `• database_api.json (API/Endpoint data)\n` +
                    `• database_users1.json (User data 1/3)\n` +
                    `• database_users2.json (User data 2/3)\n` +
                    `• database_users3.json (User data 3/3)\n\n` +
                    `👥 *Total Users:* ${multiDB.getTotalUserCount()}\n` +
                    `📊 *Today's Users:* ${multiDB.getTodayUsers()}\n\n` +
                    `*Key Features:*\n` +
                    `✅ 5-Database system for 100k+ users\n` +
                    `✅ Consistent hashing for user distribution\n` +
                    `✅ Automatic Dropbox backup of all 5 files\n` +
                    `✅ Fast user lookup across all databases\n` +
                    `✅ Memory optimized for Render free tier\n\n` +
                    `The system is now optimized for massive scale!`,
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
    checkEmergencyRestart();
    process.exit(1);
});

// Start everything
console.log(`connecting to bigdaddy database`);
console.log(`database connected bigdaddyv3`);
startServers();

module.exports = {
    readDatabase: multiDB.readDatabase.bind(multiDB),
    getUser,
    createOrUpdateUser,
    deleteUser,
    isAdmin,
    getStatistics,
    backupDatabaseToDropbox,
    updateWhatsAppSessions,
    getUserWhatsAppSessions,
    getAllWhatsAppSessions,
    healthCheckAllEndpoints,
    getBalancedEndpoint,
    multiDB // Export the multi-database instance
};
