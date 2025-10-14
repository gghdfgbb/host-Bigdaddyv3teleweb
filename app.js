const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ==================== CONFIGURATION ====================
const PORT = process.env.PORT || 3000;

// Auto-detect Render domain
function getWebDomain() {
    if (process.env.RENDER_EXTERNAL_URL) {
        return process.env.RENDER_EXTERNAL_URL;
    }
    if (process.env.RENDER_SERVICE_NAME) {
        return `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
    }
    return `http://localhost:${PORT}`;
}

const WEB_DOMAIN = getWebDomain();

console.log('🚀 Starting Big Daddy V3 Web Server...');
console.log('🌐 Domain:', WEB_DOMAIN);
console.log('🔧 Port:', PORT);

const app = express();

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enhanced CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    console.log(`📡 ${req.method} ${req.path} - ${new Date().toISOString()}`);
    next();
});

// ==================== STATIC FILES ====================
app.use(express.static('static'));

// ==================== FILE MANAGEMENT ====================
function ensureBasicFiles() {
    const directories = [
        'views',
        'static/css',
        'static/js',
        'static/images',
        'database',
        'backups'
    ];

    directories.forEach(dir => {
        const fullPath = path.join(__dirname, dir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
            console.log(`✅ Created directory: ${dir}`);
        }
    });

    // Create basic CSS
    const cssPath = path.join(__dirname, 'static/css/style.css');
    if (!fs.existsSync(cssPath)) {
        const basicCSS = `
* { 
    margin: 0; 
    padding: 0; 
    box-sizing: border-box; 
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

:root {
    --primary-red: #dc2626;
    --primary-dark: #0f0f0f;
    --card-bg: #1a1a1a;
    --text-light: #ffffff;
    --text-muted: #a0a0a0;
    --border-color: #333;
    --success: #10b981;
    --warning: #f59e0b;
    --danger: #ef4444;
}

body { 
    background: var(--primary-dark);
    color: var(--text-light);
    line-height: 1.6;
    min-height: 100vh;
}

.container { 
    max-width: 1200px; 
    margin: 0 auto;
    padding: 2rem;
}

.card {
    background: var(--card-bg);
    border-radius: 10px;
    border: 1px solid var(--border-color);
    padding: 2rem;
    margin-bottom: 2rem;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.header {
    text-align: center;
    margin-bottom: 3rem;
    padding: 2rem 0;
    border-bottom: 2px solid var(--primary-red);
}

h1 {
    color: var(--primary-red);
    font-size: 2.5rem;
    margin-bottom: 0.5rem;
}

h2 {
    color: var(--text-light);
    margin-bottom: 1rem;
    font-size: 1.8rem;
}

.status {
    color: var(--success);
    font-weight: bold;
    font-size: 1.1rem;
}

.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin: 2rem 0;
}

.stat-card {
    background: var(--card-bg);
    padding: 1.5rem;
    border-radius: 8px;
    border-left: 4px solid var(--primary-red);
    text-align: center;
}

.stat-number {
    font-size: 2rem;
    font-weight: bold;
    color: var(--primary-red);
    display: block;
}

.stat-label {
    color: var(--text-muted);
    font-size: 0.9rem;
}

.btn {
    background: var(--primary-red);
    color: white;
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 5px;
    text-decoration: none;
    display: inline-block;
    font-weight: bold;
    cursor: pointer;
    transition: all 0.3s ease;
}

.btn:hover {
    background: #b91c1c;
    transform: translateY(-2px);
}

.user-list {
    list-style: none;
}

.user-item {
    background: var(--card-bg);
    padding: 1rem;
    margin: 0.5rem 0;
    border-radius: 5px;
    border-left: 3px solid var(--primary-red);
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.user-info {
    flex: 1;
}

.user-actions {
    display: flex;
    gap: 0.5rem;
}

.form-group {
    margin-bottom: 1.5rem;
}

.form-label {
    display: block;
    margin-bottom: 0.5rem;
    color: var(--text-light);
    font-weight: bold;
}

.form-input {
    width: 100%;
    padding: 0.75rem;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 5px;
    color: var(--text-light);
    font-size: 1rem;
}

.form-input:focus {
    outline: none;
    border-color: var(--primary-red);
}

.alert {
    padding: 1rem;
    border-radius: 5px;
    margin: 1rem 0;
}

.alert-success {
    background: #10b98120;
    border: 1px solid var(--success);
    color: var(--success);
}

.alert-error {
    background: #ef444420;
    border: 1px solid var(--danger);
    color: var(--danger);
}

@media (max-width: 768px) {
    .container {
        padding: 1rem;
    }
    
    .stats-grid {
        grid-template-columns: 1fr;
    }
    
    h1 {
        font-size: 2rem;
    }
}
`;
        fs.writeFileSync(cssPath, basicCSS);
        console.log('✅ Created default CSS file');
    }
}

