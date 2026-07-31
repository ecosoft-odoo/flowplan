const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      color VARCHAR(7) NOT NULL DEFAULT '#6C5CE7',
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL DEFAULT 'member',
      PRIMARY KEY (project_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title VARCHAR(180) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'todo',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      assignee VARCHAR(120) NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT valid_task_dates CHECK (end_date >= start_date),
      CONSTRAINT valid_task_status CHECK (status IN ('todo', 'in_progress', 'review', 'done')),
      CONSTRAINT valid_task_priority CHECK (priority IN ('low', 'medium', 'high'))
    );

    CREATE TABLE IF NOT EXISTS task_revisions (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      previous_start_date DATE NOT NULL,
      previous_end_date DATE NOT NULL,
      new_start_date DATE NOT NULL,
      new_end_date DATE NOT NULL,
      note VARCHAR(300) NOT NULL DEFAULT '',
      revised_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project_dates
      ON tasks(project_id, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_revisions_task
      ON task_revisions(task_id, created_at);
  `);

  if (String(process.env.SEED_DEMO).toLowerCase() === 'true') {
    await seedDemoData();
  }
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const value = new Date(date);
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

async function seedDemoData() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM users WHERE email = $1', ['demo@flowplan.local']);
    if (existing.rowCount) {
      await client.query('COMMIT');
      return;
    }

    const passwordHash = await bcrypt.hash('demo1234', 12);
    const userResult = await client.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      ['Saran Demo', 'demo@flowplan.local', passwordHash],
    );
    const userId = userResult.rows[0].id;
    const projectResult = await client.query(
      `INSERT INTO projects (name, description, color, owner_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Website Redesign', 'Make the website simple, clear, and easy to use.', '#6C5CE7', userId],
    );
    const projectId = projectResult.rows[0].id;
    await client.query(
      'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
      [projectId, userId, 'owner'],
    );

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const taskRows = [
      ['Research & Discovery', 'Talk to users and list the main problems.', -12, -5, 'done', 'high', 'Saran'],
      ['Information Architecture', 'Plan the content structure and user flow.', -5, 3, 'in_progress', 'high', 'May'],
      ['UI Design', 'Design the main screens and design system.', 1, 12, 'in_progress', 'high', 'Pim'],
      ['Frontend Development', 'Build the responsive website.', 10, 25, 'todo', 'medium', 'Ton'],
      ['QA & Launch', 'Test, fix issues, and prepare for launch.', 24, 32, 'todo', 'medium', 'Team'],
    ];

    const inserted = [];
    for (const row of taskRows) {
      const result = await client.query(
        `INSERT INTO tasks
          (project_id, title, description, start_date, end_date, status, priority, assignee, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [projectId, row[0], row[1], addDays(today, row[2]), addDays(today, row[3]), row[4], row[5], row[6], userId],
      );
      inserted.push(result.rows[0].id);
    }

    await client.query(
      `INSERT INTO task_revisions
        (task_id, previous_start_date, previous_end_date, new_start_date, new_end_date, note, revised_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7), ($8,$9,$10,$11,$12,$13,$14)`,
      [
        inserted[2], addDays(today, -1), addDays(today, 8), addDays(today, 1), addDays(today, 12),
        'Added more time for the prototype and user testing.', userId,
        inserted[3], addDays(today, 7), addDays(today, 20), addDays(today, 10), addDays(today, 25),
        'Moved after the design revision.', userId,
      ],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, initializeDatabase };
