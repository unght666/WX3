const mysql = require('mysql2/promise');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'mydb';
const DB_PORT = process.env.DB_PORT || 3306;

let pool;

async function initializeDatabase() {
  // 创建数据库
  const initConn = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    port: DB_PORT
  });
  await initConn.execute(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await initConn.end();

  // 创建连接池
  pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    port: DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  const connection = await pool.getConnection();
  try {
    // 用户表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 原始单向同步表（根据你的需要保留或删除）
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS sync_data (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        data JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 笔记同步表（已包含新字段：count, priority, icon）
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        local_id VARCHAR(100) NOT NULL,
        title TEXT,
        content LONGTEXT,
        version INT NOT NULL DEFAULT 1,
        deleted TINYINT(1) NOT NULL DEFAULT 0,
        count INT NOT NULL DEFAULT 0,
        priority VARCHAR(10) NOT NULL DEFAULT 'medium',
        icon VARCHAR(100) NOT NULL DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_local (user_id, local_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    console.log('Database and tables initialized successfully.');
  } finally {
    connection.release();
  }

  return pool;
}

function getPool() {
  if (!pool) {
    throw new Error('Database pool has not been initialized. Call initializeDatabase() first.');
  }
  return pool;
}

module.exports = { initializeDatabase, getPool };