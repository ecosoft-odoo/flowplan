const assert = require('node:assert/strict');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3000';

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
  const revisionCount = timeline.body.tasks.reduce(
    (count, task) => count + task.revisions.length,
    0,
  );
  assert.ok(revisionCount >= 2, 'Demo timeline is missing revision history');

  console.log(JSON.stringify({
    status: 'passed',
    projects: projects.body.projects.length,
    tasks: timeline.body.tasks.length,
    revisions: revisionCount,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
