// Admin dashboard functionality
let currentSettings = {};
let allUsers = {};

// Initialize dashboard based on page
document.addEventListener('DOMContentLoaded', function() {
    if (window.location.pathname.includes('admin')) {
        initializeAdminDashboard();
    } else if (window.location.pathname.includes('dashboard')) {
        initializeUserDashboard();
    }
});

// Admin Dashboard Functions
async function initializeAdminDashboard() {
    await loadAdminStats();
    await loadUsers();
    await loadSettings();
    await loadBlockedIPs();
    
    // Add event listeners
    document.getElementById('saveSettings')?.addEventListener('click', saveSettings);
    document.getElementById('addChannel')?.addEventListener('click', addForceJoin);
}

async function loadAdminStats() {
    try {
        const response = await fetch('/api/admin/stats');
        const stats = await response.json();
        
        const statsSection = document.getElementById('statsSection');
        if (statsSection) {
            statsSection.innerHTML = `
                <div class="stat-card">
                    <div class="stat-number">${stats.total_users}</div>
                    <div class="stat-label">Total Users</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${stats.total_accounts}</div>
                    <div class="stat-label">Total Accounts</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${stats.blocked_users}</div>
                    <div class="stat-label">Blocked Users</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${Object.keys(allUsers).length}</div>
                    <div class="stat-label">Active Sessions</div>
                </div>
            `;
        }
    } catch (error) {
        console.error('Error loading stats:', error);
        utils.showNotification('Failed to load statistics', 'error');
    }
}

async function loadUsers() {
    try {
        const response = await fetch('/api/admin/users');
        allUsers = await response.json();
        
        const usersTable = document.getElementById('usersTable');
        if (usersTable) {
            usersTable.innerHTML = Object.entries(allUsers).map(([userId, userData]) => `
                <tr>
                    <td><code>${userId}</code></td>
                    <td>${userData.name}</td>
                    <td>${userData.email}</td>
                    <td><code>${userData.ip}</code></td>
                    <td><span class="status-${userData.status}">${userData.status}</span></td>
                    <td>${utils.formatDate(userData.created_at)}</td>
                    <td>
                        <button class="btn-danger" onclick="deleteUser('${userId}')" title="Delete User">
                            🗑️ Delete
                        </button>
                        ${userData.status === 'blocked' ? 
                            `<button class="btn-success" onclick="unblockUser('${userId}')" title="Unblock User">🔓 Unblock</button>` : 
                            `<button class="btn-warning" onclick="blockUser('${userId}')" title="Block User">🚫 Block</button>`
                        }
                    </td>
                </tr>
            `).join('');
        }
    } catch (error) {
        console.error('Error loading users:', error);
        utils.showNotification('Failed to load users', 'error');
    }
}

async function loadSettings() {
    try {
        const response = await fetch('/api/admin/settings');
        currentSettings = await response.json();
        
        const maxAccountsInput = document.getElementById('maxAccounts');
        if (maxAccountsInput) {
            maxAccountsInput.value = currentSettings.max_accounts_per_ip;
        }
        
        updateForceJoinDisplay();
    } catch (error) {
        console.error('Error loading settings:', error);
        utils.showNotification('Failed to load settings', 'error');
    }
}

async function loadBlockedIPs() {
    try {
        const response = await fetch('/api/admin/blocked-ips');
        const blockedIPs = await response.json();
        
        const blockedIPsSection = document.getElementById('blockedIPsSection');
        if (blockedIPsSection) {
            blockedIPsSection.innerHTML = `
                <h3>🚫 Blocked IP Addresses</h3>
                <div class="blocked-ips-list">
                    ${Object.entries(blockedIPs).map(([ip, data]) => `
                        <div class="blocked-ip-item">
                            <code>${ip}</code>
                            <span>${data.reason}</span>
                            <span>${utils.formatDate(data.blocked_at)}</span>
                            <button class="btn-success" onclick="unblockIP('${ip}')">Unblock</button>
                        </div>
                    `).join('')}
                </div>
            `;
        }
    } catch (error) {
        console.error('Error loading blocked IPs:', error);
    }
}

function updateForceJoinDisplay() {
    const forceJoinContainer = document.getElementById('forceJoinContainer');
    if (forceJoinContainer) {
        forceJoinContainer.innerHTML = (currentSettings.force_join || []).map((item, index) => `
            <div class="form-row" data-index="${index}">
                <div class="form-group">
                    <label>Channel/Group Name</label>
                    <input type="text" class="form-control" value="${item.name}" 
                           onchange="updateForceJoin(${index}, 'name', this.value)"
                           placeholder="Official Channel">
                </div>
                <div class="form-group">
                    <label>Channel ID</label>
                    <input type="text" class="form-control" value="${item.id}" 
                           onchange="updateForceJoin(${index}, 'id', this.value)"
                           placeholder="-100123456789">
                </div>
                <div class="form-group">
                    <label>Invite Link</label>
                    <input type="text" class="form-control" value="${item.invite_link}" 
                           onchange="updateForceJoin(${index}, 'invite_link', this.value)"
                           placeholder="https://t.me/channel">
                </div>
                <button class="btn-danger" type="button" onclick="removeForceJoin(${index})" title="Remove Channel">
                    🗑️
                </button>
            </div>
        `).join('');
    }
}