// Initialize files
ensureBasicFiles();

// ==================== ROUTES ====================

// Health endpoint - MUST be first
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'Big Daddy V3 Web Server',
        domain: WEB_DOMAIN,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        memory: {
            used: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`,
            total: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)}MB`
        }
    });
});

// Ping endpoint
app.get('/ping', (req, res) => {
    res.json({ 
        success: true, 
        message: 'pong',
        timestamp: new Date().toISOString(),
        server: 'Big Daddy V3'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Big Daddy V3 - WhatsApp Bot Platform</title>
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Big Daddy V3</h1>
            <p>Advanced WhatsApp Bot Deployment Platform</p>
            <p class="status">✅ Server is running</p>
        </div>
        
        <div class="card">
            <h2>🌐 Server Information</h2>
            <div class="stats-grid">
                <div class="stat-card">
                    <span class="stat-number">${WEB_DOMAIN}</span>
                    <span class="stat-label">Domain</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${PORT}</span>
                    <span class="stat-label">Port</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${Math.floor(process.uptime())}s</span>
                    <span class="stat-label">Uptime</span>
                </div>
            </div>
            
            <div style="text-align: center; margin-top: 2rem;">
                <a href="/admin" class="btn">Admin Panel</a>
                <a href="/health" class="btn" style="background: #333; margin-left: 1rem;">Health Check</a>
            </div>
        </div>
        
        <div class="card">
            <h2>🚀 Getting Started</h2>
            <p>Use the Telegram bot to register and start deploying your WhatsApp bots:</p>
            <ul style="margin: 1rem 0; padding-left: 2rem;">
                <li>Start with /start command</li>
                <li>Register with /register</li>
                <li>Access your dashboard</li>
                <li>Deploy WhatsApp bots</li>
            </ul>
        </div>
    </div>
</body>
</html>
    `);
});

// Admin page
app.get('/admin', (req, res) => {
    let stats = { total_users: 0, total_accounts: 0, blocked_users: 0 };
    let users = {};
    
    try {
        if (fs.existsSync('database.json')) {
            const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
            stats = db.statistics || stats;
            users = db.users || {};
        }
    } catch (error) {
        console.error('Admin page data load error:', error);
    }
    
    const userList = Object.entries(users).map(([id, user]) => `
        <div class="user-item">
            <div class="user-info">
                <strong>${user.name}</strong><br>
                <small>${user.email} • ${user.user_id} • ${new Date(user.created_at).toLocaleDateString()}</small>
            </div>
            <div class="user-actions">
                <button class="btn" onclick="deleteUser('${id}')" style="background: var(--danger); padding: 0.5rem 1rem;">Delete</button>
            </div>
        </div>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Panel - Big Daddy V3</title>
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>👑 Admin Panel</h1>
            <p>Big Daddy V3 Management Dashboard</p>
            <p class="status">✅ Connected to ${WEB_DOMAIN}</p>
        </div>
        
        <div class="card">
            <h2>📊 Statistics</h2>
            <div class="stats-grid">
                <div class="stat-card">
                    <span class="stat-number">${stats.total_users}</span>
                    <span class="stat-label">Total Users</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${stats.total_accounts}</span>
                    <span class="stat-label">Total Accounts</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${stats.blocked_users}</span>
                    <span class="stat-label">Blocked Users</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${Object.keys(users).length}</span>
                    <span class="stat-label">Active Users</span>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h2>👥 User Management</h2>
            <div id="userList" class="user-list">
                ${userList || '<p>No users registered yet.</p>'}
            </div>
        </div>
        
        <div class="card">
            <h2>⚙️ Settings</h2>
            <form id="settingsForm">
                <div class="form-group">
                    <label class="form-label">Max Accounts per IP</label>
                    <input type="number" class="form-input" id="maxAccounts" name="max_accounts_per_ip" value="3" min="1" max="10">
                </div>
                <button type="submit" class="btn">Save Settings</button>
            </form>
        </div>
    </div>
    
    <script>
        async function deleteUser(userId) {
            if (!confirm('Are you sure you want to delete this user?')) return;
            
            try {
                const response = await fetch('/api/admin/user/' + userId, {
                    method: 'DELETE'
                });
                
                const result = await response.json();
                
                if (result.success) {
                    alert('User deleted successfully');
                    location.reload();
                } else {
                    alert('Error: ' + (result.message || 'Failed to delete user'));
                }
            } catch (error) {
                alert('Error deleting user: ' + error.message);
            }
        }
        
        document.getElementById('settingsForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = new FormData(e.target);
            const data = Object.fromEntries(formData);
            
            try {
                const response = await fetch('/api/admin/settings', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });
                
                const result = await response.json();
                
                if (result.success) {
                    alert('Settings saved successfully!');
                } else {
                    alert('Error: ' + (result.message || 'Failed to save settings'));
                }
            } catch (error) {
                alert('Error saving settings: ' + error.message);
            }
        });
    </script>
</body>
</html>
    `);
});

// Dashboard page
app.get('/dashboard', (req, res) => {
    const userId = req.query.user;
    if (!userId) {
        return res.redirect('/');
    }
    
    let userData = null;
    try {
        if (fs.existsSync('database.json')) {
            const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
            userData = db.users?.[userId] || null;
        }
    } catch (error) {
        console.error('Dashboard data load error:', error);
    }
    
    if (!userData) {
        return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Access Denied - Big Daddy V3</title>
            <link rel="stylesheet" href="/css/style.css">
        </head>
        <body>
            <div class="container">
                <div class="card">
                    <h1>❌ Access Denied</h1>
                    <p>User not found or invalid user ID.</p>
                    <p>Please register through the Telegram bot first.</p>
                    <a href="/" class="btn">Return Home</a>
                </div>
            </div>
        </body>
        </html>
        `);
    }
    
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>User Dashboard - Big Daddy V3</title>
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 User Dashboard</h1>
            <p>Welcome back, ${userData.name}!</p>
            <p class="status">✅ Account Active</p>
        </div>
        
        <div class="card">
            <h2>👤 Profile Information</h2>
            <div class="stats-grid">
                <div class="stat-card">
                    <span class="stat-number">${userData.name}</span>
                    <span class="stat-label">Full Name</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${userData.email}</span>
                    <span class="stat-label">Email</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${userData.user_id}</span>
                    <span class="stat-label">User ID</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${new Date(userData.created_at).toLocaleDateString()}</span>
                    <span class="stat-label">Joined Date</span>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h2>🚀 Bot Deployment</h2>
            <p>Your WhatsApp bot deployment features will be available here soon.</p>
            <div style="margin-top: 1.5rem;">
                <button class="btn" onclick="alert('Feature coming soon!')">Deploy New Bot</button>
                <button class="btn" style="background: #333; margin-left: 1rem;">Manage Sessions</button>
            </div>
        </div>
        
        <div class="card">
            <h2>📊 Account Statistics</h2>
            <p>Account analytics and usage statistics will be displayed here.</p>
            <!-- Add user-specific stats here -->
        </div>
    </div>
