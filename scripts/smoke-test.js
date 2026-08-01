const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3000';
const excelMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

async function run() {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok');

  const page = await request('/');
  assert.equal(page.response.status, 200);
  assert.match(page.body, /id="fitAllBtn"/);
  assert.match(page.body, /Project Timeline/);

  const unauthorized = await request('/api/projects');
  assert.equal(unauthorized.response.status, 401);

  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@flowplan.local', password: 'demo1234' }),
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.user.email, 'demo@flowplan.local');
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Login did not return an auth cookie');

  const projects = await request('/api/projects', { headers: { cookie } });
  assert.equal(projects.response.status, 200);
  assert.ok(projects.body.projects.length > 0, 'Demo project was not created');

  const timeline = await request(`/api/projects/${projects.body.projects[0].id}/timeline`, {
    headers: { cookie },
  });
  assert.equal(timeline.response.status, 200);
  assert.ok(timeline.body.tasks.length >= 5, 'Demo timeline is missing tasks');
  const initialTaskCount = timeline.body.tasks.length;
  const revisionCount = timeline.body.tasks.reduce(
    (count, task) => count + task.revisions.length,
    0,
  );
  assert.ok(revisionCount >= 2, 'Demo timeline is missing revision history');

  const projectId = projects.body.projects[0].id;

  const exportFile = await fetch(`${baseUrl}/api/projects/${projectId}/export`, { headers: { cookie } });
  assert.equal(exportFile.status, 200);
  assert.match(exportFile.headers.get('content-type') || '', /spreadsheetml/);
  assert.match(exportFile.headers.get('content-disposition') || '', /flowplan-.*\.xlsx/);
  const exported = Buffer.from(await exportFile.arrayBuffer());
  assert.equal(exported.subarray(0, 2).toString(), 'PK', 'Export is not a valid xlsx file');

  const exportedWorkbook = new ExcelJS.Workbook();
  await exportedWorkbook.xlsx.load(exported);
  assert.deepEqual(exportedWorkbook.worksheets.map((worksheet) => worksheet.name), ['Timeline', 'Raw Data']);
  const timelineSheet = exportedWorkbook.getWorksheet('Timeline');
  const rawDataSheet = exportedWorkbook.getWorksheet('Raw Data');
  assert.equal(timelineSheet.getCell('A4').value, 'Task');
  assert.equal(timelineSheet.getCell('D4').value, 'Version');
  assert.match(String(timelineSheet.getCell('H4').value), /^\d{4}(\/\d{4})?$/);
  assert.match(String(timelineSheet.getCell('H5').value), /^[A-Z][a-z]{2}(\/[A-Z][a-z]{2})?$/);
  assert.match(String(timelineSheet.getCell('H6').value), /^\d{1,2}(–\d{1,2})?$/);
  const timelineHeaderFills = new Set();
  for (let column = 8; column <= timelineSheet.columnCount; column += 1) {
    timelineHeaderFills.add(timelineSheet.getRow(6).getCell(column).fill.fgColor?.argb);
  }
  assert.ok(timelineHeaderFills.has('FFFFFFFF') && timelineHeaderFills.has('FFF4F2FC'), 'Timeline months should alternate background colors');
  assert.equal(rawDataSheet.getCell('A1').value, 'Task');
  assert.equal(rawDataSheet.getCell('A2').value, timeline.body.tasks[0].title);
  const versionValues = [];
  timelineSheet.getColumn(4).eachCell((cell, rowNumber) => {
    if (rowNumber >= 7) versionValues.push(cell.value);
  });
  assert.ok(versionValues.includes('Current'), 'Timeline export is missing current task rows');
  assert.ok(versionValues.some((value) => String(value).startsWith('Previous')), 'Timeline export is missing revision rows');
  const previousRowNumber = versionValues.findIndex((value) => String(value).startsWith('Previous')) + 7;
  assert.equal(timelineSheet.getRow(previousRowNumber).getCell(8).fill.type, 'pattern');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Tasks');
  sheet.addRow(['Task', 'Start', 'End', 'Status', 'Priority', 'Assignee']);
  sheet.addRow(['Smoke import (text dates)', '2026-08-10', '2026-08-14', 'In progress', 'High', 'CI Bot']);
  const dateRow = sheet.addRow(['Smoke import (excel dates)', new Date(2026, 7, 17), new Date(2026, 7, 21), 'Done', 'Low', 'CI Bot']);
  dateRow.getCell(2).numFmt = 'yyyy-mm-dd';
  dateRow.getCell(3).numFmt = 'yyyy-mm-dd';
  const imported = await request(`/api/projects/${projectId}/import?mode=append`, {
    method: 'POST',
    headers: { cookie, 'content-type': excelMime },
    body: await workbook.xlsx.writeBuffer(),
  });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.body.imported, 2);
  assert.equal(imported.body.mode, 'append');
  assert.equal(imported.body.replaced, 0);

  const roundTrip = await request(`/api/projects/${projectId}/import`, {
    method: 'POST',
    headers: { cookie, 'content-type': excelMime },
    body: exported,
  });
  assert.equal(roundTrip.response.status, 201);
  assert.equal(roundTrip.body.imported, initialTaskCount, 'Round-trip import should add every exported task');
  assert.equal(roundTrip.body.mode, 'replace');
  assert.equal(roundTrip.body.replaced, initialTaskCount + 2);

  const afterImport = await request(`/api/projects/${projectId}/timeline`, { headers: { cookie } });
  assert.equal(afterImport.body.tasks.length, initialTaskCount, 'Replace import should leave only the imported tasks');

  const invalidWorkbook = new ExcelJS.Workbook();
  const invalidSheet = invalidWorkbook.addWorksheet('Tasks');
  invalidSheet.addRow(['Task', 'Start', 'End']);
  invalidSheet.addRow(['', '2026-08-10', '2026-08-05']);
  const invalid = await request(`/api/projects/${projectId}/import`, {
    method: 'POST',
    headers: { cookie, 'content-type': excelMime },
    body: await invalidWorkbook.xlsx.writeBuffer(),
  });
  assert.equal(invalid.response.status, 400);
  assert.ok(invalid.body.rowErrors.length >= 1, 'Invalid rows should be reported');

  const notExcel = await request(`/api/projects/${projectId}/import`, {
    method: 'POST',
    headers: { cookie, 'content-type': excelMime },
    body: Buffer.from('this is not an excel file'),
  });
  assert.equal(notExcel.response.status, 400);

  console.log(JSON.stringify({
    status: 'passed',
    projects: projects.body.projects.length,
    tasks: afterImport.body.tasks.length,
    revisions: revisionCount,
    imported: imported.body.imported + roundTrip.body.imported,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
