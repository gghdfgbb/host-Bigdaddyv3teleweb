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
                pendingGroups: [], // Groups waiting for admin approval
                membershipChecks: {},
                version: '3.1'
            };
            fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
            console.log('✅ Database initialized');
        } else {
            const db = readDatabase();
            if (!db.settings) db.settings = {};
            if (!db.settings.webWelcomeMessage) db.settings.webWelcomeMessage = "🎉 Welcome to your dashboard!";
            if (!db.settings.welcomeMessage) db.settings.welcomeMessage = "👋 *Welcome to BIG DADDY V3 Bot!*\n\nI see you're new here! To get started, I need a few details from you:\n\n1. 👤 Your Full Name\n2. 📧 Your Email Address\n\nLet's create your account:";
            if (!db.settings.adminWelcomeMessage) db.settings.adminWelcomeMessage = "👑 *Welcome to Admin Panel*\n\nManage your bot users and monitor statistics.";
            if (!db.groups) db.groups = [];
            if (!db.pendingGroups) db.pendingGroups = [];
            if (!db.membershipChecks) db.membershipChecks = {};
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
        return { users: {}, settings: {}, statistics: {}, backups: [], groups: [], pendingGroups: [], membershipChecks: {} };
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

// Web App Dashboard Route (For Telegram Web App)
app.get('/webapp/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        
        if (userId === ADMIN_CHAT_ID) {
            return res.send(generateAdminDashboard());
        }
        
        if (!checkUserAccess(userId)) {
            return res.send(generateAccessDeniedPage(userId));
        }
        
        if (!user || !user.profileCompleted) {
            return res.send(generateSetupRequiredPage());
        }

        return res.send(generateUserDashboard(user));
        
    } catch (error) {
        console.error('Web App error:', error);
        res.status(500).send('Internal server error');
    }
});