</body>
</html>
    `);
});

// ==================== API ROUTES ====================

// Login endpoint
app.post('/api/login', (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.json({ success: false, message: 'Email and password required' });
        }

        if (fs.existsSync('database.json')) {
            const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
            
            for (const [userId, user] of Object.entries(db.users)) {
                if (user.email === email && user.password === password) {
                    return res.json({
                        success: true,
                        user_id: userId,
                        user_data: user,
                        dashboard_url: `${WEB_DOMAIN}/dashboard?user=${userId}`
                    });
                }
            }
        }
        
        res.json({ success: false, message: 'Invalid credentials' });
    } catch (error) {
        console.error('Login error:', error);
        res.json({ success: false, message: 'Server error' });
    }
});

// Admin statistics
app.get('/api/admin/stats', (req, res) => {
    try {
        if (fs.existsSync('database.json')) {
            const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
            const stats = db.statistics || { total_users: 0, total_accounts: 0, blocked_users: 0 };
            stats.active_users = Object.keys(db.users || {}).length;
            return res.json(stats);
        }
        res.json({ total_users: 0, total_accounts: 0, blocked_users: 0, active_users: 0 });
    } catch (error) {
        console.error('Stats error:', error);
        res.json({ total_users: 0, total_accounts: 0, blocked_users: 0, active_users: 0 });
    }
});

// Admin users list
app.get('/api/admin/users', (req, res) => {
    try {
        if (fs.existsSync('database.json')) {
            const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
            return res.json(db.users || {});
        }
        res.json({});
    } catch (error) {
        console.error('Users error:', error);
        res.json({});
    }
});

// Admin settings
app.get('/api/admin/settings', (req, res) => {
    try {
        if (fs.existsSync('database.json')) {
            const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
            return res.json(db.settings || { force_join: [], max_accounts_per_ip: 3, blocked_ips: {} });
        }
        res.json({ force_join: [], max_accounts_per_ip: 3, blocked_ips: {} });
    } catch (error) {
        console.error('Settings error:', error);
        res.json({ force_join: [], max_accounts_per_ip: 3, blocked_ips: {} });
    }
});

// Update admin settings
app.post('/api/admin/settings', (req, res) => {
    try {
        const { max_accounts_per_ip, force_join } = req.body;
        
        let db = { 
            users: {}, 
            settings: { force_join: [], max_accounts_per_ip: 3, blocked_ips: {} }, 
            statistics: { total_users: 0, total_accounts: 0, blocked_users: 0 } 
        };
        
        if (fs.existsSync('database.json')) {
            db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
        }
        
        if (max_accounts_per_ip !== undefined) {
            db.settings.max_accounts_per_ip = parseInt(max_accounts_per_ip) || 3;
        }
        
        if (force_join !== undefined) {
            db.settings.force_join = Array.isArray(force_join) ? force_join : [];
        }
        
        fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
        res.json({ success: true, message: 'Settings updated successfully' });
    } catch (error) {
        console.error('Save settings error:', error);
        res.json({ success: false, message: 'Failed to save settings: ' + error.message });
    }
});

// Delete user
app.delete('/api/admin/user/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        
        if (fs.existsSync('database.json')) {
            const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
            
            if (db.users && db.users[userId]) {
                delete db.users[userId];
                db.statistics.total_users = Math.max(0, (db.statistics.total_users || 0) - 1);
                db.statistics.total_accounts = Math.max(0, (db.statistics.total_accounts || 0) - 1);
                fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
                return res.json({ success: true, message: 'User deleted successfully' });
            }
        }
        
        res.json({ success: false, message: 'User not found' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.json({ success: false, message: 'Server error: ' + error.message });
    }
});

// User profile endpoint
app.get('/api/user/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        
        if (fs.existsSync('database.json')) {
            const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
            const user = db.users?.[userId];
            
            if (user) {
                return res.json({ success: true, user });
            }
        }
        
        res.json({ success: false, message: 'User not found' });
    } catch (error) {
        console.error('User profile error:', error);
        res.json({ success: false, message: 'Server error' });
    }
});

// ==================== ERROR HANDLING ====================

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint not found',
        available_endpoints: [
            'GET /',
            'GET /health',
            'GET /ping', 
            'GET /admin',
            'GET /dashboard',
            'POST /api/login',
            'GET /api/admin/stats',
            'GET /api/admin/users',
            'GET /api/admin/settings',
            'POST /api/admin/settings',
            'DELETE /api/admin/user/:userId',
            'GET /api/user/:userId'
        ]
    });
});

// Global error handler
app.use((error, req, res, next) => {
    console.error('💥 Server error:', error);
    res.status(500).json({ 
        success: false, 
        error: 'Internal server error',
        message: error.message
    });
});

// ==================== CRITICAL RENDER PORT BINDING FIX ====================
// This is the fix for Render's "No open ports detected" error

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Web server successfully started on port ${PORT}`);
    console.log(`🌐 Access your app at: ${WEB_DOMAIN}`);
    console.log('📋 Available endpoints:');
    console.log(`   • GET  ${WEB_DOMAIN}/ - Main page`);
    console.log(`   • GET  ${WEB_DOMAIN}/health - Health check`);
    console.log(`   • GET  ${WEB_DOMAIN}/ping - Ping endpoint`);
    console.log(`   • GET  ${WEB_DOMAIN}/admin - Admin panel`);
    console.log(`   • GET  ${WEB_DOMAIN}/dashboard - User dashboard`);
});

// Handle server errors
server.on('error', (error) => {
    console.error('❌ Server failed to start:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down gracefully');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

module.exports = app;
