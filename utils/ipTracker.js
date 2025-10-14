const fs = require('fs');
const path = require('path');

class IPTracker {
    constructor() {
        this.ipMap = new Map();
        this.blockedIPs = new Set();
        this.loadBlockedIPs();
    }

    trackIP(userId) {
        // In production, you'd get real IP from web requests
        // For now, simulate IP based on user ID
        const ip = `192.168.1.${parseInt(userId) % 255}`;
        this.ipMap.set(userId, ip);
        return ip;
    }

    getIP(userId) {
        return this.ipMap.get(userId);
    }

    blockIP(ip, reason = 'Violated terms of service') {
        this.blockedIPs.add(ip);
        this.saveBlockedIPs();
        
        // Update database
        const dbPath = path.join(__dirname, '..', 'database.json');
        if (fs.existsSync(dbPath)) {
            const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
            db.settings.blocked_ips[ip] = {
                reason,
                blocked_at: new Date().toISOString()
            };
            fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        }
    }

    isIPBlocked(ip) {
        return this.blockedIPs.has(ip);
    }

    loadBlockedIPs() {
        const dbPath = path.join(__dirname, '..', 'database.json');
        if (fs.existsSync(dbPath)) {
            const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
            Object.keys(db.settings.blocked_ips).forEach(ip => {
                this.blockedIPs.add(ip);
            });
        }
    }

    saveBlockedIPs() {
        const dbPath = path.join(__dirname, '..', 'database.json');
        if (fs.existsSync(dbPath)) {
            const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
            db.settings.blocked_ips = {};
            this.blockedIPs.forEach(ip => {
                db.settings.blocked_ips[ip] = {
                    reason: 'Violated terms of service',
                    blocked_at: new Date().toISOString()
                };
            });
            fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        }
    }

    // Get all blocked IPs with reasons
    getBlockedIPs() {
        const blocked = {};
        this.blockedIPs.forEach(ip => {
            blocked[ip] = {
                reason: 'Violated terms of service',
                blocked_at: new Date().toISOString()
            };
        });
        return blocked;
    }

    // Unblock an IP
    unblockIP(ip) {
        this.blockedIPs.delete(ip);
        this.saveBlockedIPs();
        return true;
    }
}

const ipTracker = new IPTracker();

module.exports = {
    trackIP: (userId) => ipTracker.trackIP(userId),
    getIP: (userId) => ipTracker.getIP(userId),
    blockIP: (ip, reason) => ipTracker.blockIP(ip, reason),
    isIPBlocked: (ip) => ipTracker.isIPBlocked(ip),
    getBlockedIPs: () => ipTracker.getBlockedIPs(),
    unblockIP: (ip) => ipTracker.unblockIP(ip)
};