function generateAccessDeniedPage(userId) {
    const groups = getGroups();
    
    let groupsList = '';
    groups.forEach(group => {
        groupsList += `<li>${group.title} (${group.type})</li>`;
    });
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V3 - Access Denied</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
                margin: 0;
                padding: 20px;
                min-height: 100vh;
                color: white;
                text-align: center;
            }
            .container {
                max-width: 500px;
                margin: 50px auto;
                background: rgba(255,255,255,0.1);
                backdrop-filter: blur(10px);
                padding: 30px;
                border-radius: 20px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.3);
            }
            .logo {
                font-size: 24px;
                font-weight: bold;
                margin-bottom: 20px;
            }
            .groups-list {
                text-align: left;
                background: rgba(255,255,255,0.1);
                padding: 20px;
                border-radius: 10px;
                margin: 20px 0;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="logo">🔒 BIG DADDY V3</div>
            <h2>Access Restricted</h2>
            <p>To access your dashboard, you need to join all our sponsor groups/channels.</p>
            
            <div class="groups-list">
                <h3>Required Sponsors:</h3>
                <ul>
                    ${groupsList || '<li>No sponsors configured</li>'}
                </ul>
            </div>
            
            <p>Please join all sponsors above and then return to the Telegram bot to verify your membership.</p>
        </div>
    </body>
    </html>
    `;
}

function generateAdminDashboard() {
    const stats = getStatistics();
    const db = readDatabase();
    const users = Object.values(db.users);
    const groups = getGroups();
    const pendingGroups = getPendingGroups();
    
    const recentUsers = users
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10);
    
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
    </div>
    ` : '';
    
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
    </div>
    `;
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V3 - Admin Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%);
                margin: 0;
                padding: 20px;
                min-height: 100vh;
                color: white;
            }
            .container {
                max-width: 800px;
                margin: 0 auto;
            }
            .header {
                text-align: center;
                margin-bottom: 30px;
            }
            .logo {
                font-size: 28px;
                font-weight: bold;
                margin-bottom: 10px;
                color: #f39c12;
            }
            .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 15px;
                margin-bottom: 30px;
            }
            .stat-card {
                background: rgba(255,255,255,0.1);
                padding: 20px;
                border-radius: 15px;
                text-align: center;
                backdrop-filter: blur(10px);
            }
            .stat-number {
                font-size: 24px;
                font-weight: bold;
                color: #f39c12;
            }
            .users-list {
                background: rgba(255,255,255,0.1);
                border-radius: 15px;
                padding: 20px;
                margin-bottom: 20px;
                backdrop-filter: blur(10px);
            }
            .user-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px;
                border-bottom: 1px solid rgba(255,255,255,0.1);
            }
            .user-info {
                flex: 1;
            }
            .user-actions {
                display: flex;
                gap: 10px;
            }
            .btn {
                padding: 8px 15px;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-size: 12px;
            }
            .btn-danger {
                background: #e74c3c;
                color: white;
            }
            .btn-primary {
                background: #3498db;
                color: white;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="logo">👑 BIG DADDY V3 - ADMIN</div>
                <p>Administrative Control Panel</p>
            </div>
            
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-number">${stats.totalUsers}</div>
                    <div>Total Users</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${stats.usersToday}</div>
                    <div>Today's Users</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${stats.usersWithProfile}</div>
                    <div>Completed Profiles</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${stats.startupCount}</div>
                    <div>System Boots</div>
                </div>
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
            function refreshData() {
                location.reload();
            }
            
            function closeWebApp() {
                if (window.Telegram && Telegram.WebApp) {
                    Telegram.WebApp.close();
                } else {
                    window.close();
                }
            }
            
            function viewUser(userId) {
                alert('View user: ' + userId);
            }
            
            function deleteUser(userId) {
                if (confirm('Are you sure you want to delete user ' + userId + '?')) {
                    fetch('/admin/delete-user/' + userId, { method: 'DELETE' })
                        .then(response => response.json())
                        .then(data => {
                            if (data.success) {
                                alert('User deleted successfully');
                                location.reload();
                            } else {
                                alert('Error: ' + data.error);
                            }
                        });
                }
            }
            
            function removeGroup(groupId) {
                if (confirm('Are you sure you want to remove this sponsor?')) {
                    fetch('/admin/remove-group/' + groupId, { method: 'DELETE' })
                        .then(response => response.json())
                        .then(data => {
                            if (data.success) {
                                alert('Sponsor removed successfully');
                                location.reload();
                            } else {
                                alert('Error: ' + data.error);
                            }
                        });
                }
            }
            
            function approveGroup(groupId) {
                if (confirm('Are you sure you want to approve this sponsor?')) {
                    fetch('/admin/approve-group/' + groupId, { method: 'POST' })
                        .then(response => response.json())
                        .then(data => {
                            if (data.success) {
                                alert('Sponsor approved successfully');
                                location.reload();
                            } else {
                                alert('Error: ' + data.error);
                            }
                        });
                }
            }
            
            function rejectGroup(groupId) {
                if (confirm('Are you sure you want to reject this sponsor?')) {
                    fetch('/admin/reject-group/' + groupId, { method: 'DELETE' })
                        .then(response => response.json())
                        .then(data => {
                            if (data.success) {
                                alert('Sponsor rejected successfully');
                                location.reload();
                            } else {
                                alert('Error: ' + data.error);
                            }
                        });
                }
            }
            
            if (window.Telegram && Telegram.WebApp) {
                Telegram.WebApp.ready();
                Telegram.WebApp.expand();
            }
        </script>
    </body>
    </html>
    `;
}

