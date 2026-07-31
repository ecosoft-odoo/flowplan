const path = require('path');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, initializeDatabase } = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET || 'local-development-secret-change-before-production';
const publicDir = path.join(__dirname, '..', 'public');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '200kb' }));
app.use(express.static(publicDir));

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key]) => key)
      .map(([key, ...value]) => [key, decodeURIComponent(value.join('='))]),
  );
}

function setAuthCookie(res, user) {
  const token = jwt.sign({ sub: user.id, email: user.email }, jwtSecret, { expiresIn: '7d' });
  res.cookie('flowplan_token', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === 'true',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req).flowplan_token;
    if (!token) return res.status(401).json({ error: 'Please sign in.' });
    const payload = jwt.verify(token, jwtSecret);
    req.user = { id: Number(payload.sub), email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
  }
}

function cleanText(value, maxLength = 255) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function validHexColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value));
}

function databaseDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

async function memberProject(userId, projectId) {
  return pool.query(
    `SELECT p.* FROM projects p
     JOIN project_members pm ON pm.project_id = p.id
     WHERE p.id = $1 AND pm.user_id = $2`,
    [projectId, userId],
  );
}

app.post('/api/auth/register', async (req, res, next) => {
  const name = cleanText(req.body.name, 120);
  const email = cleanText(req.body.email, 255).toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Name must have at least 2 characters.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must have at least 8 characters.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, 12);
    const userResult = await client.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
       RETURNING id, name, email`,
      [name, email, passwordHash],
    );
    const user = userResult.rows[0];
    const projectResult = await client.query(
      `INSERT INTO projects (name, description, color, owner_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['My First Project', 'Start planning by adding your first task.', '#6C5CE7', user.id],
    );
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [projectResult.rows[0].id, user.id],
    );
    await client.query('COMMIT');
    setAuthCookie(res, user);
    res.status(201).json({ user });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'This email is already in use.' });
    next(error);
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = cleanText(req.body.email, 255).toLowerCase();
    const password = String(req.body.password || '');
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Email or password is not correct.' });
    }
    setAuthCookie(res, user);
    res.json({ user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('flowplan_token', { path: '/' });
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.user.id]);
    if (!result.rowCount) return res.status(401).json({ error: 'User not found.' });
    res.json({ user: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.description, p.color,
         COUNT(t.id)::int AS task_count,
         COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS completed_count,
         MIN(t.end_date) FILTER (WHERE t.status <> 'done' AND t.end_date >= CURRENT_DATE) AS nearest_due
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       LEFT JOIN tasks t ON t.project_id = p.id
       WHERE pm.user_id = $1
       GROUP BY p.id
       ORDER BY nearest_due ASC NULLS LAST, p.updated_at DESC`,
      [req.user.id],
    );
    res.json({ projects: result.rows });
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects', requireAuth, async (req, res, next) => {
  const name = cleanText(req.body.name, 160);
  const description = cleanText(req.body.description, 2000);
  const color = validHexColor(req.body.color) ? req.body.color : '#6C5CE7';
  if (name.length < 2) return res.status(400).json({ error: 'Enter a project name.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO projects (name, description, color, owner_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description, color, req.user.id],
    );
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [result.rows[0].id, req.user.id],
    );
    await client.query('COMMIT');
    res.status(201).json({ project: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

app.get('/api/projects/:projectId/timeline', requireAuth, async (req, res, next) => {
  try {
    const projectResult = await memberProject(req.user.id, req.params.projectId);
    if (!projectResult.rowCount) return res.status(404).json({ error: 'Project not found.' });
    const taskResult = await pool.query(
      `SELECT t.*,
        COALESCE(
          json_agg(
            json_build_object(
              'id', r.id,
              'previous_start_date', r.previous_start_date,
              'previous_end_date', r.previous_end_date,
              'new_start_date', r.new_start_date,
              'new_end_date', r.new_end_date,
              'note', r.note,
              'created_at', r.created_at
            ) ORDER BY r.created_at
          ) FILTER (WHERE r.id IS NOT NULL), '[]'
        ) AS revisions
       FROM tasks t
       LEFT JOIN task_revisions r ON r.task_id = t.id
       WHERE t.project_id = $1
       GROUP BY t.id
       ORDER BY t.start_date, t.end_date, t.id`,
      [req.params.projectId],
    );
    res.json({ project: projectResult.rows[0], tasks: taskResult.rows });
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:projectId/tasks', requireAuth, async (req, res, next) => {
  try {
    const projectResult = await memberProject(req.user.id, req.params.projectId);
    if (!projectResult.rowCount) return res.status(404).json({ error: 'Project not found.' });
    const title = cleanText(req.body.title, 180);
    const description = cleanText(req.body.description, 2000);
    const startDate = req.body.start_date;
    const endDate = req.body.end_date;
    const status = ['todo', 'in_progress', 'review', 'done'].includes(req.body.status) ? req.body.status : 'todo';
    const priority = ['low', 'medium', 'high'].includes(req.body.priority) ? req.body.priority : 'medium';
    const assignee = cleanText(req.body.assignee, 120);
    if (!title) return res.status(400).json({ error: 'Enter a task name.' });
    if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) {
      return res.status(400).json({ error: 'The date range is not valid.' });
    }
    const result = await pool.query(
      `INSERT INTO tasks
        (project_id, title, description, start_date, end_date, status, priority, assignee, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.projectId, title, description, startDate, endDate, status, priority, assignee, req.user.id],
    );
    await pool.query('UPDATE projects SET updated_at = NOW() WHERE id = $1', [req.params.projectId]);
    res.status(201).json({ task: { ...result.rows[0], revisions: [] } });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/tasks/:taskId', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT t.* FROM tasks t
       JOIN project_members pm ON pm.project_id = t.project_id
       WHERE t.id = $1 AND pm.user_id = $2 FOR UPDATE`,
      [req.params.taskId, req.user.id],
    );
    if (!currentResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Task not found.' });
    }
    const current = currentResult.rows[0];
    const title = cleanText(req.body.title ?? current.title, 180);
    const description = cleanText(req.body.description ?? current.description, 2000);
    const startDate = req.body.start_date || databaseDate(current.start_date);
    const endDate = req.body.end_date || databaseDate(current.end_date);
    const status = ['todo', 'in_progress', 'review', 'done'].includes(req.body.status) ? req.body.status : current.status;
    const priority = ['low', 'medium', 'high'].includes(req.body.priority) ? req.body.priority : current.priority;
    const assignee = cleanText(req.body.assignee ?? current.assignee, 120);
    if (!title) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Enter a task name.' });
    }
    if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The date range is not valid.' });
    }

    const oldStart = databaseDate(current.start_date);
    const oldEnd = databaseDate(current.end_date);
    if (oldStart !== startDate || oldEnd !== endDate) {
      await client.query(
        `INSERT INTO task_revisions
          (task_id, previous_start_date, previous_end_date, new_start_date, new_end_date, note, revised_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [current.id, oldStart, oldEnd, startDate, endDate, cleanText(req.body.revision_note, 300), req.user.id],
      );
    }

    const result = await client.query(
      `UPDATE tasks SET title=$1, description=$2, start_date=$3, end_date=$4,
         status=$5, priority=$6, assignee=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [title, description, startDate, endDate, status, priority, assignee, current.id],
    );
    await client.query('UPDATE projects SET updated_at = NOW() WHERE id = $1', [current.project_id]);
    await client.query('COMMIT');
    res.json({ task: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

app.delete('/api/tasks/:taskId', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM tasks t USING project_members pm
       WHERE t.id = $1 AND pm.project_id = t.project_id AND pm.user_id = $2
       RETURNING t.id`,
      [req.params.taskId, req.user.id],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Task not found.' });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'database unavailable' });
  }
});

app.get('/{*path}', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function start() {
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await initializeDatabase();
      app.listen(port, '0.0.0.0', () => {
        console.log(`FlowPlan is running on http://0.0.0.0:${port}`);
      });
      return;
    } catch (error) {
      lastError = error;
      console.error(`Database connection attempt ${attempt}/10 failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw lastError;
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
