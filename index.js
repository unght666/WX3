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

// 新增同步拉取
app.post('/api/sync/pull', authenticateToken, async (req, res) => {
  const { clients } = req.body || {};
  const pool = getPool();
  const updates = [];

  if (!clients) return res.status(400).json({ error: 'clients required' });

  const entries = Object.entries(clients);
  for (const [localId, clientVersion] of entries) {
    const [rows] = await pool.execute(
      'SELECT * FROM notes WHERE user_id = ? AND local_id = ?',
      [req.user.id, localId]
    );
    if (rows.length > 0) {
      const serverNote = rows[0];
      if (serverNote.version > clientVersion) {
        updates.push({
          local_id: serverNote.local_id,
          title: serverNote.title,
          content: serverNote.content,
          version: serverNote.version,
          deleted: serverNote.deleted === 1,
          updated_at: serverNote.updated_at
        });
      }
    } else {
      // 客户端有但服务器没有，视为新建（或已删除），强制客户端删除本地
      updates.push({ local_id: localId, deleted: true, version: 0 });
    }
  }

  // 另外，服务器上新出现的 local_id（客户端还没有的）也需返回
  // 可通过客户端提供一个 known_ids 数组来实现，此处略
  res.json({ updates, current_time: new Date().toISOString() });
});

// 新增同步推送
app.post('/api/sync/push', authenticateToken, async (req, res) => {
  const { changes } = req.body || [];
  if (!Array.isArray(changes)) return res.status(400).json({ error: 'changes required' });

  const pool = getPool();
  const results = [];

  for (const change of changes) {
    const { local_id, title, content, version, deleted, base_version } = change;
    const [existing] = await pool.execute(
      'SELECT * FROM notes WHERE user_id = ? AND local_id = ?',
      [req.user.id, local_id]
    );

    if (existing.length === 0) {
      // 新笔记
      await pool.execute(
        'INSERT INTO notes (user_id, local_id, title, content, version, deleted) VALUES (?, ?, ?, ?, ?, ?)',
        [req.user.id, local_id, title, content, 1, deleted ? 1 : 0]
      );
      results.push({ local_id, status: 'created', version: 1 });
    } else {
      const serverNote = existing[0];
      if (base_version === undefined || base_version === serverNote.version) {
        // 无冲突，直接更新
        const newVersion = serverNote.version + 1;
        await pool.execute(
          'UPDATE notes SET title = ?, content = ?, version = ?, deleted = ? WHERE id = ?',
          [title, content, newVersion, deleted ? 1 : 0, serverNote.id]
        );
        results.push({ local_id, status: 'updated', version: newVersion });

        // 广播给其他设备
        io.to(`user_${req.user.id}`).emit('note_updated', {
          local_id,
          title,
          content,
          version: newVersion,
          deleted: deleted,
          updated_at: new Date().toISOString()
        });
      } else {
        // 冲突：返回服务器最新版本，让客户端处理
        results.push({
          local_id,
          status: 'conflict',
          server_version: serverNote.version,
          server_note: { title: serverNote.title, content: serverNote.content, deleted: serverNote.deleted === 1 }
        });
      }
    }
  }

  res.json({ results });
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