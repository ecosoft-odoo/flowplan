const path = require('path');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
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

const excelMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const excelColumns = [
  { header: 'Task', key: 'title', width: 36 },
  { header: 'Description', key: 'description', width: 44 },
  { header: 'Start', key: 'start', width: 14 },
  { header: 'End', key: 'end', width: 14 },
  { header: 'Status', key: 'status', width: 14 },
  { header: 'Priority', key: 'priority', width: 12 },
  { header: 'Assignee', key: 'assignee', width: 18 },
];

const statusOptions = { todo: 'Not started', in_progress: 'In progress', review: 'Review', done: 'Done' };
const priorityOptions = { low: 'Low', medium: 'Medium', high: 'High' };

const excelImportFields = [
  ['title', ['task', 'task name', 'title', 'name']],
  ['description', ['description', 'details', 'detail', 'note', 'notes']],
  ['start', ['start', 'start date', 'start_date', 'from', 'begin']],
  ['end', ['end', 'end date', 'end_date', 'due', 'due date', 'deadline', 'to', 'finish']],
  ['status', ['status', 'state']],
  ['priority', ['priority', 'importance']],
  ['assignee', ['assignee', 'owner', 'person', 'responsible']],
];

function excelCellValue(cell) {
  const value = cell.value;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (value.result !== undefined) return value.result;
    if (value.richText) return value.richText.map((part) => part.text).join('');
    if (value.text !== undefined) return value.text;
  }
  return value;
}

function excelDateToIso(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  if (typeof value === 'number' && value > 0 && value < 200000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
  }
  const text = cleanText(value, 40);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

function localDateFromIso(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addIsoDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addIsoMonths(iso, months) {
  const [year, month] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, 1));
  return date.toISOString().slice(0, 10);
}

function excelArgb(hex, fallback = 'FF6C5CE7') {
  return /^#[0-9a-f]{6}$/i.test(String(hex)) ? `FF${hex.slice(1).toUpperCase()}` : fallback;
}

function solidFill(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function timelinePeriods(tasks) {
  const ranges = tasks.flatMap((task) => [
    [databaseDate(task.start_date), databaseDate(task.end_date)],
    ...(task.revisions || []).map((revision) => [
      databaseDate(revision.previous_start_date),
      databaseDate(revision.previous_end_date),
    ]),
  ]);
  if (!ranges.length) return { unit: 'day', periods: [] };

  const first = ranges.reduce((minimum, range) => (range[0] < minimum ? range[0] : minimum), ranges[0][0]);
  const last = ranges.reduce((maximum, range) => (range[1] > maximum ? range[1] : maximum), ranges[0][1]);
  const dayCount = Math.round((new Date(`${last}T00:00:00Z`) - new Date(`${first}T00:00:00Z`)) / 86_400_000) + 1;
  let unit = 'month';
  let cursor = `${first.slice(0, 7)}-01`;
  if (dayCount <= 45) {
    unit = 'day';
    cursor = first;
  } else if (dayCount <= 180) {
    unit = 'week';
    cursor = first;
  }

  const periods = [];
  while (cursor <= last && periods.length < 500) {
    let end;
    if (unit === 'day') {
      end = cursor;
    } else if (unit === 'week') {
      end = addIsoDays(cursor, 6);
    } else {
      const nextMonth = addIsoMonths(cursor, 1);
      end = addIsoDays(nextMonth, -1);
    }
    periods.push({ start: cursor, end });
    cursor = unit === 'day' ? addIsoDays(cursor, 1) : unit === 'week' ? addIsoDays(cursor, 7) : addIsoMonths(cursor, 1);
  }
  return { unit, periods };
}

function timelineHeaderParts(period, unit) {
  const start = new Date(`${period.start}T00:00:00Z`);
  const end = new Date(`${period.end}T00:00:00Z`);
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();
  const startMonth = start.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const endMonth = end.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return {
    year: startYear === endYear ? String(startYear) : `${startYear}/${endYear}`,
    month: startMonth === endMonth ? startMonth : `${startMonth}/${endMonth}`,
    day: unit === 'day' ? String(start.getUTCDate()) : unit === 'week' ? `${start.getUTCDate()}–${end.getUTCDate()}` : '',
  };
}

function mergeMatchingHeaders(sheet, rowNumber, firstColumn, values) {
  let groupStart = 0;
  for (let index = 1; index <= values.length; index += 1) {
    if (index === values.length || values[index] !== values[groupStart]) {
      if (index - groupStart > 1) {
        sheet.mergeCells(rowNumber, firstColumn + groupStart, rowNumber, firstColumn + index - 1);
      }
      groupStart = index;
    }
  }
}

function alternatingMonthFills(periods) {
  let band = -1;
  let previousMonth = '';
  return periods.map((period) => {
    const month = period.start.slice(0, 7);
    if (month !== previousMonth) {
      band += 1;
      previousMonth = month;
    }
    return band % 2 === 0 ? 'FFFFFFFF' : 'FFF4F2FC';
  });
}

function styleRawDataSheet(sheet, projectColor) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = solidFill(projectColor);
  header.height = 22;
  header.alignment = { vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'G1' };
  for (let rowNumber = 2; rowNumber <= 501; rowNumber += 1) {
    sheet.getCell(rowNumber, 5).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"Not started,In progress,Review,Done"'],
    };
    sheet.getCell(rowNumber, 6).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"Low,Medium,High"'],
    };
  }
}