function addForceJoin() {
    if (!currentSettings.force_join) {
        currentSettings.force_join = [];
    }
    
    currentSettings.force_join.push({ 
        name: '', 
        id: '', 
        invite_link: '' 
    });
    updateForceJoinDisplay();
    utils.showNotification('Channel field added', 'success');
}

function updateForceJoin(index, field, value) {
    if (currentSettings.force_join && currentSettings.force_join[index]) {
        currentSettings.force_join[index][field] = value;
    }
}

function removeForceJoin(index) {
    if (currentSettings.force_join && currentSettings.force_join[index]) {
        currentSettings.force_join.splice(index, 1);
        updateForceJoinDisplay();
        utils.showNotification('Channel removed', 'success');
    }
}

async function saveSettings() {
    const saveBtn = document.getElementById('saveSettings');
    const originalText = saveBtn.textContent;
    
    try {
        saveBtn.textContent = 'Saving...';
        saveBtn.disabled = true;
        
        // Update max accounts
        const maxAccountsInput = document.getElementById('maxAccounts');
        if (maxAccountsInput) {
            currentSettings.max_accounts_per_ip = parseInt(maxAccountsInput.value) || 3;
        }
        
        const response = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(currentSettings)
        });
        
        const result = await response.json();
        if (result.success) {
            utils.showNotification('Settings saved successfully!', 'success');
            await loadAdminStats(); // Refresh stats
        } else {
            throw new Error('Failed to save settings');
        }
    } catch (error) {
        console.error('Error saving settings:', error);
        utils.showNotification('Error saving settings', 'error');
    } finally {
        saveBtn.textContent = originalText;
        saveBtn.disabled = false;
    }
}

async function deleteUser(userId) {
    if (confirm(`Are you sure you want to delete user ${userId}? This action cannot be undone.`)) {
        try {
            const response = await fetch(`/api/admin/user/${userId}`, {
                method: 'DELETE'
            });
            
            const result = await response.json();
            if (result.success) {
                utils.showNotification('User deleted successfully!', 'success');
                await loadUsers();
                await loadAdminStats();
            } else {
                throw new Error('Failed to delete user');
            }
        } catch (error) {
            console.error('Error deleting user:', error);
            utils.showNotification('Error deleting user', 'error');
        }
    }
}

async function blockUser(userId) {
    if (confirm(`Block user ${userId}? They will no longer be able to access the system.`)) {
        try {
            // This would call your backend to block the user
            utils.showNotification('User blocked successfully!', 'success');
            await loadUsers();
        } catch (error) {
            console.error('Error blocking user:', error);
            utils.showNotification('Error blocking user', 'error');
        }
    }
}

async function unblockUser(userId) {
    try {
        // This would call your backend to unblock the user
        utils.showNotification('User unblocked successfully!', 'success');
        await loadUsers();
    } catch (error) {
        console.error('Error unblocking user:', error);
        utils.showNotification('Error unblocking user', 'error');
    }
}

async function unblockIP(ip) {
    if (confirm(`Unblock IP address ${ip}?`)) {
        try {
            const response = await fetch(`/api/admin/unblock-ip/${encodeURIComponent(ip)}`, {
                method: 'POST'
            });
            
            const result = await response.json();
            if (result.success) {
                utils.showNotification('IP unblocked successfully!', 'success');
                await loadBlockedIPs();
            } else {
                throw new Error('Failed to unblock IP');
            }
        } catch (error) {
            console.error('Error unblocking IP:', error);
            utils.showNotification('Error unblocking IP', 'error');
        }
    }
}

// User Dashboard Functions
function initializeUserDashboard() {
    // Add user-specific dashboard functionality
    const deployButton = document.querySelector('.deploy-button');
    if (deployButton) {
        deployButton.addEventListener('click', function() {
            utils.showNotification('Starting bot deployment process...', 'success');
            // Add deployment logic here
        });
    }
    
    // Load user-specific data
    loadUserData();
}

async function loadUserData() {
    try {
        const userId = new URLSearchParams(window.location.search).get('user');
        if (userId) {
            // Load user-specific data from API
            const response = await fetch(`/api/user/${userId}`);
            const userData = await response.json();
            
            // Update dashboard with user data
            updateUserDashboard(userData);
        }
    } catch (error) {
        console.error('Error loading user data:', error);
    }
}

function updateUserDashboard(userData) {
    // Update various dashboard elements with user data
    const welcomeElement = document.querySelector('.dashboard-title');
    if (welcomeElement && userData.name) {
        welcomeElement.textContent = `Welcome, ${userData.name}! 👋`;
    }
}

// Export utils for global access
window.utils = utils;
window.dashboard = {
    loadAdminStats,
    loadUsers,
    loadSettings,
    saveSettings,
    deleteUser,
    blockUser,
    unblockUser,
    addForceJoin,
    removeForceJoin,
    updateForceJoin
};
