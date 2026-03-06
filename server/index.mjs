import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? '8787');
const DATA_DIR = process.env.TASKFORGE_DATA_DIR ?? path.join(process.cwd(), '.taskforge-data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const AUTH_USERNAME = process.env.TASKFORGE_USERNAME ?? 'raza';
const AUTH_PASSWORD = process.env.TASKFORGE_PASSWORD ?? 'password';
const AUTH_TOKEN = process.env.TASKFORGE_TOKEN ?? 'taskforge-shared-token';

function defaultState() {
  return {
    tabs: [
      {
        id: 'home',
        name: 'Home',
        text: '',
        selectionStart: 0,
        selectionEnd: 0,
      },
    ],
    activeTabId: 'home',
    macros: [
      { id: 'macro_lx', trigger: ';lx', replacement: 'los angeles' },
      { id: 'macro_nyc', trigger: ';nyc', replacement: 'new york city' },
    ],
    savedSearches: [
      { id: 'search_not_done', name: 'Not Done', query: '-@done' },
      { id: 'search_due_today', name: 'Due Today', query: '@due(today) -@done' },
      { id: 'search_started', name: 'Started', query: '@start' },
    ],
    sectionVisibility: {
      projects: true,
      searches: true,
      tags: true,
      macros: true,
    },
    sidebarCollapsed: false,
    darkMode: false,
  };
}

function normalizeState(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input;
  if (!Array.isArray(candidate.tabs) || candidate.tabs.length === 0) {
    return null;
  }

  const tabs = candidate.tabs
    .filter((tab) => tab && typeof tab === 'object' && tab.id && tab.name && typeof tab.text === 'string')
    .map((tab) => ({
      id: String(tab.id),
      name: String(tab.name),
      text: String(tab.text),
      selectionStart: Number.isFinite(tab.selectionStart) ? Number(tab.selectionStart) : String(tab.text).length,
      selectionEnd: Number.isFinite(tab.selectionEnd) ? Number(tab.selectionEnd) : String(tab.text).length,
    }));

  if (tabs.length === 0) {
    return null;
  }

  const activeTabId = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : tabs[0].id;
  const macros = Array.isArray(candidate.macros)
    ? candidate.macros
        .filter((macro) => macro && typeof macro === 'object' && macro.trigger && macro.replacement)
        .map((macro) => ({
          id: macro.id ? String(macro.id) : `macro_${Date.now()}`,
          trigger: String(macro.trigger),
          replacement: String(macro.replacement),
        }))
    : [];
  const savedSearches = Array.isArray(candidate.savedSearches)
    ? candidate.savedSearches
        .filter((search) => search && typeof search === 'object' && search.id && search.name)
        .map((search) => ({
          id: String(search.id),
          name: String(search.name),
          query: typeof search.query === 'string' ? search.query : '',
        }))
    : [];
  const sectionVisibility =
    candidate.sectionVisibility && typeof candidate.sectionVisibility === 'object'
      ? {
          projects: Boolean(candidate.sectionVisibility.projects),
          searches: Boolean(candidate.sectionVisibility.searches),
          tags: Boolean(candidate.sectionVisibility.tags),
          macros: Boolean(candidate.sectionVisibility.macros),
        }
      : defaultState().sectionVisibility;

  return {
    tabs,
    activeTabId,
    macros,
    savedSearches,
    sectionVisibility,
    sidebarCollapsed: Boolean(candidate.sidebarCollapsed),
    darkMode: Boolean(candidate.darkMode),
  };
}

async function ensureStateFile() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await access(STATE_FILE);
  } catch {
    await writeState(defaultState());
  }
}

async function readState() {
  await ensureStateFile();
  const raw = await readFile(STATE_FILE, 'utf8');

  try {
    const parsed = JSON.parse(raw);
    const normalized = normalizeState(parsed);
    if (normalized) {
      return normalized;
    }
  } catch {
    // Ignore parse errors and rewrite with default state.
  }

  const fresh = defaultState();
  await writeState(fresh);
  return fresh;
}

async function writeState(state) {
  const normalized = normalizeState(state);
  const safeState = normalized ?? defaultState();
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(safeState, null, 2));
  return safeState;
}

async function parseJsonBody(req) {
  let body = '';

  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) {
      throw new Error('payload_too_large');
    }
  }

  if (!body.trim()) {
    return {};
  }

  return JSON.parse(body);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function isAuthorized(req) {
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${AUTH_TOKEN}`;
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: 'bad_request' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (username !== AUTH_USERNAME || password !== AUTH_PASSWORD) {
        sendJson(res, 401, { error: 'invalid_credentials' });
        return;
      }

      sendJson(res, 200, { token: AUTH_TOKEN });
      return;
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const state = await readState();
    sendJson(res, 200, { state });
    return;
  }

  if (url.pathname === '/api/state' && req.method === 'PUT') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      const body = await parseJsonBody(req);
      const normalized = normalizeState(body.state);
      if (!normalized) {
        sendJson(res, 400, { error: 'invalid_state' });
        return;
      }

      await writeState(normalized);
      sendJson(res, 200, { ok: true });
      return;
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }
  }

  if (url.pathname === '/api/state' && req.method === 'DELETE') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const state = await writeState(defaultState());
    sendJson(res, 200, { state });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
  console.log(`TaskForge API listening on ${HOST}:${PORT}`);
});
