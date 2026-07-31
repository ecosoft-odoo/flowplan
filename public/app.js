const state = {
  user: null,
  projects: [],
  selectedProjectId: null,
  project: null,
  tasks: [],
  selectedTaskId: null,
  filter: 'all',
  loadingCount: 0,
  toastTimer: null,
  taskOriginalDates: null,
  zoomIndex: 3,
  fitAll: false,
  timelineLabelWidth: 300,
};

const el = (id) => document.getElementById(id);
const statusLabels = {
  todo: 'Not started',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};
const priorityLabels = { low: 'Low', medium: 'Medium', high: 'High' };
const taskColors = {
  todo: '#8f93a3',
  in_progress: '#6c5ce7',
  review: '#f2994a',
  done: '#00a896',
};
const zoomLevels = [2, 4, 8, 14, 22];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

function parseDate(value) {
  return new Date(`${dateOnly(value)}T00:00:00Z`);
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function localToday() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(value, days) {
  const date = value instanceof Date ? new Date(value) : parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function daysBetween(start, end) {
  return Math.round((parseDate(end) - parseDate(start)) / 86_400_000);
}

function formatDate(value, options = {}) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: options.long ? 'long' : 'short',
    year: options.year ? 'numeric' : undefined,
    timeZone: 'UTC',
  }).format(parseDate(value));
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function initials(name) {
  const parts = String(name || 'FP').trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]).join('').toUpperCase();
}

function setLoading(active) {
  state.loadingCount = Math.max(0, state.loadingCount + (active ? 1 : -1));
  el('loading').classList.toggle('hidden', state.loadingCount === 0);
}

function showToast(message, type = 'success') {
  clearTimeout(state.toastTimer);
  el('toastText').textContent = message;
  el('toastIcon').textContent = type === 'error' ? '!' : '✓';
  el('toast').classList.toggle('error', type === 'error');
  el('toast').classList.add('visible');
  state.toastTimer = setTimeout(() => el('toast').classList.remove('visible'), 3200);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && !url.includes('/auth/login')) showAuth();
    throw new Error(data?.error || 'Could not complete this action.');
  }
  return data;
}

function showAuth() {
  el('appShell').classList.add('hidden');
  el('authScreen').classList.remove('hidden');
  closeDrawer();
  closeModals();
}

function showApp() {
  el('authScreen').classList.add('hidden');
  el('appShell').classList.remove('hidden');
  const avatar = initials(state.user.name);
  el('userName').textContent = state.user.name;
  el('userEmail').textContent = state.user.email;
  el('userAvatar').textContent = avatar;
  el('topAvatar').textContent = avatar;
}