function addTimelineSheet(workbook, project, tasks) {
  const sheet = workbook.addWorksheet('Timeline', { properties: { tabColor: { argb: excelArgb(project.color) } } });
  const detailColumns = [
    { header: 'Task', key: 'title', width: 32 },
    { header: 'Assignee', key: 'assignee', width: 18 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Version', key: 'version', width: 15 },
    { header: 'Start', key: 'start', width: 13 },
    { header: 'End', key: 'end', width: 13 },
    { header: 'Revision note', key: 'note', width: 35 },
  ];
  const { unit, periods } = timelinePeriods(tasks);
  sheet.columns = [
    ...detailColumns,
    ...periods.map((period, index) => ({
      key: `period${index}`,
      width: unit === 'day' ? 4 : unit === 'week' ? 8 : 9,
    })),
  ];

  const lastColumn = Math.max(detailColumns.length + periods.length, detailColumns.length);
  sheet.mergeCells(1, 1, 1, lastColumn);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = `${project.name} · Project Timeline`;
  titleCell.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = solidFill(excelArgb(project.color));
  titleCell.alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 32;

  sheet.getCell('A2').value = `Scale: ${unit === 'day' ? 'Daily' : unit === 'week' ? 'Weekly' : 'Monthly'}`;
  sheet.getCell('B2').value = 'Current plan';
  sheet.getCell('B2').fill = solidFill('FF6C5CE7');
  sheet.getCell('B2').font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('C2').value = 'Previous plan';
  sheet.getCell('C2').fill = solidFill('FFE2E4EA');
  sheet.getCell('C2').font = { bold: true, color: { argb: 'FF676B78' } };
  sheet.getCell('D2').value = 'Task color = scheduled period · Alternating background = month';
  sheet.mergeCells(2, 4, 2, 7);
  sheet.getRow(2).height = 22;

  detailColumns.forEach((column, index) => {
    const columnNumber = index + 1;
    sheet.mergeCells(4, columnNumber, 6, columnNumber);
    const cell = sheet.getCell(4, columnNumber);
    cell.value = column.header;
    cell.alignment = { vertical: 'middle', horizontal: index === 0 ? 'left' : 'center', wrapText: true };
  });
  const headerParts = periods.map((period) => timelineHeaderParts(period, unit));
  const monthFills = alternatingMonthFills(periods);
  const firstTimelineColumn = detailColumns.length + 1;
  headerParts.forEach((parts, index) => {
    const columnNumber = firstTimelineColumn + index;
    sheet.getCell(4, columnNumber).value = parts.year;
    sheet.getCell(5, columnNumber).value = parts.month;
    sheet.getCell(6, columnNumber).value = parts.day;
  });
  for (let rowNumber = 4; rowNumber <= 6; rowNumber += 1) {
    for (let columnNumber = 1; columnNumber <= lastColumn; columnNumber += 1) {
      const cell = sheet.getCell(rowNumber, columnNumber);
      cell.font = { bold: true, color: { argb: rowNumber === 4 && columnNumber >= firstTimelineColumn ? 'FFFFFFFF' : 'FF20212B' } };
      const timelineIndex = columnNumber - firstTimelineColumn;
      cell.fill = solidFill(rowNumber === 4 && columnNumber >= firstTimelineColumn
        ? excelArgb(project.color)
        : columnNumber >= firstTimelineColumn ? monthFills[timelineIndex] : 'FFEFEDFF');
      if (columnNumber >= firstTimelineColumn) {
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      }
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFD8D5ED' } } };
    }
  }
  mergeMatchingHeaders(sheet, 4, firstTimelineColumn, headerParts.map((parts) => parts.year));
  mergeMatchingHeaders(sheet, 5, firstTimelineColumn, headerParts.map((parts) => parts.month));
  sheet.getRow(4).height = 22;
  sheet.getRow(5).height = 21;
  sheet.getRow(6).height = 21;

  const currentColors = {
    todo: 'FF8F93A3', in_progress: 'FF6C5CE7', review: 'FFF2994A', done: 'FF00A896',
  };
  for (const task of tasks) {
    const versions = (task.revisions || []).map((revision, index) => ({
      version: `Previous ${index + 1}`,
      start: databaseDate(revision.previous_start_date),
      end: databaseDate(revision.previous_end_date),
      note: revision.note || '',
      previous: true,
    }));
    versions.push({
      version: 'Current', start: databaseDate(task.start_date), end: databaseDate(task.end_date), note: '', previous: false,
    });

    for (const version of versions) {
      const row = sheet.addRow({
        title: task.title,
        assignee: task.assignee,
        status: statusOptions[task.status] || task.status,
        version: version.version,
        start: localDateFromIso(version.start),
        end: localDateFromIso(version.end),
        note: version.note,
      });
      row.getCell(5).numFmt = 'yyyy-mm-dd';
      row.getCell(6).numFmt = 'yyyy-mm-dd';
      row.height = 22;
      row.alignment = { vertical: 'middle' };
      if (version.previous) {
        for (let column = 1; column <= detailColumns.length; column += 1) {
          row.getCell(column).font = { italic: true, color: { argb: 'FF777B88' } };
          row.getCell(column).fill = solidFill('FFF7F7F9');
        }
      } else {
        row.getCell(4).font = { bold: true, color: { argb: currentColors[task.status] || 'FF6C5CE7' } };
      }
      periods.forEach((period, index) => {
        const cell = row.getCell(detailColumns.length + index + 1);
        cell.fill = version.start <= period.end && version.end >= period.start
          ? solidFill(version.previous ? 'FFE2E4EA' : (currentColors[task.status] || 'FF6C5CE7'))
          : solidFill(monthFills[index]);
        cell.border = {
          left: { style: 'hair', color: { argb: 'FFE7E8ED' } },
          right: { style: 'hair', color: { argb: 'FFE7E8ED' } },
        };
      });
    }
  }

  if (!tasks.length) {
    sheet.mergeCells('A7:G7');
    sheet.getCell('A7').value = 'No tasks yet. Add rows in the Raw Data sheet, then import this file.';
    sheet.getCell('A7').font = { italic: true, color: { argb: 'FF777B88' } };
  }
  sheet.views = [{ state: 'frozen', xSplit: 7, ySplit: 6, topLeftCell: 'H7', activeCell: 'H7' }];
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  sheet.headerFooter.oddFooter = '&LFlowPlan&CPage &P of &N&R&D';
  return sheet;
}

function matchExcelOption(value, options) {
  const text = cleanText(value, 40).toLowerCase().replace(/[_-]+/g, ' ');
  if (!text) return null;
  const match = Object.entries(options).find(
    ([option, label]) => text === option.replaceAll('_', ' ') || text === label.toLowerCase(),
  );
  return match ? match[0] : undefined;
}

function parseTaskSheet(sheet) {
  const result = { tasks: [], rowErrors: [], missingColumns: [] };
  const columns = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cleanText(excelCellValue(cell), 60).toLowerCase();
    const match = excelImportFields.find(([, aliases]) => aliases.includes(text));
    if (match && !Object.values(columns).includes(match[0])) columns[colNumber] = match[0];
  });
  const fields = Object.values(columns);
  if (!fields.includes('title')) result.missingColumns.push('Task');
  if (!fields.includes('start')) result.missingColumns.push('Start');
  if (!fields.includes('end')) result.missingColumns.push('End');
  if (result.missingColumns.length || sheet.actualRowCount < 2) return result;

  if (sheet.actualRowCount - 1 > 500) {
    result.rowErrors.push('The file has more than 500 task rows. Split it into smaller files.');
    return result;
  }

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const field = columns[colNumber];
      if (field) record[field] = excelCellValue(cell);
    });
    const hasAnyValue = Object.values(record).some(
      (value) => value !== null && value !== undefined && String(value).trim() !== '',
    );
    if (!hasAnyValue) return;

    const title = cleanText(record.title, 180);
    const start = excelDateToIso(record.start);
    const end = excelDateToIso(record.end);
    const errors = [];
    if (!title) errors.push('enter a task name');
    if (!validDate(start)) errors.push('the start date is missing or not valid (use YYYY-MM-DD)');
    if (!validDate(end)) errors.push('the end date is missing or not valid (use YYYY-MM-DD)');
    if (validDate(start) && validDate(end) && end < start) errors.push('the end date is before the start date');

    const statusText = cleanText(record.status, 40);
    const status = matchExcelOption(statusText, statusOptions);
    if (status === undefined) errors.push(`status "${statusText}" is not recognized (use Not started, In progress, Review, or Done)`);
    const priorityText = cleanText(record.priority, 40);
    const priority = matchExcelOption(priorityText, priorityOptions);
    if (priority === undefined) errors.push(`priority "${priorityText}" is not recognized (use Low, Medium, or High)`);

    if (errors.length) {
      result.rowErrors.push(`Row ${rowNumber}: ${errors.join('; ')}.`);
      return;
    }
    result.tasks.push({
      title,
      description: cleanText(record.description, 2000),
      start,
      end,
      status: status || 'todo',
      priority: priority || 'medium',
      assignee: cleanText(record.assignee, 120),
    });
  });
  return result;
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

