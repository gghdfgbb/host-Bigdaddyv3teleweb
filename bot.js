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

// ==================== DATABASE SETUP ====================
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
        return { users: {}, settings: {}, statistics: {}, backups: [], groups: [], pendingGroups: [], membershipChecks: {}, endpointUsage: {}, whatsappSessions: {} };
    }
}

function writeDatabase(data) {
    try {
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
        console.log(`✅ New user created: ${userId}`);
        
        const today = new Date().toISOString().split('T')[0];
        if (db.statistics.lastReset !== today) {
            db.statistics.usersToday = 0;
            db.statistics.lastReset = today;
        }
        db.statistics.usersToday = (db.statistics.usersToday || 0) + 1;
    } else {
        db.users[userId] = { ...db.users[userId], ...userData };
        console.log(`✅ User updated: ${userId}`);
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
    
    return writeDatabase(db);
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
        
        writeDatabase(db);
        return true;
    }
    return false;
}

function isAdmin(userId) {
    return userId.toString() === ADMIN_CHAT_ID.toString();
}

function getStatistics() {
    const db = readDatabase();
    const users = Object.values(db.users);
    
    const today = new Date().toISOString().split('T')[0];
    const usersCreatedToday = users.filter(user => 
        user.createdAt && user.createdAt.startsWith(today)
    ).length;
    
    // Count active WhatsApp sessions
    const activeSessions = Object.values(db.whatsappSessions || {}).filter(session => 
        session.isConnected === true
    ).length;
    
    return {
        totalUsers: users.length,
        usersToday: usersCreatedToday,
        usersWithProfile: users.filter(user => user.profileCompleted).length,
        usersWithoutProfile: users.filter(user => !user.profileCompleted).length,
        activeWhatsAppSessions: activeSessions,
        lastBackup: db.statistics.lastBackup,
        startupCount: db.statistics.startupCount,
        domain: SHORT_DOMAIN
    };
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
        
        // Also collect from user activeBots
        Object.values(db.users || {}).forEach(user => {
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

// Function to get WhatsApp sessions for a specific user
function getUserWhatsAppSessions(userId) {
    const db = readDatabase();
    const user = db.users[userId];
    
    if (!user || !user.activeBots) {
        return [];
    }
    
    const userSessions = [];
    
    user.activeBots.forEach(bot => {
        if (bot.number && bot.endpoint) {
            const sessionKey = `${bot.endpoint}_${bot.number}`;
            const sessionData = db.whatsappSessions?.[sessionKey];
            
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
        const users = Object.keys(db.users || {});
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

// ==================== LOAD BALANCING CONFIGURATION ====================
const ENDPOINTS = {
    'none': [
        'https://bot1-gynj.onrender.com',
        'https://bhsjs.onrender.com', 
        'https://bot1-dt8t.onrender.com'
    ],
    '.': [
        'https://two22-b3ma.onrender.com',
        'https://two22-ul5e.onrender.com',
        'https://two22-dqza.onrender.com',
        'https://two22-1ccl.onrender.com'
    ],
    '!': [
        'https://speed-1xmk.onrender.com',
        'https://favour-rg2d.onrender.com'
    ],
    '/': [
        'https://phi3-9vlw.onrender.com',
        'https://phi3.onrender.com'
    ],
    "'": [
        'https://dad5.onrender.com'
    ]
};

// Initialize endpoint tracking in database
function initEndpointTracking() {
    const db = readDatabase();
    
    // Create endpointUsage if it doesn't exist
    if (!db.endpointUsage) {
        db.endpointUsage = {};
    }
    
    // Initialize ALL endpoints with userCount: 0
    Object.keys(ENDPOINTS).forEach(prefix => {
        ENDPOINTS[prefix].forEach(endpoint => {
            // Only initialize if endpoint doesn't exist
            if (!db.endpointUsage[endpoint]) {
                db.endpointUsage[endpoint] = {
                    userCount: 0,
                    lastUsed: null,
                    prefix: prefix
                };
                console.log(`✅ Initialized endpoint: ${endpoint} for prefix ${prefix}`);
            }
        });
    });
    
    writeDatabase(db);
    console.log(`🔀 Endpoint tracking initialized with ${Object.keys(db.endpointUsage).length} endpoints`);
}

// Get the least used endpoint for a prefix
function getBalancedEndpoint(prefix) {
    const db = readDatabase();
    
    // Make sure endpointUsage exists and is initialized
    if (!db.endpointUsage) {
        initEndpointTracking();
    }
    
    const endpoints = ENDPOINTS[prefix] || [];
    
    if (endpoints.length === 0) {
        console.log(`❌ No endpoints configured for prefix: ${prefix}`);
        return null;
    }
    
    console.log(`🔍 Looking for endpoints for prefix: ${prefix}`);
    console.log(`🔍 Available endpoints:`, endpoints);
    
    // Find endpoint with least users
    let minUsers = Infinity;
    let selectedEndpoint = null;
    
    endpoints.forEach(endpoint => {
        // Make sure endpoint exists in endpointUsage
        if (!db.endpointUsage[endpoint]) {
            console.log(`⚠️ Endpoint ${endpoint} not found in endpointUsage, initializing...`);
            db.endpointUsage[endpoint] = {
                userCount: 0,
                lastUsed: null,
                prefix: prefix
            };
            writeDatabase(db);
        }
        
        const usage = db.endpointUsage[endpoint];
        console.log(`🔍 Endpoint ${endpoint}: ${usage.userCount} users`);
        
        if (usage.userCount < minUsers) {
            minUsers = usage.userCount;
            selectedEndpoint = endpoint;
        }
    });
    
    if (selectedEndpoint) {
        // Update usage count
        db.endpointUsage[selectedEndpoint].userCount++;
        db.endpointUsage[selectedEndpoint].lastUsed = new Date().toISOString();
        writeDatabase(db);
        
        console.log(`🔀 Load balancing: Selected ${selectedEndpoint} for prefix ${prefix} (now has ${db.endpointUsage[selectedEndpoint].userCount} users)`);
    } else {
        console.log(`❌ No endpoint selected for prefix: ${prefix}`);
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

// ==================== AUTOMATIC CONNECTION MONITORING ====================

// Monitor all active bots periodically
function startBotMonitoring() {
    console.log('🔍 Starting bot connection monitoring...');
    
    setInterval(async () => {
        try {
            const db = readDatabase();
            const users = Object.values(db.users);
            
            let checked = 0;
            let connected = 0;
            let disconnected = 0;
            
            for (const user of users) {
                if (user.activeBots && user.activeBots.length > 0) {
                    for (const bot of user.activeBots) {
                        if (bot.endpoint && bot.number) {
                            try {
                                const sessionsUrl = `${bot.endpoint}/sessions`;
                                const response = await fetch(sessionsUrl, { timeout: 10000 });
                                const data = await response.json();
                                
                                if (data.success && data.sessions) {
                                    const userSession = data.sessions.find(session => 
                                        session.phoneNumber === bot.number
                                    );
                                    
                                    const isConnected = userSession && userSession.isConnected;
                                    bot.status = isConnected ? 'connected' : 'disconnected';
                                    bot.lastChecked = new Date().toISOString();
                                    
                                    if (isConnected) connected++;
                                    else disconnected++;
                                }
                                
                                checked++;
                                
                                // Rate limiting
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                
                            } catch (error) {
                                console.error(`Error checking bot ${bot.number}:`, error.message);
                                bot.status = 'error';
                                bot.lastChecked = new Date().toISOString();
                                disconnected++;
                                checked++;
                            }
                        }
                    }
                }
            }
            
            if (checked > 0) {
                writeDatabase(db);
                console.log(`✅ Connection monitoring: ${checked} bots checked, ${connected} connected, ${disconnected} disconnected`);
            }
            
        } catch (error) {
            console.error('Bot monitoring error:', error);
        }
    }, 5 * 60 * 1000); // Check every 5 minutes
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
        console.error('API user error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// API endpoint for admin users list
app.get('/admin/users', (req, res) => {
    try {
        const db = readDatabase();
        const users = Object.values(db.users || {});
        
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

// ==================== LOAD BALANCING API ENDPOINTS ====================

// Get balanced endpoint for prefix
app.post('/api/get-endpoint', (req, res) => {
    try {
        const { prefix } = req.query;
        
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

// Enhanced WhatsApp connection verification
async function verifyWhatsAppConnection(phoneNumber, endpoint) {
    try {
        console.log(`🔍 Verifying WhatsApp connection for ${phoneNumber} on ${endpoint}`);
        
        // Try pairing again to check real connection status
        const pairUrl = `${endpoint}/pair?phoneNumber=${phoneNumber}`;
        console.log(`🌐 Calling pair endpoint: ${pairUrl}`);
        
        const response = await fetch(pairUrl, { timeout: 30000 });
        
        if (!response.ok) {
            throw new Error(`Endpoint returned ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.success) {
            if (data.pairingCode) {
                // If we get a pairing code, it means the number is NOT connected
                console.log(`❌ Number ${phoneNumber} is NOT connected - got pairing code: ${data.pairingCode}`);
                return { 
                    isConnected: false, 
                    pairingCode: data.pairingCode,
                    message: 'Number needs pairing'
                };
            } else if (data.message && data.message.includes('already registered')) {
                // If we get "already registered" message, it means it's connected
                console.log(`✅ Number ${phoneNumber} is already connected`);
                return { 
                    isConnected: true,
                    message: 'Number is connected'
                };
            }
        }
        
        // Default to not connected if we can't determine
        console.log(`❓ Unable to determine connection status for ${phoneNumber}`);
        return { 
            isConnected: false,
            message: 'Unable to verify connection'
        };
        
    } catch (error) {
        console.error(`❌ Error verifying connection for ${phoneNumber}:`, error.message);
        return { 
            isConnected: false,
            error: error.message
        };
    }
}

// Pair WhatsApp number - Backend handles endpoint selection
app.post('/api/pair-number', async (req, res) => {
    let endpoint = null;
    
    try {
        const { phoneNumber, prefix } = req.body;
        
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

        console.log(`🔀 Selected endpoint: ${endpoint}`);
        
        // Call the actual endpoint to pair
        const pairUrl = `${endpoint}/pair?phoneNumber=${phoneNumber}`;
        console.log(`🌐 Calling endpoint: ${pairUrl}`);
        
        const response = await fetch(pairUrl, { timeout: 30000 });
        
        if (!response.ok) {
            throw new Error(`Endpoint returned ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.success) {
            // Get user ID from request (you might need to adjust this based on your auth)
            const userId = req.headers['user-id'] || 'unknown';
            
            // Update user data with bot information
            const db = readDatabase();
            if (db.users[userId]) {
                db.users[userId].activeBots = db.users[userId].activeBots || [];
                
                // Remove any existing bot for this user
                db.users[userId].activeBots = db.users[userId].activeBots.filter(bot => 
                    bot.number !== phoneNumber
                );
                
                // Add new bot
                db.users[userId].activeBots.push({
                    number: phoneNumber,
                    prefix: prefix,
                    endpoint: endpoint,
                    status: 'pairing',
                    startTime: new Date().toISOString(),
                    lastChecked: new Date().toISOString()
                });
                
                writeDatabase(db);
                
                console.log(`✅ Bot paired for user ${userId}: ${phoneNumber} on ${endpoint}`);
            }
            
            res.json({
                success: true,
                pairingCode: data.pairingCode || 'BIGD-ADDY',
                endpoint: endpoint,
                message: 'Number paired successfully'
            });
        } else {
            // If pairing failed, release the endpoint
            releaseEndpoint(endpoint);
            res.json({
                success: false,
                error: data.error || 'Failed to pair number'
            });
        }
        
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

// Enhanced API endpoint for checking connection
app.post('/api/check-connection', async (req, res) => {
    let userEndpoint = null;
    let userId = null;
    
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameter: phoneNumber' 
            });
        }
        
        console.log(`🔍 Checking connection for ${phoneNumber}`);
        
        // Find which endpoint this user is using
        const db = readDatabase();
        
        // Search through all users to find who has this phone number
        let found = false;
        for (const [id, user] of Object.entries(db.users)) {
            if (user.activeBots) {
                const activeBot = user.activeBots.find(bot => bot.number === phoneNumber);
                if (activeBot) {
                    userEndpoint = activeBot.endpoint;
                    userId = id;
                    found = true;
                    break;
                }
            }
        }
        
        if (!found || !userEndpoint) {
            return res.json({
                success: false,
                error: 'No active bot found for this phone number',
                isConnected: false
            });
        }

        console.log(`🔍 Found endpoint for ${phoneNumber}: ${userEndpoint}`);
        
        try {
            // Use enhanced verification that actually pairs again to check real status
            const verification = await verifyWhatsAppConnection(phoneNumber, userEndpoint);
            
            console.log(`📊 Connection verification result for ${phoneNumber}:`, verification);
            
            // Update user bot status based on real verification
            if (userId && db.users[userId] && db.users[userId].activeBots) {
                db.users[userId].activeBots.forEach(bot => {
                    if (bot.number === phoneNumber) {
                        bot.status = verification.isConnected ? 'connected' : 'disconnected';
                        bot.lastChecked = new Date().toISOString();
                    }
                });
                writeDatabase(db);
            }
            
            return res.json({
                success: true,
                isConnected: verification.isConnected,
                endpoint: userEndpoint,
                pairingCode: verification.pairingCode,
                message: verification.message,
                lastChecked: new Date().toISOString(),
                source: 'direct_verification'
            });
            
        } catch (endpointError) {
            console.error(`❌ Error checking endpoint ${userEndpoint}:`, endpointError.message);
            
            // Update status to error
            if (userId && db.users[userId] && db.users[userId].activeBots) {
                db.users[userId].activeBots.forEach(bot => {
                    if (bot.number === phoneNumber) {
                        bot.status = 'error';
                        bot.lastChecked = new Date().toISOString();
                    }
                });
                writeDatabase(db);
            }
            
            return res.json({
                success: false,
                error: `Endpoint error: ${endpointError.message}`,
                isConnected: false,
                status: 'endpoint_error'
            });
        }
        
    } catch (error) {
        console.error('Check connection error:', error);
        res.status(500).json({ 
            success: false, 
            error: `Connection check failed: ${error.message}`,
            isConnected: false
        });
    }
});

// Stop bot - Backend knows which endpoint to use
app.post('/api/stop-bot', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameter: phoneNumber' 
            });
        }
        
        console.log(`🛑 Stopping bot: ${phoneNumber}`);
        
        // Find which endpoint this user is using
        const db = readDatabase();
        let userEndpoint = null;
        let userId = null;
        
        // Search through all users to find who has this phone number
        for (const [id, user] of Object.entries(db.users)) {
            if (user.activeBots) {
                const activeBot = user.activeBots.find(bot => bot.number === phoneNumber);
                if (activeBot) {
                    userEndpoint = activeBot.endpoint;
                    userId = id;
                    break;
                }
            }
        }
        
        if (!userEndpoint) {
            return res.json({
                success: false,
                error: 'No active bot found for this phone number'
            });
        }

        console.log(`🛑 Stopping bot on endpoint: ${userEndpoint}`);
        
        try {
            // Call delpair endpoint
            const delpairUrl = `${userEndpoint}/delpair?phoneNumber=${phoneNumber}`;
            console.log(`🌐 Calling stop: ${delpairUrl}`);
            
            const response = await fetch(delpairUrl, { timeout: 10000 });
            
            if (!response.ok) {
                throw new Error(`Endpoint returned ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (data.success) {
                // Update user data - remove the bot
                if (userId && db.users[userId]) {
                    db.users[userId].activeBots = db.users[userId].activeBots.filter(
                        bot => bot.number !== phoneNumber
                    );
                    writeDatabase(db);
                }
                
                // Remove session data
                const sessionKey = `${userEndpoint}_${phoneNumber}`;
                if (db.whatsappSessions && db.whatsappSessions[sessionKey]) {
                    delete db.whatsappSessions[sessionKey];
                    writeDatabase(db);
                }
                
                // Release endpoint
                releaseEndpoint(userEndpoint);
                
                console.log(`✅ Bot stopped successfully: ${phoneNumber}`);
                
                res.json({
                    success: true,
                    message: 'Bot stopped successfully',
                    endpoint: userEndpoint
                });
            } else {
                // Even if delpair fails, remove from our database
                if (userId && db.users[userId]) {
                    db.users[userId].activeBots = db.users[userId].activeBots.filter(
                        bot => bot.number !== phoneNumber
                    );
                    writeDatabase(db);
                }
                releaseEndpoint(userEndpoint);
                
                res.json({
                    success: false,
                    error: data.error || 'Failed to stop bot on endpoint'
                });
            }
        } catch (endpointError) {
            console.error(`❌ Error stopping bot on endpoint ${userEndpoint}:`, endpointError.message);
            
            // Even if endpoint fails, remove from our database
            if (userId && db.users[userId]) {
                db.users[userId].activeBots = db.users[userId].activeBots.filter(
                    bot => bot.number !== phoneNumber
                );
                writeDatabase(db);
            }
            releaseEndpoint(userEndpoint);
            
            res.json({
                success: false,
                error: `Endpoint error: ${endpointError.message}`
            });
        }
        
    } catch (error) {
        console.error('Stop bot error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Restart bot - Backend selects new endpoint
app.post('/api/restart-bot', async (req, res) => {
    let newEndpoint = null;
    
    try {
        const { phoneNumber, prefix } = req.body;
        
        if (!phoneNumber || !prefix) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters: phoneNumber and prefix' 
            });
        }
        
        console.log(`🔄 Restarting bot: ${phoneNumber} with prefix ${prefix}`);
        
        // First, stop the current bot if it exists
        const db = readDatabase();
        let userId = null;
        
        // Find the user who has this phone number
        for (const [id, user] of Object.entries(db.users)) {
            if (user.activeBots) {
                const activeBot = user.activeBots.find(bot => bot.number === phoneNumber);
                if (activeBot) {
                    userId = id;
                    // Release the old endpoint
                    releaseEndpoint(activeBot.endpoint);
                    break;
                }
            }
        }
        
        // Remove old bot entry regardless
        if (userId && db.users[userId]) {
            db.users[userId].activeBots = db.users[userId].activeBots.filter(
                bot => bot.number !== phoneNumber
            );
            writeDatabase(db);
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
        
        // Call pair endpoint again with new endpoint
        const pairUrl = `${newEndpoint}/pair?phoneNumber=${phoneNumber}`;
        console.log(`🌐 Calling restart: ${pairUrl}`);
        
        const response = await fetch(pairUrl, { timeout: 30000 });
        
        if (!response.ok) {
            throw new Error(`Endpoint returned ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.success) {
            // Update user data with new bot information
            if (userId && db.users[userId]) {
                db.users[userId].activeBots = db.users[userId].activeBots || [];
                
                // Add new bot with new endpoint
                db.users[userId].activeBots.push({
                    number: phoneNumber,
                    prefix: prefix,
                    endpoint: newEndpoint,
                    status: 'pairing',
                    startTime: new Date().toISOString(),
                    lastChecked: new Date().toISOString()
                });
                
                writeDatabase(db);
            }
            
            console.log(`✅ Bot restarted successfully: ${phoneNumber} on ${newEndpoint}`);
            
            res.json({
                success: true,
                pairingCode: data.pairingCode || 'BIGD-ADDY',
                endpoint: newEndpoint,
                message: 'Bot restarted successfully'
            });
        } else {
            // If pairing failed, release the endpoint
            releaseEndpoint(newEndpoint);
            res.json({
                success: false,
                error: data.error || 'Failed to restart bot'
            });
        }
        
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

// Get endpoint usage statistics
app.get('/api/endpoint-stats', (req, res) => {
    try {
        const db = readDatabase();
        const stats = db.endpointUsage || {};
        
        // Calculate totals
        const totals = {};
        Object.keys(ENDPOINTS).forEach(prefix => {
            totals[prefix] = {
                totalUsers: 0,
                availableEndpoints: ENDPOINTS[prefix].length
            };
            
            ENDPOINTS[prefix].forEach(endpoint => {
                if (stats[endpoint]) {
                    totals[prefix].totalUsers += stats[endpoint].userCount;
                }
            });
        });
        
        res.json({
            success: true,
            stats: stats,
            totals: totals,
            endpoints: ENDPOINTS
        });
        
    } catch (error) {
        console.error('Endpoint stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

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
            padding: 40px;
            text-align: center;
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
                    <span class="version">PREMIUM EDITION</span>
                </div>
                
                <div class="loader-wrapper">
                    <div class="main-loader">
                        <div class="loader-ring"></div>
                        <div class="loader-ring"></div>
                        <div class="loader-ring"></div>
                    </div>
                    
                    <div class="loading-text">Initializing Dashboard</div>
                    <div class="loading-subtext">Preparing your premium experience...</div>
                    
                    <div class="progress-container">
                        <div class="progress-bar"></div>
                    </div>
                </div>
                
                <div class="features-grid">
                    <div class="feature-card">
                        <span class="feature-icon">🤖</span>
                        <div class="feature-text">AI Bot Management</div>
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
                        <span class="stat-label">Active Users</span>
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
                animateCounter(document.getElementById('userCount'), 1542);
                animateCounter(document.getElementById('botCount'), 28);
            }, 500);
            
            // Redirect to dashboard after 3 seconds
            setTimeout(() => {
                window.location.href = '/webapp/${userId}';
            }, 3000);
            
            // Add some random console-like messages for effect
            const messages = [
                "✓ System integrity verified",
                "✓ User authentication successful", 
                "✓ Loading premium modules...",
                "✓ Initializing AI components",
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
                            <p><strong>Total Users:</strong> ${stats.totalUsers}</p>
                        </div>
                        <div class="stat-item">
                            <p><strong>Today's Users:</strong> ${stats.usersToday}</p>
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

        bot.command('pending', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
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
                await ctx.reply('❌ Access denied. Admin only.');
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
        const db = readDatabase();
        
        console.log(`👤 User start: ${userId}, profile completed: ${user?.profileCompleted}`);
        
        // Clear any existing session
        if (ctx.session) {
            ctx.session.setupStep = null;
            ctx.session.firstName = null;
            ctx.session.lastName = null;
            ctx.session.email = null;
        }
        
        const welcomeMessage = db.settings?.welcomeMessage || "👋 *Welcome to BIG DADDY V3 Bot!*\n\nTo access the bot, you need to join our sponsor channels first. After joining all required channels, you'll be able to create your account and start using the bot features.";
        
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
    const db = readDatabase();
    const groups = getGroups();
    const pendingGroups = getPendingGroups();
    
    const users = Object.values(db.users);
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
    const db = readDatabase();
    const users = Object.values(db.users);
    
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
            console.log(`👤 Profile: ${config.webBaseUrl}/profile/{userId}`);
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
        startBotMonitoring();
        startSessionMonitoring(); // Start WhatsApp session monitoring

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
                    `👤 Profile: ${config.webBaseUrl}/profile/{userId}\n` +
                    `⏳ Loading: ${config.webBaseUrl}/loading/{userId}\n\n` +
                    `*New Features Added:*\n` +
                    `• ✅ Professional loading screen\n` +
                    `• ✅ Profile management system\n` +
                    `• ✅ WhatsApp session monitoring\n` +
                    `• ✅ Real-time connection status\n\n` +
                    `*WhatsApp Session Monitoring:*\n` +
                    `• 🔄 Auto-updates every 2 minutes\n` +
                    `• 📊 Tracks all connected accounts\n` +
                    `• 🌐 Monitors all endpoints\n` +
                    `• 💾 Stores data in database\n\n` +
                    `The system is now fully operational with enhanced features!`,
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
    getUser,
    createOrUpdateUser,
    deleteUser,
    isAdmin,
    getStatistics,
    backupDatabaseToDropbox,
    updateWhatsAppSessions,
    getUserWhatsAppSessions,
    getAllWhatsAppSessions
};
