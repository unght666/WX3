const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initializeDatabase, getPool } = require('./db');

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const PORT = process.env.PORT || 3000;

// JWT认证中间件
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user; // user包含 { id, username }
    next();
  });
}

// ------------------ 注册 ------------------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const pool = getPool();
    // 检查用户名是否已存在
    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    // 哈希密码
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    // 插入用户
    await pool.execute('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);
    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------ 登录 ------------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const pool = getPool();
    const [users] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = users[0];
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // 生成JWT（有效期24小时）
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ message: 'Login successful', token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------ 数据同步（需认证）------------------
app.post('/api/sync', authenticateToken, async (req, res) => {
  const { data } = req.body; // data 应该是 JSON 对象
  if (!data) {
    return res.status(400).json({ error: 'Data field is required' });
  }
  try {
    const pool = getPool();
    // 将数据插入 sync_data 表，关联当前登录用户
    await pool.execute(
      'INSERT INTO sync_data (user_id, data) VALUES (?, ?)',
      [req.user.id, JSON.stringify(data)]
    );
    res.status(201).json({ message: 'Data synced successfully' });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------ 启动服务器 ------------------
async function start() {
  try {
    await initializeDatabase(); // 初始化数据库和表
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  }
}

start();