async function initialize() {
  setLoading(true);
  try {
    const data = await api('/api/auth/me');
    state.user = data.user;
    showApp();
    await loadProjects();
  } catch (error) {
    showAuth();
    if (!String(error.message).toLowerCase().includes('sign in')) showToast(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function authenticate(mode) {
  const isLogin = mode === 'login';
  const payload = isLogin
    ? { email: el('loginEmail').value, password: el('loginPassword').value }
    : { name: el('registerName').value, email: el('registerEmail').value, password: el('registerPassword').value };
  setLoading(true);
  try {
    const data = await api(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(payload) });
    state.user = data.user;
    showApp();
    await loadProjects();
    showToast(isLogin ? 'Signed in' : 'Account created');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function loadProjects(preferredId = null) {
  const data = await api('/api/projects');
  state.projects = data.projects;
  const savedId = Number(localStorage.getItem('flowplan_project'));
  const target = Number(preferredId) || savedId;
  state.selectedProjectId = state.projects.some((project) => project.id === target)
    ? target
    : state.projects[0]?.id || null;
  renderProjectList();
  if (state.selectedProjectId) await loadTimeline(state.selectedProjectId);
  else renderNoProject();
}

function renderProjectList() {
  el('projectList').innerHTML = state.projects.map((project) => `
    <button class="project-nav ${project.id === state.selectedProjectId ? 'active' : ''}" data-project-id="${project.id}">
      <i class="project-dot" style="--project-color:${escapeHtml(project.color)}"></i>
      <span>${escapeHtml(project.name)}</span>
      <small>${project.task_count}</small>
    </button>
  `).join('');
}

function renderNoProject() {
  state.project = null;
  state.tasks = [];
  el('topProjectName').textContent = 'No project yet';
  el('projectName').textContent = 'Create your first project';
  el('projectDescription').textContent = 'Keep each plan separate and track all its tasks on one timeline.';
  el('projectColor').style.background = '#6C5CE7';
  renderStats();
  renderTimeline();
}

async function selectProject(projectId) {
  state.selectedProjectId = Number(projectId);
  localStorage.setItem('flowplan_project', state.selectedProjectId);
  renderProjectList();
  closeMobileSidebar();
  setLoading(true);
  try {
    await loadTimeline(state.selectedProjectId);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function loadTimeline(projectId) {
  const data = await api(`/api/projects/${projectId}/timeline`);
  state.project = data.project;
  state.tasks = data.tasks.map((task) => ({
    ...task,
    start_date: dateOnly(task.start_date),
    end_date: dateOnly(task.end_date),
    revisions: (task.revisions || []).map((revision) => ({
      ...revision,
      previous_start_date: dateOnly(revision.previous_start_date),
      previous_end_date: dateOnly(revision.previous_end_date),
      new_start_date: dateOnly(revision.new_start_date),
      new_end_date: dateOnly(revision.new_end_date),
    })),
  }));
  el('topProjectName').textContent = state.project.name;
  el('projectName').textContent = state.project.name;
  el('projectDescription').textContent = state.project.description || 'No project description yet.';
  el('projectColor').style.background = state.project.color;
  renderStats();
  renderTimeline();
}

function renderStats() {
  const total = state.tasks.length;
  const progress = state.tasks.filter((task) => ['in_progress', 'review'].includes(task.status)).length;
  const done = state.tasks.filter((task) => task.status === 'done').length;
  const today = localToday();
  const sevenDays = toIsoDate(addDays(new Date(), 7));
  const due = state.tasks.filter((task) => task.status !== 'done' && task.end_date >= today && task.end_date <= sevenDays).length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  el('statTotal').textContent = total;
  el('statProgress').textContent = progress;
  el('statDue').textContent = due;
  el('statPercent').textContent = `${percent}%`;
  el('progressCaption').textContent = `${done} of ${total} tasks`;
  el('progressBar').style.width = `${percent}%`;
}

function timelineBounds(tasks) {
  const dates = [];
  for (const task of tasks) {
    dates.push(task.start_date, task.end_date);
    for (const revision of task.revisions) {
      dates.push(revision.previous_start_date, revision.previous_end_date);
    }
  }
  const today = localToday();
  if (!dates.length) dates.push(today, toIsoDate(addDays(today, 28)));
  const min = new Date(Math.min(...dates.map((date) => parseDate(date).getTime())));
  const max = new Date(Math.max(...dates.map((date) => parseDate(date).getTime())));
  min.setUTCDate(min.getUTCDate() - ((min.getUTCDay() + 6) % 7) - 7);
  max.setUTCDate(max.getUTCDate() + (7 - ((max.getUTCDay() + 6) % 7)) + 7);
  const span = Math.max(28, daysBetween(toIsoDate(min), toIsoDate(max)) + 1);
  return { start: toIsoDate(min), end: toIsoDate(addDays(min, span - 1)), days: span };
}

function barPosition(start, end, bounds) {
  const leftDays = daysBetween(bounds.start, start);
  const widthDays = daysBetween(start, end) + 1;
  return {
    left: Math.max(0, (leftDays / bounds.days) * 100),
    width: Math.max(0.35, (widthDays / bounds.days) * 100),
  };
}

function getPeriodEnd(start, type) {
  const date = parseDate(start);
  if (type === 'week') return addDays(date, 6);
  if (type === 'month') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  const nextQuarterMonth = Math.floor(date.getUTCMonth() / 3) * 3 + 3;
  return new Date(Date.UTC(date.getUTCFullYear(), nextQuarterMonth, 0));
}

function periodLabel(start, type) {
  const date = parseDate(start);
  if (type === 'quarter') {
    return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
  }
  if (type === 'month') {
    return new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
  }
  return formatDate(start);
}

function buildTimelinePeriods(bounds) {
  const type = !state.fitAll
    ? 'week'
    : bounds.days > 370
      ? 'quarter'
      : bounds.days > 120
        ? 'month'
        : 'week';
  const periods = [];
  let cursor = bounds.start;
  while (cursor <= bounds.end) {
    const rawEnd = toIsoDate(getPeriodEnd(cursor, type));
    const end = rawEnd > bounds.end ? bounds.end : rawEnd;
    const days = daysBetween(cursor, end) + 1;
    periods.push({
      start: cursor,
      end,
      days,
      label: periodLabel(cursor, type),
      secondary: !state.fitAll && type === 'week' ? formatDate(end) : '',
    });
    cursor = toIsoDate(addDays(end, 1));
  }
  return periods;
}

function updateZoomControls() {
  el('zoomOutBtn').disabled = state.fitAll || state.zoomIndex === 0;
  el('zoomInBtn').disabled = !state.fitAll && state.zoomIndex === zoomLevels.length - 1;
  el('fitAllBtn').classList.toggle('active', state.fitAll);
  el('fitAllBtn').setAttribute('aria-pressed', String(state.fitAll));
  el('fitAllBtn').title = state.fitAll ? 'Return to detailed view' : 'Fit the full plan on screen';
}

function renderTimeline() {
  const filteredTasks = state.tasks
    .filter((task) => state.filter === 'all' || task.status === state.filter)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.end_date.localeCompare(b.end_date));
  const hasAnyTask = state.tasks.length > 0;
  el('timelineViewport').classList.toggle('hidden', !hasAnyTask);
  el('emptyTimeline').classList.toggle('hidden', hasAnyTask);
  if (!hasAnyTask) {
    el('timeline').innerHTML = '';
    updateZoomControls();
    return;
  }

  const bounds = timelineBounds(state.tasks);
  const viewport = el('timelineViewport');
  const viewportWidth = Math.max(320, viewport.clientWidth);
  const detailLabelWidth = window.matchMedia('(max-width: 1080px)').matches ? 270 : 300;
  const fitLabelWidth = Math.round(Math.min(240, Math.max(132, viewportWidth * .26)));
  const labelWidth = state.fitAll ? fitLabelWidth : detailLabelWidth;
  const timelineWidth = state.fitAll
    ? viewportWidth
    : Math.max(viewportWidth, labelWidth + bounds.days * zoomLevels[state.zoomIndex]);
  const timeline = el('timeline');
  state.timelineLabelWidth = labelWidth;
  timeline.style.width = `${timelineWidth}px`;
  timeline.style.setProperty('--label-width', `${labelWidth}px`);
  timeline.classList.toggle('fit-mode', state.fitAll);
  updateZoomControls();

  const periods = buildTimelinePeriods(bounds);
  const calendar = periods.map((period) => {
    const width = (period.days / bounds.days) * 100;
    return `<div class="calendar-unit" style="width:${width}%;flex-basis:${width}%"><span>${period.label}</span>${period.secondary ? `<small>${period.secondary}</small>` : ''}</div>`;
  }).join('');
  const periodLines = periods.slice(1).map((period) => {
    const left = (daysBetween(bounds.start, period.start) / bounds.days) * 100;
    return `<i class="period-line" style="left:${left}%"></i>`;
  }).join('');

  const today = localToday();
  const todayPercent = today >= bounds.start && today <= bounds.end
    ? (daysBetween(bounds.start, today) / bounds.days) * 100
    : null;
  const todayLine = todayPercent === null ? '' : `<i class="today-line" style="left:${todayPercent}%" title="Today, ${formatDate(today, { year: true })}"></i>`;

  const rows = filteredTasks.map((task) => {
    const current = barPosition(task.start_date, task.end_date, bounds);
    const revisions = task.revisions.map((revision, index) => {
      const old = barPosition(revision.previous_start_date, revision.previous_end_date, bounds);
      const currentCenter = current.left + current.width / 2;
      const oldCenter = old.left + old.width / 2;
      const connectorLeft = Math.min(currentCenter, oldCenter);
      const connectorWidth = Math.abs(currentCenter - oldCenter);
      return `
        <i class="revision-bar" style="left:${old.left}%;width:${old.width}%;opacity:${Math.max(.48, 1 - index * .14)}" title="Old plan: ${formatDate(revision.previous_start_date)} – ${formatDate(revision.previous_end_date)}"></i>
        <i class="revision-connector" style="left:${connectorLeft}%;width:${connectorWidth}%"></i>`;
    }).join('');
    const revisionMark = task.revisions.length ? `<span class="revision-mark" title="Revised ${task.revisions.length} time${task.revisions.length > 1 ? 's' : ''}">R${task.revisions.length}</span>` : '';
    return `
      <div class="timeline-row" data-task-id="${task.id}">
        <div class="task-cell">
          <i class="task-priority priority-${task.priority}"></i>
          <div class="task-copy"><b>${escapeHtml(task.title)}</b><span>${escapeHtml(task.assignee || 'No assignee')}<i></i>${formatDate(task.start_date)} – ${formatDate(task.end_date)}</span></div>
          ${revisionMark || `<span class="status-pill status-${task.status}">${statusLabels[task.status]}</span>`}
        </div>
        <div class="plot-cell">
          ${periodLines}${todayLine}${revisions}
          <span class="task-bar ${task.status === 'done' ? 'done' : ''}" style="left:${current.left}%;width:${current.width}%;--bar-color:${taskColors[task.status]}" title="${escapeHtml(task.title)}: ${formatDate(task.start_date)} – ${formatDate(task.end_date)}">${current.width > (state.fitAll ? 10 : 7) ? escapeHtml(task.title) : ''}</span>
        </div>
      </div>`;
  }).join('');

  const noFiltered = filteredTasks.length === 0
    ? `<div class="no-revisions" style="margin:24px">No tasks with this status.</div>`
    : rows;
  el('timeline').innerHTML = `
    <div class="timeline-header">
      <div class="task-label-head">TASK / DATES</div>
      <div class="calendar-head">${calendar}</div>
    </div>${noFiltered}`;

  if (state.fitAll) requestAnimationFrame(() => { viewport.scrollLeft = 0; });
}

function openProjectModal() {
  el('projectForm').reset();
  openModal('projectModal');
  setTimeout(() => el('projectFormName').focus(), 50);
}

function openTaskModal(task = null) {
  if (!state.selectedProjectId) {
    openProjectModal();
    showToast('Create a project before adding a task.', 'error');
    return;
  }
  el('taskForm').reset();
  const today = localToday();
  el('taskId').value = task?.id || '';
  el('taskTitle').value = task?.title || '';
  el('taskDescription').value = task?.description || '';
  el('taskStart').value = task?.start_date || today;
  el('taskEnd').value = task?.end_date || toIsoDate(addDays(today, 7));
  el('taskStatus').value = task?.status || 'todo';
  el('taskPriority').value = task?.priority || 'medium';
  el('taskAssignee').value = task?.assignee || '';
  el('revisionNote').value = '';
  el('taskModalEyebrow').textContent = task ? 'EDIT / REVISION' : 'NEW TASK';
  el('taskModalTitle').textContent = task ? 'Edit Task' : 'Add Task';
  el('taskSubmitBtn').textContent = task ? 'Save changes' : 'Add Task';
  state.taskOriginalDates = task ? { start: task.start_date, end: task.end_date } : null;
  updateRevisionNoteVisibility();
  closeDrawer();
  openModal('taskModal');
  setTimeout(() => el('taskTitle').focus(), 50);
}

function updateRevisionNoteVisibility() {
  const datesChanged = state.taskOriginalDates && (
    el('taskStart').value !== state.taskOriginalDates.start || el('taskEnd').value !== state.taskOriginalDates.end
  );
  el('revisionNoteWrap').classList.toggle('hidden', !datesChanged);
}

function openModal(id) {
  el('modalBackdrop').classList.remove('hidden');
  el(id).classList.remove('hidden');
}

function closeModals() {
  el('projectModal').classList.add('hidden');
  el('taskModal').classList.add('hidden');
  if (!el('revisionDrawer').classList.contains('open')) el('modalBackdrop').classList.add('hidden');
}

async function saveProject(event) {
  event.preventDefault();
  const payload = {
    name: el('projectFormName').value,
    description: el('projectFormDescription').value,
    color: document.querySelector('input[name="projectColor"]:checked').value,
  };
  setLoading(true);
  try {
    const data = await api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
    closeModals();
    await loadProjects(data.project.id);
    showToast('New project created');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function saveTask(event) {
  event.preventDefault();
  const taskId = Number(el('taskId').value) || null;
  const payload = {
    title: el('taskTitle').value,
    description: el('taskDescription').value,
    start_date: el('taskStart').value,
    end_date: el('taskEnd').value,
    status: el('taskStatus').value,
    priority: el('taskPriority').value,
    assignee: el('taskAssignee').value,
    revision_note: el('revisionNote').value,
  };
  if (payload.end_date < payload.start_date) {
    showToast('The end date cannot be before the start date.', 'error');
    return;
  }
  setLoading(true);
  try {
    if (taskId) {
      await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await api(`/api/projects/${state.selectedProjectId}/tasks`, { method: 'POST', body: JSON.stringify(payload) });
    }
    closeModals();
    await Promise.all([loadTimeline(state.selectedProjectId), refreshProjectList()]);
    showToast(taskId ? 'Task and revision saved' : 'Task added to the timeline');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function refreshProjectList() {
  const data = await api('/api/projects');
  state.projects = data.projects;
  renderProjectList();
}

function openTaskDrawer(taskId) {
  const task = state.tasks.find((item) => item.id === Number(taskId));
  if (!task) return;
  state.selectedTaskId = task.id;
  el('drawerTitle').textContent = task.title;
  el('revisionCount').textContent = task.revisions.length;
  el('drawerMeta').innerHTML = `
    <div class="meta-box"><small>CURRENT DATES</small><b>${formatDate(task.start_date)} – ${formatDate(task.end_date)}</b></div>
    <div class="meta-box"><small>STATUS</small><b>${statusLabels[task.status]}</b></div>
    <div class="meta-box"><small>ASSIGNEE</small><b>${escapeHtml(task.assignee || 'Not set')}</b></div>
    <div class="meta-box"><small>PRIORITY</small><b>${priorityLabels[task.priority]}</b></div>`;
  el('revisionList').innerHTML = task.revisions.length
    ? [...task.revisions].reverse().map((revision, reverseIndex) => `
      <article class="revision-item">
        <time>Revision ${task.revisions.length - reverseIndex} · ${formatDateTime(revision.created_at)}</time>
        <div class="revision-dates"><del>${formatDate(revision.previous_start_date)} – ${formatDate(revision.previous_end_date)}</del><b>→</b><span>${formatDate(revision.new_start_date)} – ${formatDate(revision.new_end_date)}</span></div>
        <p>${escapeHtml(revision.note || 'No note for this revision.')}</p>
      </article>`).join('')
    : '<div class="no-revisions">This task has no revisions yet.<br />Date changes will appear here.</div>';
  el('revisionDrawer').classList.add('open');
  el('revisionDrawer').setAttribute('aria-hidden', 'false');
  el('modalBackdrop').classList.remove('hidden');
}

function closeDrawer() {
  el('revisionDrawer').classList.remove('open');
  el('revisionDrawer').setAttribute('aria-hidden', 'true');
  if (el('projectModal').classList.contains('hidden') && el('taskModal').classList.contains('hidden')) {
    el('modalBackdrop').classList.add('hidden');
  }
}

function closeMobileSidebar() {
  el('sidebar').classList.remove('open');
  el('sidebarBackdrop').classList.remove('visible');
}

function changeTimelineZoom(direction) {
  const viewport = el('timelineViewport');
  const oldScrollableWidth = Math.max(1, viewport.scrollWidth - viewport.clientWidth);
  const scrollRatio = viewport.scrollLeft / oldScrollableWidth;
  if (state.fitAll) {
    state.fitAll = false;
  } else {
    state.zoomIndex = Math.max(0, Math.min(zoomLevels.length - 1, state.zoomIndex + direction));
  }
  renderTimeline();
  requestAnimationFrame(() => {
    const newScrollableWidth = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    viewport.scrollLeft = newScrollableWidth * scrollRatio;
  });
}

function toggleFitAll() {
  state.fitAll = !state.fitAll;
  renderTimeline();
  if (state.fitAll) {
    showToast('The full plan now fits on screen');
  } else {
    requestAnimationFrame(scrollToToday);
  }
}

function scrollToToday() {
  const line = el('timeline').querySelector('.today-line');
  if (!line) {
    showToast('Today is outside the timeline shown.', 'error');
    return;
  }
  const viewport = el('timelineViewport');
  const target = line.offsetLeft - viewport.clientWidth / 2 + state.timelineLabelWidth;
  viewport.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
}

function bindEvents() {
  el('loginForm').addEventListener('submit', (event) => { event.preventDefault(); authenticate('login'); });
  el('registerForm').addEventListener('submit', (event) => { event.preventDefault(); authenticate('register'); });
  el('demoLogin').addEventListener('click', () => {
    el('loginEmail').value = 'demo@flowplan.local';
    el('loginPassword').value = 'demo1234';
    authenticate('login');
  });
  el('showRegister').addEventListener('click', () => { el('loginView').classList.add('hidden'); el('registerView').classList.remove('hidden'); });
  el('showLogin').addEventListener('click', () => { el('registerView').classList.add('hidden'); el('loginView').classList.remove('hidden'); });
  el('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* local logout still applies */ }
    state.user = null;
    showAuth();
  });
  el('projectList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-project-id]');
    if (button) selectProject(button.dataset.projectId);
  });
  el('newProjectQuick').addEventListener('click', openProjectModal);
  el('newTaskBtn').addEventListener('click', () => openTaskModal());
  el('emptyAddTask').addEventListener('click', () => openTaskModal());
  el('projectForm').addEventListener('submit', saveProject);
  el('taskForm').addEventListener('submit', saveTask);
  el('taskStart').addEventListener('change', updateRevisionNoteVisibility);
  el('taskEnd').addEventListener('change', updateRevisionNoteVisibility);
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeModals));
  el('modalBackdrop').addEventListener('click', () => { closeDrawer(); closeModals(); });
  el('timeline').addEventListener('click', (event) => {
    const row = event.target.closest('[data-task-id]');
    if (row) openTaskDrawer(row.dataset.taskId);
  });
  el('closeDrawer').addEventListener('click', closeDrawer);
  el('editTaskBtn').addEventListener('click', () => {
    const task = state.tasks.find((item) => item.id === state.selectedTaskId);
    if (task) openTaskModal(task);
  });
  el('statusFilter').addEventListener('change', (event) => { state.filter = event.target.value; renderTimeline(); });
  el('zoomOutBtn').addEventListener('click', () => changeTimelineZoom(-1));
  el('zoomInBtn').addEventListener('click', () => changeTimelineZoom(1));
  el('fitAllBtn').addEventListener('click', toggleFitAll);
  el('todayBtn').addEventListener('click', scrollToToday);
  el('openSidebar').addEventListener('click', () => { el('sidebar').classList.add('open'); el('sidebarBackdrop').classList.add('visible'); });
  el('closeSidebar').addEventListener('click', closeMobileSidebar);
  el('sidebarBackdrop').addEventListener('click', closeMobileSidebar);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeDrawer(); closeModals(); closeMobileSidebar(); }
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.fitAll && state.tasks.length) renderTimeline();
    }, 120);
  });
}

bindEvents();
initialize();
