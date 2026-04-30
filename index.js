const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initializeDatabase, getPool } = require('./db');

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const PORT = process.env.PORT || 3000;

// ---------- JWT 认证中间件 ----------
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// ---------- 注册 ----------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  try {
    const pool = getPool();
    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) return res.status(409).json({ error: 'Username already exists' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.execute('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);
    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- 登录 ----------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  try {
    const pool = getPool();
    const [users] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = users[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ message: 'Login successful', token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- 原始单向数据同步（保留） ----------
app.post('/api/sync', authenticateToken, async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Data field is required' });
  try {
    const pool = getPool();
    await pool.execute('INSERT INTO sync_data (user_id, data) VALUES (?, ?)', [req.user.id, JSON.stringify(data)]);
    res.status(201).json({ message: 'Data synced successfully' });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- 笔记同步：拉取更新 ----------
app.post('/api/sync/pull', authenticateToken, async (req, res) => {
  const { clients } = req.body || {};
  if (!clients) return res.status(400).json({ error: 'clients required' });

  const pool = getPool();

  // 1. 拉取属主的所有笔记（包含已删除的，后面会处理）
  const [allNotes] = await pool.execute(
    'SELECT * FROM notes WHERE user_id = ?',
    [req.user.id]
  );

  const updates = [];

  // 2. 遍历服务器上的每一条笔记
  for (const note of allNotes) {
    const clientVersion = clients[note.local_id];

    if (clientVersion === undefined) {
      // 客户端完全不知道这条笔记 → 新增
      updates.push({
        local_id: note.local_id,
        title: note.title,
        content: note.content,
        version: note.version,
        deleted: note.deleted === 1,
        count: note.count,
        priority: note.priority,
        icon: note.icon,
        updated_at: note.updated_at
      });
    } else if (note.version > clientVersion) {
      // 服务器版本更新 → 下发更新
      updates.push({
        local_id: note.local_id,
        title: note.title,
        content: note.content,
        version: note.version,
        deleted: note.deleted === 1,
        count: note.count,
        priority: note.priority,
        icon: note.icon,
        updated_at: note.updated_at
      });
    }
    // 如果版本相同 → 不推送
  }

  // 3. 处理客户端有但服务器已经彻底消失的笔记（标记为删除）
  for (const localId of Object.keys(clients)) {
    if (!allNotes.some(n => n.local_id === localId)) {
      updates.push({ local_id: localId, deleted: true, version: 0 });
    }
  }

  res.json({ updates, current_time: new Date().toISOString() });
});


// ---------- 笔记同步：推送变更 ----------
app.post('/api/sync/push', authenticateToken, async (req, res) => {
  const { changes } = req.body || [];
  if (!Array.isArray(changes)) return res.status(400).json({ error: 'changes required' });
  const pool = getPool();
  const results = [];

  for (const change of changes) {
    const { local_id, title, content, version, deleted, base_version } = change;
    const count = change.count ?? 0;
    const priority = change.priority || 'medium';
    const icon = change.icon || '';

    const [existing] = await pool.execute(
      'SELECT * FROM notes WHERE user_id = ? AND local_id = ?',
      [req.user.id, local_id]
    );

    if (existing.length === 0) {
      await pool.execute(
        `INSERT INTO notes (user_id, local_id, title, content, version, deleted, count, priority, icon)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, local_id, title, content, 1, deleted ? 1 : 0, count, priority, icon]
      );
      results.push({ local_id, status: 'created', version: 1 });
    } else {
      const serverNote = existing[0];
      if (base_version === undefined || base_version === serverNote.version) {
        const newVersion = serverNote.version + 1;
        await pool.execute(
          `UPDATE notes SET title=?, content=?, version=?, deleted=?, count=?, priority=?, icon=?
           WHERE id=?`,
          [title, content, newVersion, deleted ? 1 : 0, count, priority, icon, serverNote.id]
        );
        results.push({ local_id, status: 'updated', version: newVersion });
      } else {
        // 冲突：返回服务器端最新版本
        results.push({
          local_id,
          status: 'conflict',
          server_version: serverNote.version,
          server_note: {
            title: serverNote.title,
            content: serverNote.content,
            deleted: serverNote.deleted === 1,
            count: serverNote.count,
            priority: serverNote.priority,
            icon: serverNote.icon
          }
        });
      }
    }
  }

  res.json({ results });
});\

// ---------- 启动 ----------
async function start() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = app;