function generateSetupRequiredPage() {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V3 - Setup Required</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                margin: 0;
                padding: 20px;
                min-height: 100vh;
                color: white;
                text-align: center;
            }
            .container {
                max-width: 400px;
                margin: 50px auto;
                background: rgba(255,255,255,0.1);
                backdrop-filter: blur(10px);
                padding: 30px;
                border-radius: 20px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.3);
            }
            .logo {
                font-size: 24px;
                font-weight: bold;
                margin-bottom: 20px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="logo">🚀 BIG DADDY V3</div>
            <h2>Setup Required</h2>
            <p>Please complete your profile setup in the Telegram bot to access your dashboard.</p>
            <p>Go back to the bot and provide your name and email address.</p>
        </div>
    </body>
    </html>
    `;
}

function generateUserDashboard(user) {
    const db = readDatabase();
    const welcomeMessage = db.settings?.webWelcomeMessage || "🎉 Welcome to your dashboard!";
    
    const firstName = user.firstName || 'User';
    const lastName = user.lastName || '';
    const email = user.email || 'Not provided';
    const memberSince = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'Recently';
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>BIG DADDY V3 Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                margin: 0;
                padding: 20px;
                min-height: 100vh;
                color: white;
            }
            .container {
                max-width: 400px;
                margin: 0 auto;
                background: rgba(255,255,255,0.1);
                backdrop-filter: blur(10px);
                padding: 25px;
                border-radius: 20px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.3);
            }
            .header {
                text-align: center;
                margin-bottom: 25px;
            }
            .logo {
                font-size: 24px;
                font-weight: bold;
                margin-bottom: 10px;
            }
            .welcome {
                font-size: 18px;
                margin-bottom: 20px;
                text-align: center;
            }
            .user-card {
                background: rgba(255,255,255,0.15);
                padding: 20px;
                border-radius: 15px;
                margin-bottom: 20px;
            }
            .user-info {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .info-item {
                display: flex;
                justify-content: space-between;
                padding: 8px 0;
                border-bottom: 1px solid rgba(255,255,255,0.1);
            }
            .info-label {
                font-weight: bold;
                min-width: 120px;
            }
            .info-value {
                text-align: right;
                flex: 1;
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
                border-radius: 12px;
                text-align: center;
            }
            .actions {
                display: flex;
                gap: 10px;
                justify-content: center;
                margin-top: 20px;
            }
            .btn {
                background: #4CAF50;
                color: white;
                border: none;
                padding: 12px 20px;
                border-radius: 10px;
                cursor: pointer;
                font-size: 14px;
                flex: 1;
            }
            .btn-close {
                background: #e74c3c;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="logo">🚀 BIG DADDY V3</div>
                <div class="welcome">${welcomeMessage}</div>
            </div>
            
            <div class="user-card">
                <div class="user-info">
                    <div class="info-item">
                        <span class="info-label">👤 Name:</span>
                        <span class="info-value"><strong>${firstName} ${lastName}</strong></span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">📧 Email:</span>
                        <span class="info-value">${email}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">🆔 User ID:</span>
                        <span class="info-value">${user.id}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">📅 Member since:</span>
                        <span class="info-value">${memberSince}</span>
                    </div>
                </div>
            </div>
            
            <div class="stats">
                <div class="stat-item">
                    <div>🌐 Server</div>
                    <div><strong>${SHORT_DOMAIN}</strong></div>
                </div>
                <div class="stat-item">
                    <div>✅ Status</div>
                    <div><strong>Active</strong></div>
                </div>
            </div>
            
            <div class="actions">
                <button class="btn" onclick="refreshData()">🔄 Refresh</button>
                <button class="btn btn-close" onclick="closeWebApp()">❌ Close</button>
            </div>
        </div>
        
        <script>
            function refreshData() {
                location.reload();
            }
            
            function closeWebApp() {
                if (window.Telegram && Telegram.WebApp) {
                    Telegram.WebApp.close();
                } else {
                    window.close();
                }
            }
            
            if (window.Telegram && Telegram.WebApp) {
                Telegram.WebApp.ready();
                Telegram.WebApp.expand();
            }
        </script>
    </body>
    </html>
    `;
}

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

        // Manual channel addition command
        bot.command('addchannel', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.reply('❌ Access denied. Admin only.');
                return;
            }
            
            const args = ctx.message.text.split(' ').slice(1);
            if (args.length < 2) {
                await ctx.reply(
                    '📝 To add a channel manually:\n\n' +
                    'Usage: `/addchannel @channel_username Channel Name`\n\n' +
                    'Example: `/addchannel @my_channel My Awesome Channel`\n\n' +
                    '💡 *Important:* For channel verification to work:\n' +
                    '1. Make the bot an ADMIN in the channel\n' +
                    '2. Enable "View Messages" permission for the bot\n' +
                    '3. The channel must be public or the bot needs invite rights',
                    { parse_mode: 'Markdown' }
                );
                return;
            }
            
            const channelUsername = args[0].replace('@', '');
            const channelName = args.slice(1).join(' ');
            
            // Create channel data with proper link
            const channelData = {
                id: `-100${Math.random().toString().slice(2, 11)}`, // Generate fake channel ID
                title: channelName,
                username: channelUsername,
                inviteLink: `https://t.me/${channelUsername}`,
                type: 'channel',
                addedAt: new Date().toISOString(),
                isActive: true,
                approvedBy: ADMIN_CHAT_ID,
                isManual: true
            };
            
            const success = await addGroupWithInvite(channelData);
            
            if (success) {
                await ctx.reply(
                    `✅ *Channel Added Successfully!*\n\n` +
                    `📝 *Name:* ${channelName}\n` +
                    `🔗 *Username:* @${channelUsername}\n` +
                    `🌐 *Link:* https://t.me/${channelUsername}\n\n` +
                    `⚠️ *Important Setup Required:*\n` +
                    `1. Make the bot an ADMIN in @${channelUsername}\n` +
                    `2. Enable "View Messages" permission\n` +
                    `3. Users will need to join this channel\n\n` +
                    `Without admin rights, membership verification will not work.`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await ctx.reply('❌ Channel already exists in the list.');
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

        // Create account process - FIXED VERSION
        bot.action('create_account', async (ctx) => {
            try {
                await ctx.answerCbQuery();
                const userId = ctx.from.id.toString();
                
                console.log(`📝 Create account initiated for ${userId}`);
                
                if (!ctx.session) {
                    ctx.session = {};
                    console.log(`🆕 Created new session for ${userId}`);
                }
                
                ctx.session.setupStep = 'asking_first_name';
                console.log(`🔀 Set setupStep to: asking_first_name for ${userId}`);
                
                await ctx.reply('👤 Please enter your *First Name*:', { parse_mode: 'Markdown' });
                
            } catch (error) {
                console.error('❌ Create account error:', error);
                await ctx.answerCbQuery('❌ Error starting registration');
            }
        });

        // Update profile
        bot.action('update_profile', async (ctx) => {
            try {
                await ctx.answerCbQuery();
                const userId = ctx.from.id.toString();
                
                console.log(`✏️ Update profile initiated for ${userId}`);
                
                if (!ctx.session) {
                    ctx.session = {};
                    console.log(`🆕 Created new session for ${userId}`);
                }
                
                ctx.session.setupStep = 'asking_first_name';
                console.log(`🔀 Set setupStep to: asking_first_name for ${userId}`);
                
                await ctx.reply('Let\'s update your profile. Please enter your *First Name*:', { parse_mode: 'Markdown' });
            } catch (error) {
                console.error('❌ Update profile error:', error);
                await ctx.answerCbQuery('❌ Error starting profile update');
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
// ==================== ENHANCED DEBUG TEXT MESSAGE HANDLER ====================
bot.on('text', async (ctx) => {
    try {
        const userId = ctx.from.id.toString();
        const text = ctx.message.text.trim();
        const chatType = ctx.chat?.type;
        
        console.log(`🔍 TEXT HANDLER TRIGGERED - User: ${userId}, Text: "${text}", Chat: ${chatType}`);
        
        // Ignore commands - IMPORTANT: This must be first
        if (text.startsWith('/')) {
            console.log(`⚡ Ignoring command: ${text}`);
            return;
        }
        
        // Skip group messages
        if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') {
            console.log(`👥 Ignoring group message from ${chatType}`);
            return;
        }
        
        // Ensure session exists with enhanced debugging
        if (!ctx.session) {
            console.log(`❌ NO SESSION FOUND - Creating new session for ${userId}`);
            ctx.session = {};
        } else {
            console.log(`✅ SESSION EXISTS - setupStep: ${ctx.session.setupStep || 'none'}`);
        }
        
        console.log(`🔍 CURRENT SESSION STATE:`, {
            setupStep: ctx.session.setupStep,
            firstName: ctx.session.firstName,
            lastName: ctx.session.lastName,
            email: ctx.session.email
        });
        
        // Handle profile setup steps
        if (ctx.session.setupStep === 'asking_first_name') {
            console.log(`👤 PROCESSING FIRST NAME: "${text}"`);
            
            if (!text || text.length < 2) {
                await ctx.reply('❌ Please enter a valid first name (at least 2 characters):');
                return;
            }
            
            ctx.session.firstName = text;
            ctx.session.setupStep = 'asking_last_name';
            console.log(`✅ FIRST NAME SET: "${text}", MOVING TO LAST NAME STEP`);
            
            await ctx.reply('👤 Great! Now please enter your *Last Name*:', { parse_mode: 'Markdown' });
            
        } else if (ctx.session.setupStep === 'asking_last_name') {
            console.log(`👤 PROCESSING LAST NAME: "${text}"`);
            
            if (!text || text.length < 2) {
                await ctx.reply('❌ Please enter a valid last name (at least 2 characters):');
                return;
            }
            
            ctx.session.lastName = text;
            ctx.session.setupStep = 'asking_email';
            console.log(`✅ LAST NAME SET: "${text}", MOVING TO EMAIL STEP`);
            
            await ctx.reply('📧 Perfect! Now please enter your *Email Address*:', { parse_mode: 'Markdown' });
            
        } else if (ctx.session.setupStep === 'asking_email') {
            console.log(`📧 PROCESSING EMAIL: "${text}"`);
            
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(text)) {
                await ctx.reply('❌ Please enter a valid email address (e.g., example@gmail.com):');
                return;
            }
            
            ctx.session.email = text;
            console.log(`✅ EMAIL SET: "${text}", COMPLETING REGISTRATION`);
            
            // Save user profile
            const success = setUserProfile(userId, ctx.session.firstName, ctx.session.lastName, ctx.session.email);
            
            if (success) {
                console.log(`✅ USER PROFILE SAVED SUCCESSFULLY for ${userId}`);
                
                await ctx.reply(
                    `✅ *Account Created Successfully!*\n\n` +
                    `📛 *Name:* ${ctx.session.firstName} ${ctx.session.lastName}\n` +
                    `📧 *Email:* ${ctx.session.email}\n\n` +
                    `You can now access your dashboard:`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.webApp('🚀 Open Dashboard', `${config.webBaseUrl}/webapp/${userId}`)]
                        ])
                    }
                );
                
                // Notify admin
                if (bot) {
                    const stats = getStatistics();
                    await bot.telegram.sendMessage(
                        ADMIN_CHAT_ID,
                        `👤 *New User Registered*\n\n📛 Name: ${ctx.session.firstName} ${ctx.session.lastName}\n📧 Email: ${ctx.session.email}\n🆔 User ID: ${userId}\n\n📊 Total Users: ${stats.totalUsers}\n📈 Today: ${stats.usersToday}`,
                        { parse_mode: 'Markdown' }
                    );
                }
            } else {
                console.error(`❌ FAILED TO SAVE USER PROFILE for ${userId}`);
                await ctx.reply('❌ Sorry, there was an error creating your account. Please try again.');
            }
            
            // Clear session
            console.log(`🧹 CLEARING SESSION for ${userId}`);
            ctx.session.setupStep = null;
            ctx.session.firstName = null;
            ctx.session.lastName = null;
            ctx.session.email = null;
            
        } else {
            console.log(`ℹ️ TEXT RECEIVED BUT NO ACTIVE REGISTRATION STEP: "${text}"`);
            console.log(`ℹ️ Current setupStep: ${ctx.session.setupStep || 'undefined'}`);
            
            // If user sends text but we're not in registration mode, guide them
            if (!ctx.session.setupStep) {
                await ctx.reply(
                    '👋 Hello! To get started, please use the menu or click "Create Account" to begin registration.',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('📝 Create Account', 'create_account')]
                    ])
                );
            }
        }
        
    } catch (error) {
        console.error('❌ TEXT HANDLER ERROR:', error);
        console.error('❌ Error stack:', error.stack);
        
        await ctx.reply('❌ Sorry, an error occurred. Please try again.');
        
        // Clear session on error
        if (ctx.session) {
            console.log(`🧹 CLEARING SESSION DUE TO ERROR for ${ctx.from.id}`);
            ctx.session.setupStep = null;
            ctx.session.firstName = null;
            ctx.session.lastName = null;
            ctx.session.email = null;
        }
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
        
        const welcomeMessage = db.settings?.welcomeMessage || "👋 *Welcome to BIG DADDY V3 Bot!*\n\nI see you're new here! To get started, I need a few details from you:\n\n1. 👤 Your Full Name\n2. 📧 Your Email Address\n\nLet's create your account:";
        
        if (user && user.profileCompleted) {
            // Existing user with completed profile - check membership
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
            // NEW USER or incomplete profile - allow registration without membership check
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
        
        console.log('🔄 Checking for Dropbox backup...');
        await restoreDatabaseFromDropbox();
        
        const server = app.listen(config.webPort, '0.0.0.0', () => {
            console.log(`✅ Web server running on port ${config.webPort}`);
            console.log(`📊 Dashboard: ${config.webBaseUrl}`);
            console.log(`👑 Admin Panel: ${config.webBaseUrl}/webapp/${ADMIN_CHAT_ID}`);
            console.log(`🏥 Health: ${config.webBaseUrl}/health`);
            console.log(`connecting to bigdaddy database`);
            console.log(`database connected bigdaddyv3`);
        });

        startAutoPing();
        startAutoBackup();
        startMemoryCleanup();
        startMembershipMonitoring();

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
                    `👑 Admin Panel: ${config.webBaseUrl}/webapp/${ADMIN_CHAT_ID}\n\n` +
                    `*Fixed Features:*\n` +
                    `• ✅ Fixed registration flow with proper session management\n` +
                    `• ✅ Enhanced text message handler with debugging\n` +
                    `• ✅ Proper step progression (First Name → Last Name → Email)\n` +
                    `• ✅ Comprehensive error handling and session cleanup\n\n` +
                    `The registration system is now working perfectly!`,
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
    backupDatabaseToDropbox
};
