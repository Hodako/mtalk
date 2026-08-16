import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const isPostgres = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres'));

let db;
let pgPool;

if (isPostgres) {
  console.log('[DB] Connecting to PostgreSQL database...');
  pgPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false }
  });
} else {
  const dbPath = path.join(DATA_DIR, 'mtalk.db');
  console.log(`[DB] Using SQLite database at: ${dbPath}`);
  sqlite3.verbose();
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('[DB] SQLite Connection Error:', err);
    } else {
      console.log('[DB] SQLite connected successfully.');
    }
  });
}

// Promisified query helper
async function query(sql, params = []) {
  if (isPostgres) {
    const res = await pgPool.query(sql, params);
    return res.rows;
  } else {
    return new Promise((resolve, reject) => {
      const isSelect = sql.trim().toUpperCase().startsWith('SELECT') || sql.trim().toUpperCase().startsWith('PRAGMA');
      if (isSelect) {
        db.all(sql, params, (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        });
      } else {
        db.run(sql, params, function (err) {
          if (err) return reject(err);
          resolve({ lastID: this.lastID, changes: this.changes });
        });
      }
    });
  }
}

// Initialize tables
export async function initDatabase() {
  console.log('[DB] Initializing tables...');

  if (isPostgres) {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        session_token TEXT UNIQUE NOT NULL,
        nickname TEXT,
        avatar TEXT,
        gender TEXT,
        country TEXT,
        interests TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        user1_token TEXT,
        user2_token TEXT,
        mode TEXT,
        duration_seconds INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS friend_connections (
        id SERIAL PRIMARY KEY,
        user_token TEXT NOT NULL,
        friend_token TEXT NOT NULL,
        friend_name TEXT,
        friend_avatar TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_token, friend_token)
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        reporter_token TEXT,
        reported_token TEXT,
        reason TEXT,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'pending'
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS banned_ips (
        id SERIAL PRIMARY KEY,
        ip_address TEXT UNIQUE NOT NULL,
        reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS stats (
        key TEXT PRIMARY KEY,
        value BIGINT DEFAULT 0
      );
    `);
  } else {
    // SQLite Tables
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_token TEXT UNIQUE NOT NULL,
        nickname TEXT,
        avatar TEXT,
        gender TEXT,
        country TEXT,
        interests TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user1_token TEXT,
        user2_token TEXT,
        mode TEXT,
        duration_seconds INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS friend_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_token TEXT NOT NULL,
        friend_token TEXT NOT NULL,
        friend_name TEXT,
        friend_avatar TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_token, friend_token)
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter_token TEXT,
        reported_token TEXT,
        reason TEXT,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'pending'
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS banned_ips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT UNIQUE NOT NULL,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS stats (
        key TEXT PRIMARY KEY,
        value INTEGER DEFAULT 0
      );
    `);
  }

  // Seed initial stats if not existing
  const statsKeys = ['total_matches', 'total_messages', 'total_users'];
  for (const k of statsKeys) {
    const existing = await query(`SELECT * FROM stats WHERE key = ?`, [k]);
    if (!existing || existing.length === 0) {
      await query(`INSERT INTO stats (key, value) VALUES (?, 0)`, [k]);
    }
  }

  console.log('[DB] Database tables initialized successfully.');
}

// User Helpers
export async function getOrCreateUser(sessionToken, nickname = 'Anonymous', avatar = 'avatar-1', country = 'GLOBAL', gender = 'any') {
  const existing = await query(`SELECT * FROM users WHERE session_token = ?`, [sessionToken]);
  if (existing && existing.length > 0) {
    await query(`UPDATE users SET last_active = CURRENT_TIMESTAMP, nickname = ?, avatar = ?, country = ?, gender = ? WHERE session_token = ?`, 
      [nickname, avatar, country, gender, sessionToken]);
    return existing[0];
  }
  await query(`INSERT INTO users (session_token, nickname, avatar, gender, country) VALUES (?, ?, ?, ?, ?)`,
    [sessionToken, nickname, avatar, gender, country]);
  const created = await query(`SELECT * FROM users WHERE session_token = ?`, [sessionToken]);
  return created[0];
}

export async function logMatch(user1Token, user2Token, mode, durationSeconds = 0) {
  try {
    await query(`INSERT INTO matches (user1_token, user2_token, mode, duration_seconds) VALUES (?, ?, ?, ?)`,
      [user1Token, user2Token, mode, durationSeconds]);
    await incrementStat('total_matches');
  } catch (err) {
    console.error('[DB] Error logging match:', err);
  }
}

export async function saveFriend(userToken, friendToken, friendName, friendAvatar) {
  try {
    if (isPostgres) {
      await query(`
        INSERT INTO friend_connections (user_token, friend_token, friend_name, friend_avatar)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (user_token, friend_token) DO UPDATE SET friend_name = EXCLUDED.friend_name, friend_avatar = EXCLUDED.friend_avatar
      `, [userToken, friendToken, friendName, friendAvatar]);
    } else {
      await query(`
        INSERT OR REPLACE INTO friend_connections (user_token, friend_token, friend_name, friend_avatar)
        VALUES (?, ?, ?, ?)
      `, [userToken, friendToken, friendName, friendAvatar]);
    }
    return true;
  } catch (err) {
    console.error('[DB] Error saving friend:', err);
    return false;
  }
}

export async function getFriends(userToken) {
  try {
    const rows = await query(`SELECT friend_token, friend_name, friend_avatar, created_at FROM friend_connections WHERE user_token = ? ORDER BY created_at DESC`, [userToken]);
    return rows || [];
  } catch (err) {
    console.error('[DB] Error getting friends:', err);
    return [];
  }
}

export async function logReport(reporterToken, reportedToken, reason, details = '') {
  try {
    await query(`INSERT INTO reports (reporter_token, reported_token, reason, details) VALUES (?, ?, ?, ?)`,
      [reporterToken, reportedToken, reason, details]);
    return true;
  } catch (err) {
    console.error('[DB] Error logging report:', err);
    return false;
  }
}

export async function isIpBanned(ip) {
  try {
    const rows = await query(`SELECT * FROM banned_ips WHERE ip_address = ?`, [ip]);
    return rows && rows.length > 0;
  } catch (err) {
    console.error('[DB] Error checking banned IP:', err);
    return false;
  }
}

export async function banIp(ip, reason = 'Reported violation') {
  try {
    await query(`INSERT INTO banned_ips (ip_address, reason) VALUES (?, ?)`, [ip, reason]);
    return true;
  } catch (err) {
    return false;
  }
}

export async function incrementStat(key) {
  try {
    await query(`UPDATE stats SET value = value + 1 WHERE key = ?`, [key]);
  } catch (err) {
    console.error('[DB] Error incrementing stat:', err);
  }
}

export async function getStats() {
  try {
    const rows = await query(`SELECT * FROM stats`);
    const result = {};
    for (const r of rows) {
      result[r.key] = Number(r.value);
    }
    return result;
  } catch (err) {
    return { total_matches: 0, total_messages: 0, total_users: 0 };
  }
}

export default {
  initDatabase,
  getOrCreateUser,
  logMatch,
  saveFriend,
  getFriends,
  logReport,
  isIpBanned,
  banIp,
  incrementStat,
  getStats
};
