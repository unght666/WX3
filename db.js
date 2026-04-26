const mysql = require('mysql2/promise');

// 从环境变量读取数据库配置
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'mydb';
const DB_PORT = process.env.DB_PORT || 3306;

let pool;

async function initializeDatabase() {
  // 1. 创建数据库（不指定数据库连接）
  const initConn = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    port: DB_PORT
  });
  await initConn.execute(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await initConn.end();

  // 2. 创建连接池，连接到刚才创建的数据库
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

  // 3. 创建表
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  const createSyncTable = `
    CREATE TABLE IF NOT EXISTS sync_data (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      data JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `;

  const connection = await pool.getConnection();
  try {
    await connection.execute(createUsersTable);
    await connection.execute(createSyncTable);
    console.log('Database and tables initialized successfully.');
  } finally {
    connection.release();
  }
  return pool;
}

// 获取连接池（必须先调用 initializeDatabase）
function getPool() {
  if (!pool) {
    throw new Error('Database pool has not been initialized. Call initializeDatabase() first.');
  }
  return pool;
}

module.exports = { initializeDatabase, getPool };