app.get('/api/projects/:projectId/export', requireAuth, async (req, res, next) => {
  try {
    const projectResult = await memberProject(req.user.id, req.params.projectId);
    if (!projectResult.rowCount) return res.status(404).json({ error: 'Project not found.' });
    const project = projectResult.rows[0];
    const taskResult = await pool.query(
      `SELECT t.*,
        COALESCE(
          json_agg(
            json_build_object(
              'previous_start_date', r.previous_start_date,
              'previous_end_date', r.previous_end_date,
              'note', r.note,
              'created_at', r.created_at
            ) ORDER BY r.created_at, r.id
          ) FILTER (WHERE r.id IS NOT NULL), '[]'
        ) AS revisions
       FROM tasks t
       LEFT JOIN task_revisions r ON r.task_id = t.id
       WHERE t.project_id = $1
       GROUP BY t.id
       ORDER BY t.start_date, t.end_date, t.id`,
      [project.id],
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'FlowPlan';
    workbook.created = new Date();
    addTimelineSheet(workbook, project, taskResult.rows);
    const sheet = workbook.addWorksheet('Raw Data');
    sheet.columns = excelColumns.map((column) => ({ ...column }));
    for (const task of taskResult.rows) {
      const row = sheet.addRow({
        title: task.title,
        description: task.description,
        start: localDateFromIso(databaseDate(task.start_date)),
        end: localDateFromIso(databaseDate(task.end_date)),
        status: statusOptions[task.status] || task.status,
        priority: priorityOptions[task.priority] || task.priority,
        assignee: task.assignee,
      });
      row.getCell('start').numFmt = 'yyyy-mm-dd';
      row.getCell('end').numFmt = 'yyyy-mm-dd';
    }
    styleRawDataSheet(sheet, excelArgb(project.color));
    workbook.views = [{ activeTab: 0 }];

    const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    res.setHeader('Content-Type', excelMime);
    res.setHeader('Content-Disposition', `attachment; filename="flowplan-${slug}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/projects/:projectId/import',
  requireAuth,
  express.raw({ type: [excelMime, 'application/vnd.ms-excel', 'application/octet-stream'], limit: '5mb' }),
  async (req, res, next) => {
    try {
      const projectResult = await memberProject(req.user.id, req.params.projectId);
      if (!projectResult.rowCount) return res.status(404).json({ error: 'Project not found.' });
      const project = projectResult.rows[0];
      const importMode = cleanText(req.query.mode, 20) || 'replace';
      if (!['replace', 'append'].includes(importMode)) {
        return res.status(400).json({ error: 'Import mode must be replace or append.' });
      }
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'Send an Excel (.xlsx) file as the request body.' });
      }

      const workbook = new ExcelJS.Workbook();
      try {
        await workbook.xlsx.load(req.body);
      } catch {
        return res.status(400).json({ error: 'This file is not a valid Excel (.xlsx) file.' });
      }
      const sheet = workbook.getWorksheet('Raw Data') || workbook.getWorksheet('Tasks') || workbook.worksheets[0];
      if (!sheet) return res.status(400).json({ error: 'The Excel file has no worksheet.' });

      const { tasks, rowErrors, missingColumns } = parseTaskSheet(sheet);
      if (missingColumns.length) {
        return res.status(400).json({ error: `Add these columns to the first row: ${missingColumns.join(', ')}.` });
      }
      if (rowErrors.length) {
        return res.status(400).json({ error: 'Some rows are not valid. Fix them and import the file again.', rowErrors });
      }
      if (!tasks.length) {
        return res.status(400).json({ error: 'The Excel file has no task rows to import.' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let replaced = 0;
        if (importMode === 'replace') {
          const deleted = await client.query('DELETE FROM tasks WHERE project_id = $1', [project.id]);
          replaced = deleted.rowCount;
        }
        for (const task of tasks) {
          await client.query(
            `INSERT INTO tasks
              (project_id, title, description, start_date, end_date, status, priority, assignee, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [project.id, task.title, task.description, task.start, task.end, task.status, task.priority, task.assignee, req.user.id],
          );
        }
        await client.query('UPDATE projects SET updated_at = NOW() WHERE id = $1', [project.id]);
        await client.query('COMMIT');
        res.status(201).json({ imported: tasks.length, mode: importMode, replaced });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  },
);

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
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'The request is too large. Keep files under 5 MB.' });
  }
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
