import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEventHandler,
  type FormEventHandler,
  type KeyboardEventHandler,
} from 'react';
import './App.css';
import type { MacroDef, TagValue, TaskItem } from './types';
import {
  createId,
  formatDate,
  formatDateTime,
  matchesSearch,
  normalizeDateValue,
  parseEditableText,
  tagsToString,
} from './lib/taskpaper';

const AUTH_TOKEN_STORAGE_KEY = 'taskforge-auth-token-v1';
const API_BASE = '/api';

type EditorTab = {
  id: string;
  name: string;
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

type SavedSearch = {
  id: string;
  name: string;
  query: string;
};

type SectionVisibility = {
  projects: boolean;
  searches: boolean;
  tags: boolean;
  macros: boolean;
};

type FocusRange = {
  start: number;
  end: number;
  label: string;
};

type PersistedState = {
  tabs: EditorTab[];
  activeTabId: string;
  macros: MacroDef[];
  savedSearches: SavedSearch[];
  sectionVisibility: SectionVisibility;
  sidebarCollapsed: boolean;
  darkMode: boolean;
};

type PendingSelection = {
  start: number;
  end: number;
  focus: boolean;
};

type ItemKind = 'project' | 'task' | 'note';

type ParsedLine = {
  rawIndent: string;
  kind: ItemKind;
  title: string;
  tags: Record<string, TagValue>;
  isBlank: boolean;
};

type OutlineNode = {
  id: string;
  lineIndex: number;
  rawIndent: string;
  indentWidth: number;
  kind: ItemKind;
  title: string;
  tags: Record<string, TagValue>;
  parentId: string | null;
  children: string[];
  path: string;
  startOffset: number;
  endOffset: number;
  subtreeEndLine: number;
  subtreeEndOffset: number;
};

type OutlineModel = {
  text: string;
  lines: string[];
  lineStarts: number[];
  nodes: Record<string, OutlineNode>;
  rootIds: string[];
  lineNodeIds: Array<string | null>;
  itemMap: Record<string, TaskItem>;
  projectIds: string[];
  tagCounts: Record<string, number>;
};

type LineBlock = {
  lines: string[];
  lineStarts: number[];
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  trailingNewline: boolean;
  selectedLines: string[];
};

type QuickAction =
  | 'new_project'
  | 'new_task'
  | 'new_note'
  | 'group_items'
  | 'duplicate_items'
  | 'format_project'
  | 'format_task'
  | 'format_note'
  | 'move_up'
  | 'move_down'
  | 'move_to_project'
  | 'delete_items'
  | 'tag_with'
  | 'toggle_done'
  | 'archive_done'
  | 'insert_date'
  | 'tag_due'
  | 'tag_start'
  | 'export_reminders';

const DEFAULT_TEXT = '';

const DEFAULT_MACROS: MacroDef[] = [
  { id: createId('macro'), trigger: ';lx', replacement: 'los angeles' },
  { id: createId('macro'), trigger: ';nyc', replacement: 'new york city' },
];

const DEFAULT_SEARCHES: SavedSearch[] = [
  { id: createId('search'), name: 'Not Done', query: '-@done' },
  { id: createId('search'), name: 'Due Today', query: '@due(today) -@done' },
  { id: createId('search'), name: 'Started', query: '@start' },
];

const DEFAULT_SECTIONS: SectionVisibility = {
  projects: true,
  searches: true,
  tags: true,
  macros: true,
};

function createTab(name: string, text = ''): EditorTab {
  return {
    id: createId('tab'),
    name,
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  };
}

function replaceRange(text: string, start: number, end: number, replacement: string): {
  nextText: string;
  nextCursor: number;
} {
  const nextText = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  return {
    nextText,
    nextCursor: start + replacement.length,
  };
}

function splitLines(text: string): { lines: string[]; lineStarts: number[] } {
  const lines = text.split('\n');
  const lineStarts = new Array<number>(lines.length + 1);
  lineStarts[0] = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const isLast = i === lines.length - 1;
    lineStarts[i + 1] = lineStarts[i] + lines[i].length + (isLast ? 0 : 1);
  }

  return { lines, lineStarts };
}

function indentWidth(rawIndent: string): number {
  return rawIndent.replace(/\t/g, '  ').length;
}

function lineIndexAtOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 2;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = lineStarts[mid];
    const nextStart = lineStarts[mid + 1];

    if (offset < start) {
      high = mid - 1;
      continue;
    }

    if (offset >= nextStart) {
      low = mid + 1;
      continue;
    }

    return mid;
  }

  return Math.max(0, Math.min(lineStarts.length - 2, low));
}

function parseLine(rawLine: string): ParsedLine {
  if (rawLine.trim().length === 0) {
    return {
      rawIndent: '',
      kind: 'note',
      title: '',
      tags: {},
      isBlank: true,
    };
  }

  const indentMatch = rawLine.match(/^(\s*)/);
  const rawIndent = indentMatch ? indentMatch[1] : '';
  const body = rawLine.slice(rawIndent.length).trimEnd();

  let kind: ItemKind = 'note';
  let payload = body;

  if (body.startsWith('- ')) {
    kind = 'task';
    payload = body.slice(2).trim();
  } else if (body.endsWith(':')) {
    kind = 'project';
    payload = body.slice(0, -1).trim();
  }

  const parsed = parseEditableText(payload);

  return {
    rawIndent,
    kind,
    title: parsed.title,
    tags: parsed.tags,
    isBlank: false,
  };
}

function formatLine(parts: ParsedLine): string {
  if (parts.isBlank) {
    return '';
  }

  const tagText = tagsToString(parts.tags);
  const payload = tagText ? `${parts.title} ${tagText}`.trim() : parts.title;

  if (parts.kind === 'task') {
    return `${parts.rawIndent}- ${payload}`;
  }

  if (parts.kind === 'project') {
    return `${parts.rawIndent}${payload}:`;
  }

  return `${parts.rawIndent}${payload}`;
}

function buildOutlineModel(text: string): OutlineModel {
  const { lines, lineStarts } = splitLines(text);

  const nodes: Record<string, OutlineNode> = {};
  const rootIds: string[] = [];
  const lineNodeIds: Array<string | null> = new Array(lines.length).fill(null);
  const stack: Array<{ id: string; indent: number }> = [];
  const projectIds: string[] = [];
  const tagCounts: Record<string, number> = {};

  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseLine(lines[i]);

    if (parsed.isBlank) {
      continue;
    }

    const id = `line-${i}`;
    const currentIndent = indentWidth(parsed.rawIndent);

    while (stack.length > 0 && stack[stack.length - 1].indent >= currentIndent) {
      stack.pop();
    }

    const parent = stack.length > 0 ? stack[stack.length - 1] : null;

    const parentPath = parent ? nodes[parent.id].path : '';
    const pathLeaf = `${parsed.title || parsed.kind}-${i}`;

    const node: OutlineNode = {
      id,
      lineIndex: i,
      rawIndent: parsed.rawIndent,
      indentWidth: currentIndent,
      kind: parsed.kind,
      title: parsed.title,
      tags: parsed.tags,
      parentId: parent ? parent.id : null,
      children: [],
      path: parentPath ? `${parentPath}/${pathLeaf}` : pathLeaf,
      startOffset: lineStarts[i],
      endOffset: lineStarts[i + 1] ?? text.length,
      subtreeEndLine: i,
      subtreeEndOffset: lineStarts[i + 1] ?? text.length,
    };

    nodes[id] = node;
    lineNodeIds[i] = id;

    if (parent) {
      nodes[parent.id].children.push(id);
    } else {
      rootIds.push(id);
    }

    if (parsed.kind === 'project') {
      projectIds.push(id);
    }

    Object.keys(parsed.tags).forEach((tag) => {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    });

    stack.push({ id, indent: currentIndent });
  }

  const assignSubtree = (id: string): number => {
    const node = nodes[id];

    let maxLine = node.lineIndex;

    node.children.forEach((childId) => {
      maxLine = Math.max(maxLine, assignSubtree(childId));
    });

    node.subtreeEndLine = maxLine;
    node.subtreeEndOffset = lineStarts[maxLine + 1] ?? text.length;
    return maxLine;
  };

  rootIds.forEach((rootId) => {
    assignSubtree(rootId);
  });

  const itemMap: Record<string, TaskItem> = {};

  Object.values(nodes).forEach((node) => {
    itemMap[node.id] = {
      id: node.id,
      parentId: node.parentId,
      kind: node.kind,
      title: node.title,
      tags: node.tags,
      children: [...node.children],
      collapsed: false,
      createdAt: '',
      updatedAt: '',
    };
  });

  return {
    text,
    lines,
    lineStarts,
    nodes,
    rootIds,
    lineNodeIds,
    itemMap,
    projectIds,
    tagCounts,
  };
}

function getSelectedLineBlock(text: string, start: number, end: number): LineBlock {
  const { lines, lineStarts } = splitLines(text);
  const startLine = lineIndexAtOffset(lineStarts, start);

  const endReference = start === end ? end : Math.max(start, end - 1);
  const endLine = lineIndexAtOffset(lineStarts, endReference);

  const startOffset = lineStarts[startLine];
  const endOffset = lineStarts[endLine + 1] ?? text.length;

  return {
    lines,
    lineStarts,
    startLine,
    endLine,
    startOffset,
    endOffset,
    trailingNewline: endLine < lines.length - 1,
    selectedLines: lines.slice(startLine, endLine + 1),
  };
}

function indentSelection(text: string, start: number, end: number): { nextText: string; nextStart: number; nextEnd: number } {
  const block = getSelectedLineBlock(text, start, end);

  if (start === end) {
    const { nextText } = replaceRange(text, block.startOffset, block.startOffset, '\t');

    return {
      nextText,
      nextStart: start + 1,
      nextEnd: end + 1,
    };
  }

  const replacement = `${block.selectedLines.map((line) => `\t${line}`).join('\n')}${block.trailingNewline ? '\n' : ''}`;

  const nextText = `${text.slice(0, block.startOffset)}${replacement}${text.slice(block.endOffset)}`;

  return {
    nextText,
    nextStart: start + 1,
    nextEnd: end + block.selectedLines.length,
  };
}

function removeSingleIndent(line: string): { nextLine: string; removed: number } {
  if (line.startsWith('\t')) {
    return {
      nextLine: line.slice(1),
      removed: 1,
    };
  }

  if (line.startsWith('  ')) {
    return {
      nextLine: line.slice(2),
      removed: 2,
    };
  }

  return {
    nextLine: line,
    removed: 0,
  };
}

function outdentSelection(text: string, start: number, end: number): { nextText: string; nextStart: number; nextEnd: number } {
  const block = getSelectedLineBlock(text, start, end);

  if (start === end) {
    const rawLine = block.selectedLines[0] ?? '';
    const { removed } = removeSingleIndent(rawLine);

    if (removed === 0) {
      return {
        nextText: text,
        nextStart: start,
        nextEnd: end,
      };
    }

    const { nextText } = replaceRange(text, block.startOffset, block.startOffset + removed, '');

    return {
      nextText,
      nextStart: Math.max(block.startOffset, start - removed),
      nextEnd: Math.max(block.startOffset, end - removed),
    };
  }

  const transformed = block.selectedLines.map((line) => removeSingleIndent(line));
  const replacement = `${transformed.map((entry) => entry.nextLine).join('\n')}${block.trailingNewline ? '\n' : ''}`;
  const nextText = `${text.slice(0, block.startOffset)}${replacement}${text.slice(block.endOffset)}`;

  return {
    nextText,
    nextStart: block.startOffset,
    nextEnd: block.startOffset + replacement.length,
  };
}

function normalizePersistedState(raw: unknown): PersistedState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const parsed = raw as Partial<PersistedState>;
  if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
    return null;
  }

  const validTabs = parsed.tabs.filter((tab) => tab.id && tab.name && typeof tab.text === 'string');
  if (validTabs.length === 0) {
    return null;
  }

  return {
    tabs: validTabs.map((tab) => ({
      ...tab,
      selectionStart: Number.isFinite(tab.selectionStart) ? tab.selectionStart : tab.text.length,
      selectionEnd: Number.isFinite(tab.selectionEnd) ? tab.selectionEnd : tab.text.length,
    })),
    activeTabId: typeof parsed.activeTabId === 'string' ? parsed.activeTabId : validTabs[0].id,
    macros: Array.isArray(parsed.macros) ? parsed.macros.filter((macro) => macro.trigger && macro.replacement) : [],
    savedSearches: Array.isArray(parsed.savedSearches)
      ? parsed.savedSearches.filter((search) => search.id && search.name)
      : [],
    sectionVisibility: {
      ...DEFAULT_SECTIONS,
      ...(parsed.sectionVisibility ?? {}),
    },
    sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
    darkMode: Boolean(parsed.darkMode),
  };
}

async function loginApi(username: string, password: string): Promise<string> {
  const response = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username,
      password,
    }),
  });

  if (!response.ok) {
    throw new Error('login_failed');
  }

  const parsed = (await response.json()) as { token?: string };
  if (!parsed.token) {
    throw new Error('missing_token');
  }

  return parsed.token;
}

async function loadRemoteState(token: string): Promise<PersistedState> {
  const response = await fetch(`${API_BASE}/state`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    throw new Error('unauthorized');
  }

  if (!response.ok) {
    throw new Error('load_failed');
  }

  const parsed = (await response.json()) as { state?: unknown };
  const normalized = normalizePersistedState(parsed.state);
  if (!normalized) {
    throw new Error('invalid_state');
  }

  return normalized;
}

async function saveRemoteState(token: string, state: PersistedState): Promise<void> {
  const response = await fetch(`${API_BASE}/state`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      state,
    }),
  });

  if (response.status === 401) {
    throw new Error('unauthorized');
  }

  if (!response.ok) {
    throw new Error('save_failed');
  }
}

function buildMatchMap(outline: OutlineModel, query: string): Record<string, boolean> {
  const trimmed = query.trim();
  const visibility: Record<string, boolean> = {};

  if (!trimmed) {
    Object.keys(outline.nodes).forEach((id) => {
      visibility[id] = true;
    });
    return visibility;
  }

  const visit = (id: string): boolean => {
    const item = outline.itemMap[id];
    if (!item) {
      visibility[id] = false;
      return false;
    }

    const self = matchesSearch(item, trimmed, outline.itemMap);
    const child = outline.nodes[id].children.some((childId) => visit(childId));

    visibility[id] = self || child;
    return visibility[id];
  };

  outline.rootIds.forEach((rootId) => visit(rootId));

  return visibility;
}

function expandMacrosAtCursor(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  macros: MacroDef[],
): { nextText: string; nextStart: number; nextEnd: number; expanded: boolean } {
  if (selectionStart !== selectionEnd) {
    return {
      nextText: text,
      nextStart: selectionStart,
      nextEnd: selectionEnd,
      expanded: false,
    };
  }

  let nextText = text;
  let nextCursor = selectionStart;
  let expanded = false;

  const sorted = [...macros].sort((left, right) => right.trigger.length - left.trigger.length);

  for (const macro of sorted) {
    if (!macro.trigger) {
      continue;
    }

    const before = nextText.slice(0, nextCursor);

    if (!before.endsWith(macro.trigger)) {
      continue;
    }

    nextText = `${before.slice(0, -macro.trigger.length)}${macro.replacement}${nextText.slice(nextCursor)}`;
    nextCursor = nextCursor - macro.trigger.length + macro.replacement.length;
    expanded = true;
  }

  return {
    nextText,
    nextStart: nextCursor,
    nextEnd: nextCursor,
    expanded,
  };
}

function App() {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const importReminderRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingSelectionRef = useRef<PendingSelection | null>(null);

  const [tabs, setTabs] = useState<EditorTab[]>([createTab('Home', DEFAULT_TEXT)]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0]?.id ?? '');
  const [macros, setMacros] = useState<MacroDef[]>(DEFAULT_MACROS);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(DEFAULT_SEARCHES);
  const [sectionVisibility, setSectionVisibility] = useState<SectionVisibility>(DEFAULT_SECTIONS);
  const [newMacroTrigger, setNewMacroTrigger] = useState('');
  const [newMacroReplacement, setNewMacroReplacement] = useState('');
  const [filterQuery, setFilterQuery] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [focusByTab, setFocusByTab] = useState<Record<string, FocusRange>>({});
  const [collapsedByTab, setCollapsedByTab] = useState<Record<string, string[]>>({});
  const [quickAction, setQuickAction] = useState<QuickAction>('new_task');
  const [statusMessage, setStatusMessage] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const [authToken, setAuthToken] = useState<string>(() => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? '');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => Boolean(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)));
  const [isSyncReady, setIsSyncReady] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  const resolvedActiveTabId = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id ?? '';
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === resolvedActiveTabId) ?? null, [tabs, resolvedActiveTabId]);

  const activeFocus = activeTab ? focusByTab[activeTab.id] ?? null : null;
  const clampedFocus = useMemo(() => {
    if (!activeTab || !activeFocus) {
      return null;
    }

    const start = Math.max(0, Math.min(activeFocus.start, activeTab.text.length));
    const end = Math.max(start, Math.min(activeFocus.end, activeTab.text.length));

    if (start === end) {
      return null;
    }

    return {
      ...activeFocus,
      start,
      end,
    };
  }, [activeTab, activeFocus]);

  const viewStart = clampedFocus ? clampedFocus.start : 0;
  const viewEnd = clampedFocus ? clampedFocus.end : activeTab?.text.length ?? 0;
  const viewText = activeTab ? activeTab.text.slice(viewStart, viewEnd) : '';

  const outline = useMemo(() => buildOutlineModel(viewText), [viewText]);
  const matchMap = useMemo(() => buildMatchMap(outline, filterQuery), [outline, filterQuery]);

  const collapsedSet = useMemo(() => {
    if (!activeTab) {
      return new Set<string>();
    }

    return new Set(collapsedByTab[activeTab.id] ?? []);
  }, [collapsedByTab, activeTab]);

  useEffect(() => {
    localStorage.removeItem('taskforge-plain-text-v2');
    localStorage.removeItem('taskforge-plain-text-v3-raza');
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !authToken) {
      setIsSyncReady(false);
      return;
    }

    let cancelled = false;
    setIsSyncing(true);
    setStatusMessage('Loading synced task list...');

    void (async () => {
      try {
        const remoteState = await loadRemoteState(authToken);
        if (cancelled) {
          return;
        }

        setTabs(remoteState.tabs);
        setActiveTabId(remoteState.activeTabId);
        setMacros(remoteState.macros.length ? remoteState.macros : DEFAULT_MACROS);
        setSavedSearches(remoteState.savedSearches.length ? remoteState.savedSearches : DEFAULT_SEARCHES);
        setSectionVisibility(remoteState.sectionVisibility);
        setSidebarCollapsed(remoteState.sidebarCollapsed);
        setDarkMode(remoteState.darkMode);
        setFocusByTab({});
        setCollapsedByTab({});
        setFilterQuery('');
        setStatusMessage('Synced latest task list.');
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof Error && error.message === 'unauthorized') {
          localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
          setAuthToken('');
          setIsAuthenticated(false);
          setLoginError('Session expired. Please sign in again.');
          setStatusMessage('Session expired.');
          return;
        }

        setStatusMessage('Unable to load synced task list.');
      } finally {
        if (!cancelled) {
          setIsSyncing(false);
          setIsSyncReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, authToken]);

  useEffect(() => {
    if (!activeTab || !isAuthenticated || !authToken || !isSyncReady) {
      return;
    }

    const payload: PersistedState = {
      tabs,
      activeTabId: activeTab.id,
      macros,
      savedSearches,
      sectionVisibility,
      sidebarCollapsed,
      darkMode,
    };

    const timeoutId = window.setTimeout(() => {
      void saveRemoteState(authToken, payload).catch((error) => {
        if (error instanceof Error && error.message === 'unauthorized') {
          localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
          setAuthToken('');
          setIsAuthenticated(false);
          setLoginError('Session expired. Please sign in again.');
          setStatusMessage('Session expired.');
          return;
        }

        setStatusMessage('Sync save failed. Changes will retry.');
      });
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [tabs, activeTab, macros, savedSearches, sectionVisibility, sidebarCollapsed, darkMode, isAuthenticated, authToken, isSyncReady]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault();
        setShowGuide((previous) => !previous);
        return;
      }

      if (event.key === 'Escape') {
        setShowGuide(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    const pending = pendingSelectionRef.current;

    if (!pending || !activeTab) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    pendingSelectionRef.current = null;

    requestAnimationFrame(() => {
      const localStart = Math.min(Math.max(0, pending.start - viewStart), viewText.length);
      const localEnd = Math.min(Math.max(0, pending.end - viewStart), viewText.length);

      if (pending.focus) {
        editor.focus();
      }

      editor.setSelectionRange(localStart, localEnd);
    });
  }, [activeTab, viewStart, viewText]);

  const updateActiveTab = (updater: (tab: EditorTab) => EditorTab) => {
    if (!activeTab) {
      return;
    }

    setTabs((previous) => previous.map((tab) => (tab.id === activeTab.id ? updater(tab) : tab)));
  };

  const applyViewUpdate = (nextViewText: string, nextViewStart: number, nextViewEnd: number, focus = true) => {
    if (!activeTab) {
      return;
    }

    if (clampedFocus) {
      const nextFullText = `${activeTab.text.slice(0, clampedFocus.start)}${nextViewText}${activeTab.text.slice(clampedFocus.end)}`;
      const nextFullStart = clampedFocus.start + nextViewStart;
      const nextFullEnd = clampedFocus.start + nextViewEnd;

      setFocusByTab((previous) => ({
        ...previous,
        [activeTab.id]: {
          ...clampedFocus,
          end: clampedFocus.start + nextViewText.length,
        },
      }));

      pendingSelectionRef.current = {
        start: nextFullStart,
        end: nextFullEnd,
        focus,
      };

      updateActiveTab((tab) => ({
        ...tab,
        text: nextFullText,
        selectionStart: nextFullStart,
        selectionEnd: nextFullEnd,
      }));

      return;
    }

    pendingSelectionRef.current = {
      start: nextViewStart,
      end: nextViewEnd,
      focus,
    };

    updateActiveTab((tab) => ({
      ...tab,
      text: nextViewText,
      selectionStart: nextViewStart,
      selectionEnd: nextViewEnd,
    }));
  };

  const getEditorSelectionView = (): { start: number; end: number } => {
    const editor = editorRef.current;

    if (!editor) {
      const start = Math.max(0, (activeTab?.selectionStart ?? 0) - viewStart);
      const end = Math.max(0, (activeTab?.selectionEnd ?? 0) - viewStart);
      return { start, end };
    }

    return {
      start: editor.selectionStart,
      end: editor.selectionEnd,
    };
  };

  const captureSelection = () => {
    if (!activeTab) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const fullStart = viewStart + editor.selectionStart;
    const fullEnd = viewStart + editor.selectionEnd;

    updateActiveTab((tab) => ({
      ...tab,
      selectionStart: fullStart,
      selectionEnd: fullEnd,
    }));
  };

  const calculateEnterInsert = (text: string, start: number, end: number): { nextText: string; nextCursor: number } => {
    if (start !== end) {
      return replaceRange(text, start, end, '\n');
    }

    const block = getSelectedLineBlock(text, start, end);
    const line = block.selectedLines[0] ?? '';
    const beforeCursor = text.slice(block.startOffset, start);
    const leadingWhitespace = line.match(/^(\s*)/)?.[1] ?? '';
    const trimmed = beforeCursor.trim();

    if (trimmed === '-') {
      return replaceRange(text, start, end, '\n');
    }

    if (trimmed.endsWith(':') && !trimmed.startsWith('-')) {
      return replaceRange(text, start, end, `\n${leadingWhitespace}\t- `);
    }

    if (trimmed.startsWith('- ')) {
      return replaceRange(text, start, end, `\n${leadingWhitespace}- `);
    }

    if (trimmed.length === 0) {
      return replaceRange(text, start, end, '\n');
    }

    return replaceRange(text, start, end, `\n${leadingWhitespace}`);
  };

  const handleEditorChange: ChangeEventHandler<HTMLTextAreaElement> = (event) => {
    if (!activeTab) {
      return;
    }

    const selectionStart = event.target.selectionStart;
    const selectionEnd = event.target.selectionEnd;

    const expanded = expandMacrosAtCursor(event.target.value, selectionStart, selectionEnd, macros);

    applyViewUpdate(expanded.nextText, expanded.nextStart, expanded.nextEnd, true);

    if (expanded.expanded) {
      setStatusMessage('Macro expanded while typing.');
    }
  };

  const formatSelectionAs = (kind: ItemKind) => {
    const { start, end } = getEditorSelectionView();
    const block = getSelectedLineBlock(viewText, start, end);

    const replacementLines = block.selectedLines.map((line) => {
      const parsed = parseLine(line);
      if (parsed.isBlank) {
        return line;
      }

      return formatLine({
        ...parsed,
        kind,
      });
    });

    const replacement = `${replacementLines.join('\n')}${block.trailingNewline ? '\n' : ''}`;
    const nextText = `${viewText.slice(0, block.startOffset)}${replacement}${viewText.slice(block.endOffset)}`;

    applyViewUpdate(nextText, block.startOffset, block.startOffset + replacement.length, true);
    setStatusMessage(`Formatted selected items as ${kind}.`);
  };

  const insertNewItem = (kind: ItemKind) => {
    const { start, end } = getEditorSelectionView();
    const block = getSelectedLineBlock(viewText, start, end);
    const current = parseLine(block.selectedLines[0] ?? '');
    const indent = current.rawIndent;

    const line =
      kind === 'project'
        ? `${indent}New Project:`
        : kind === 'task'
          ? `${indent}- New Task`
          : `${indent}New Note`;

    const replacement = `${line}`;
    const next = replaceRange(viewText, start, end, replacement);

    applyViewUpdate(next.nextText, next.nextCursor, next.nextCursor, true);
    setStatusMessage(`Inserted new ${kind} item.`);
  };

  const groupSelectedItems = () => {
    const { start, end } = getEditorSelectionView();
    const block = getSelectedLineBlock(viewText, start, end);

    const firstParsed = parseLine(block.selectedLines[0] ?? '');
    const groupLine = `${firstParsed.rawIndent}Group:`;

    const nested = block.selectedLines.map((line) => (line.length > 0 ? `\t${line}` : line));
    const replacement = `${groupLine}\n${nested.join('\n')}${block.trailingNewline ? '\n' : ''}`;

    const nextText = `${viewText.slice(0, block.startOffset)}${replacement}${viewText.slice(block.endOffset)}`;

    applyViewUpdate(nextText, block.startOffset, block.startOffset + replacement.length, true);
    setStatusMessage('Grouped selected items under a new group project.');
  };

  const duplicateSelectedItems = () => {
    const { start, end } = getEditorSelectionView();
    const block = getSelectedLineBlock(viewText, start, end);
    const copied = `${viewText.slice(block.startOffset, block.endOffset)}`;

    const nextText = `${viewText.slice(0, block.endOffset)}${copied}${viewText.slice(block.endOffset)}`;

    applyViewUpdate(nextText, block.endOffset, block.endOffset + copied.length, true);
    setStatusMessage('Duplicated selected items.');
  };

  const moveSelection = (direction: 'up' | 'down') => {
    const { start, end } = getEditorSelectionView();
    const block = getSelectedLineBlock(viewText, start, end);

    if (direction === 'up') {
      if (block.startLine === 0) {
        return;
      }

      const prevStart = block.lineStarts[block.startLine - 1];
      const prevEnd = block.lineStarts[block.startLine];
      const prevBlock = viewText.slice(prevStart, prevEnd);
      const selectedBlock = viewText.slice(block.startOffset, block.endOffset);

      const nextText = `${viewText.slice(0, prevStart)}${selectedBlock}${prevBlock}${viewText.slice(block.endOffset)}`;

      applyViewUpdate(nextText, prevStart, prevStart + selectedBlock.length, true);
      setStatusMessage('Moved selected items up.');
      return;
    }

    if (block.endLine >= block.lines.length - 1) {
      return;
    }

    const nextStart = block.lineStarts[block.endLine + 1];
    const nextEnd = block.lineStarts[block.endLine + 2] ?? viewText.length;
    const nextBlock = viewText.slice(nextStart, nextEnd);
    const selectedBlock = viewText.slice(block.startOffset, block.endOffset);

    const nextText = `${viewText.slice(0, block.startOffset)}${nextBlock}${selectedBlock}${viewText.slice(nextEnd)}`;

    applyViewUpdate(nextText, block.startOffset + nextBlock.length, block.startOffset + nextBlock.length + selectedBlock.length, true);
    setStatusMessage('Moved selected items down.');
  };

  const deleteSelectedItems = () => {
    const { start, end } = getEditorSelectionView();
    const block = getSelectedLineBlock(viewText, start, end);

    const nextText = `${viewText.slice(0, block.startOffset)}${viewText.slice(block.endOffset)}`;

    applyViewUpdate(nextText, block.startOffset, block.startOffset, true);
    setStatusMessage('Deleted selected items.');
  };

  const applyTagToSelection = () => {
    const raw = window.prompt('Tag With (example: @today @priority(1))', '@today');
    if (!raw) {
      return;
    }

    const parsedTagInput = parseEditableText(raw);
    const extraTags = parsedTagInput.tags;

    if (Object.keys(extraTags).length === 0) {
      return;
    }

    const { start, end } = getEditorSelectionView();
    const block = getSelectedLineBlock(viewText, start, end);

    const replacementLines = block.selectedLines.map((line) => {
      const parsed = parseLine(line);
      if (parsed.isBlank) {
        return line;
      }

      return formatLine({
        ...parsed,
        tags: {
          ...parsed.tags,
          ...extraTags,
        },
      });
    });

    const replacement = `${replacementLines.join('\n')}${block.trailingNewline ? '\n' : ''}`;
    const nextText = `${viewText.slice(0, block.startOffset)}${replacement}${viewText.slice(block.endOffset)}`;

    applyViewUpdate(nextText, block.startOffset, block.startOffset + replacement.length, true);
    setStatusMessage('Applied tag(s) to selected items.');
  };

  const toggleDoneSelection = () => {
    const { start, end } = getEditorSelectionView();
    const block = getSelectedLineBlock(viewText, start, end);

    const stamp = formatDateTime(new Date());

    const replacementLines = block.selectedLines.map((line) => {
      const parsed = parseLine(line);
      if (parsed.isBlank || parsed.kind !== 'task') {
        return line;
      }

      const nextTags: Record<string, TagValue> = {
        ...parsed.tags,
      };

      if (nextTags.done !== undefined) {
        delete nextTags.done;
      } else {
        nextTags.done = stamp;
      }

      return formatLine({
        ...parsed,
        tags: nextTags,
      });
    });

    const replacement = `${replacementLines.join('\n')}${block.trailingNewline ? '\n' : ''}`;
    const nextText = `${viewText.slice(0, block.startOffset)}${replacement}${viewText.slice(block.endOffset)}`;

    applyViewUpdate(nextText, block.startOffset, block.startOffset + replacement.length, true);
    setStatusMessage('Toggled @done on selected task(s).');
  };

  const archiveDoneItems = () => {
    if (!activeTab) {
      return;
    }

    const fullText = activeTab.text;
    const fullOutline = buildOutlineModel(fullText);

    const doneIds = Object.values(fullOutline.nodes)
      .filter((node) => node.tags.done !== undefined)
      .map((node) => node.id);

    if (doneIds.length === 0) {
      setStatusMessage('No @done items to archive.');
      return;
    }

    const doneSet = new Set(doneIds);

    const topDoneIds = doneIds.filter((id) => {
      let cursor = fullOutline.nodes[id]?.parentId;
      while (cursor) {
        if (doneSet.has(cursor)) {
          return false;
        }
        cursor = fullOutline.nodes[cursor]?.parentId ?? null;
      }
      return true;
    });

    const ranges = topDoneIds
      .map((id) => {
        const node = fullOutline.nodes[id];
        return {
          start: node.startOffset,
          end: node.subtreeEndOffset,
          block: fullText.slice(node.startOffset, node.subtreeEndOffset),
        };
      })
      .sort((left, right) => right.start - left.start);

    let textWithoutDone = fullText;
    const archivedBlocks: string[] = [];

    ranges.forEach((range) => {
      archivedBlocks.push(range.block.trimEnd());
      textWithoutDone = `${textWithoutDone.slice(0, range.start)}${textWithoutDone.slice(range.end)}`;
    });

    let mutable = textWithoutDone;
    let updatedOutline = buildOutlineModel(mutable);
    let archiveNode = Object.values(updatedOutline.nodes).find(
      (node) => node.kind === 'project' && node.title.toLowerCase() === 'archive',
    );

    if (!archiveNode) {
      mutable = `${mutable.trimEnd()}\n\nArchive:\n`;
      updatedOutline = buildOutlineModel(mutable);
      archiveNode = Object.values(updatedOutline.nodes).find(
        (node) => node.kind === 'project' && node.title.toLowerCase() === 'archive',
      );
    }

    if (!archiveNode) {
      return;
    }

    const insertionOffset = archiveNode.subtreeEndOffset;
    const payload = `${archivedBlocks
      .reverse()
      .map((block) =>
        block
          .split('\n')
          .map((line) => (line.length > 0 ? `\t${line}` : line))
          .join('\n'),
      )
      .join('\n')}${mutable.endsWith('\n') ? '' : '\n'}`;

    const finalText = `${mutable.slice(0, insertionOffset)}${payload}${mutable.slice(insertionOffset)}`;

    pendingSelectionRef.current = {
      start: 0,
      end: 0,
      focus: true,
    };

    updateActiveTab((tab) => ({
      ...tab,
      text: finalText,
      selectionStart: 0,
      selectionEnd: 0,
    }));

    setStatusMessage(`Archived ${topDoneIds.length} done branch(es) to Archive.`);
  };

  const insertDateText = (tagName?: 'due' | 'start') => {
    const suggested = formatDate(new Date());
    const picked = window.prompt('Insert date (supports today, tomorrow, +7d, yyyy-mm-dd)', suggested);
    if (!picked) {
      return;
    }

    const normalized = normalizeDateValue(picked);
    const { start, end } = getEditorSelectionView();

    const prefix = tagName ? `@${tagName}(${normalized})` : normalized;
    const spacer = start > 0 && !/\s/.test(viewText[start - 1] ?? '') ? ' ' : '';

    const next = replaceRange(viewText, start, end, `${spacer}${prefix}`);
    applyViewUpdate(next.nextText, next.nextCursor, next.nextCursor, true);

    setStatusMessage(tagName ? `Inserted @${tagName} date.` : 'Inserted date.');
  };

  const moveSelectionToProject = () => {
    const projectName = window.prompt('Move to Project', 'New Project')?.trim();
    if (!projectName) {
      return;
    }

    const { start, end } = getEditorSelectionView();
    const block = getSelectedLineBlock(viewText, start, end);
    const selectedText = viewText.slice(block.startOffset, block.endOffset);

    let withoutSelection = `${viewText.slice(0, block.startOffset)}${viewText.slice(block.endOffset)}`;

    let workingOutline = buildOutlineModel(withoutSelection);
    let targetProject = Object.values(workingOutline.nodes).find(
      (node) => node.kind === 'project' && node.title.toLowerCase() === projectName.toLowerCase(),
    );

    if (!targetProject) {
      withoutSelection = `${withoutSelection.trimEnd()}\n\n${projectName}:\n`;
      workingOutline = buildOutlineModel(withoutSelection);
      targetProject = Object.values(workingOutline.nodes).find(
        (node) => node.kind === 'project' && node.title.toLowerCase() === projectName.toLowerCase(),
      );
    }

    if (!targetProject) {
      return;
    }

    const selectedLines = selectedText
      .trimEnd()
      .split('\n')
      .filter((line) => line.length > 0);

    if (selectedLines.length === 0) {
      return;
    }

    const minIndent = selectedLines.reduce((min, line) => {
      const currentIndent = indentWidth(line.match(/^(\s*)/)?.[1] ?? '');
      return Math.min(min, currentIndent);
    }, Number.MAX_SAFE_INTEGER);

    const projectIndent = indentWidth(targetProject.rawIndent) + 2;

    const movedLines = selectedLines.map((line) => {
      const currentIndent = indentWidth(line.match(/^(\s*)/)?.[1] ?? '');
      const relative = Math.max(0, currentIndent - minIndent);
      const newLevel = Math.max(0, Math.round((projectIndent + relative) / 2));
      const body = line.trimStart();
      return `${'\t'.repeat(newLevel)}${body}`;
    });

    const insertionOffset = targetProject.subtreeEndOffset;
    const insertion = `${movedLines.join('\n')}\n`;

    const nextText = `${withoutSelection.slice(0, insertionOffset)}${insertion}${withoutSelection.slice(insertionOffset)}`;

    applyViewUpdate(nextText, insertionOffset, insertionOffset + insertion.length, true);
    setStatusMessage(`Moved selection to project: ${projectName}`);
  };

  const exportSelectionToReminders = () => {
    const { start, end } = getEditorSelectionView();
    const block = getSelectedLineBlock(viewText, start, end);

    const reminders = block.selectedLines
      .map((line) => parseLine(line))
      .filter((parsed) => !parsed.isBlank)
      .map((parsed) => ({
        title: parsed.title || 'Untitled',
        dueDate: typeof parsed.tags.due === 'string' ? normalizeDateValue(parsed.tags.due) : null,
        priority: parsed.tags.priority ? String(parsed.tags.priority) : null,
        tags: Object.keys(parsed.tags),
      }));

    const blob = new Blob([JSON.stringify(reminders, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = 'reminders-export.json';
    link.click();

    URL.revokeObjectURL(url);
    setStatusMessage(`Exported ${reminders.length} item(s) to reminders JSON.`);
  };

  const importReminders = async (file: File) => {
    const content = await file.text();

    let parsed: Array<Record<string, unknown>> = [];

    try {
      const decoded = JSON.parse(content);
      if (Array.isArray(decoded)) {
        parsed = decoded.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
      }
    } catch {
      setStatusMessage('Failed to parse reminders JSON.');
      return;
    }

    if (parsed.length === 0) {
      setStatusMessage('No reminders found in selected file.');
      return;
    }

    const lines = parsed.map((entry) => {
      const title = typeof entry.title === 'string' ? entry.title : typeof entry.name === 'string' ? entry.name : 'Reminder';
      const dueRaw =
        typeof entry.dueDate === 'string'
          ? entry.dueDate
          : typeof entry.due === 'string'
            ? entry.due
            : typeof entry.date === 'string'
              ? entry.date
              : '';
      const priorityRaw = entry.priority;

      const tags: string[] = [];

      if (dueRaw) {
        tags.push(`@due(${normalizeDateValue(dueRaw)})`);
      }

      if (priorityRaw !== undefined && priorityRaw !== null && `${priorityRaw}`.trim()) {
        tags.push(`@priority(${priorityRaw})`);
      }

      return `- ${title}${tags.length > 0 ? ` ${tags.join(' ')}` : ''}`;
    });

    const { start, end } = getEditorSelectionView();
    const payload = `${lines.join('\n')}\n`;
    const next = replaceRange(viewText, start, end, payload);

    applyViewUpdate(next.nextText, next.nextCursor, next.nextCursor, true);
    setStatusMessage(`Imported ${lines.length} reminder item(s).`);
  };

  const runQuickAction = () => {
    switch (quickAction) {
      case 'new_project':
        insertNewItem('project');
        return;
      case 'new_task':
        insertNewItem('task');
        return;
      case 'new_note':
        insertNewItem('note');
        return;
      case 'group_items':
        groupSelectedItems();
        return;
      case 'duplicate_items':
        duplicateSelectedItems();
        return;
      case 'format_project':
        formatSelectionAs('project');
        return;
      case 'format_task':
        formatSelectionAs('task');
        return;
      case 'format_note':
        formatSelectionAs('note');
        return;
      case 'move_up':
        moveSelection('up');
        return;
      case 'move_down':
        moveSelection('down');
        return;
      case 'move_to_project':
        moveSelectionToProject();
        return;
      case 'delete_items':
        deleteSelectedItems();
        return;
      case 'tag_with':
        applyTagToSelection();
        return;
      case 'toggle_done':
        toggleDoneSelection();
        return;
      case 'archive_done':
        archiveDoneItems();
        return;
      case 'insert_date':
        insertDateText();
        return;
      case 'tag_due':
        insertDateText('due');
        return;
      case 'tag_start':
        insertDateText('start');
        return;
      case 'export_reminders':
        exportSelectionToReminders();
        return;
      default:
        return;
    }
  };

  const handleEditorKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (!activeTab) {
      return;
    }

    const start = event.currentTarget.selectionStart;
    const end = event.currentTarget.selectionEnd;

    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchInputRef.current?.focus();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === '/') {
      event.preventDefault();
      setShowGuide((previous) => !previous);
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
      event.preventDefault();
      moveSelectionToProject();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') {
      event.preventDefault();
      applyTagToSelection();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && !event.shiftKey) {
      event.preventDefault();
      toggleDoneSelection();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateSelectedItems();
      return;
    }

    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      deleteSelectedItems();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      archiveDoneItems();
      return;
    }

    if (event.metaKey && event.ctrlKey && event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection('up');
      return;
    }

    if (event.metaKey && event.ctrlKey && event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection('down');
      return;
    }

    if (event.key === '(' && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const before = viewText.slice(0, start);
      const dueStarter = before.endsWith('@due');
      const startStarter = before.endsWith('@start');

      if (dueStarter || startStarter) {
        event.preventDefault();
        const suggestion = formatDate(new Date());
        const chosen = window.prompt('Insert date for this tag', suggestion);

        if (!chosen) {
          const fallback = replaceRange(viewText, start, end, '(');
          applyViewUpdate(fallback.nextText, fallback.nextCursor, fallback.nextCursor, true);
          return;
        }

        const normalized = normalizeDateValue(chosen);
        const next = replaceRange(viewText, start, end, `(${normalized})`);
        applyViewUpdate(next.nextText, next.nextCursor, next.nextCursor, true);
        return;
      }
    }

    if (event.key === 'Enter') {
      event.preventDefault();

      if (event.altKey) {
        const plain = replaceRange(viewText, start, end, '\n');
        applyViewUpdate(plain.nextText, plain.nextCursor, plain.nextCursor, true);
        return;
      }

      const next = calculateEnterInsert(viewText, start, end);
      applyViewUpdate(next.nextText, next.nextCursor, next.nextCursor, true);
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();

      if (event.shiftKey) {
        const next = outdentSelection(viewText, start, end);
        applyViewUpdate(next.nextText, next.nextStart, next.nextEnd, true);
        return;
      }

      const next = indentSelection(viewText, start, end);
      applyViewUpdate(next.nextText, next.nextStart, next.nextEnd, true);
    }
  };

  const createNewTab = () => {
    const tab = createTab(`Tab ${tabs.length + 1}`, '');

    setTabs((previous) => [...previous, tab]);
    setActiveTabId(tab.id);
    pendingSelectionRef.current = {
      start: 0,
      end: 0,
      focus: true,
    };

    setStatusMessage(`Created ${tab.name}.`);
  };

  const switchTab = (tabId: string) => {
    if (!activeTab || tabId === activeTab.id) {
      return;
    }

    const editor = editorRef.current;

    setTabs((previous) =>
      previous.map((tab) => {
        if (tab.id !== activeTab.id || !editor) {
          return tab;
        }

        return {
          ...tab,
          selectionStart: viewStart + editor.selectionStart,
          selectionEnd: viewStart + editor.selectionEnd,
        };
      }),
    );

    const target = tabs.find((tab) => tab.id === tabId);
    pendingSelectionRef.current = {
      start: target?.selectionStart ?? 0,
      end: target?.selectionEnd ?? 0,
      focus: true,
    };

    setActiveTabId(tabId);
    setFilterQuery('');
  };

  const renameActiveTab = () => {
    if (!activeTab) {
      return;
    }

    const next = window.prompt('Rename tab', activeTab.name)?.trim();
    if (!next) {
      return;
    }

    updateActiveTab((tab) => ({
      ...tab,
      name: next,
    }));
  };

  const closeTab = (id: string) => {
    if (tabs.length <= 1) {
      return;
    }

    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }

    const fallback = tabs[index - 1] ?? tabs[index + 1] ?? null;

    setTabs((previous) => previous.filter((tab) => tab.id !== id));

    if (resolvedActiveTabId === id && fallback) {
      setActiveTabId(fallback.id);
      pendingSelectionRef.current = {
        start: fallback.selectionStart,
        end: fallback.selectionEnd,
        focus: true,
      };
    }
  };

  const exportActiveTab = () => {
    if (!activeTab) {
      return;
    }

    const safeName = activeTab.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const blob = new Blob([activeTab.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = `${safeName || 'tasks'}.taskpaper`;
    anchor.click();

    URL.revokeObjectURL(url);
    setStatusMessage(`Exported ${activeTab.name}.`);
  };

  const importToActiveTab = async (file: File) => {
    if (!activeTab) {
      return;
    }

    const text = await file.text();

    pendingSelectionRef.current = {
      start: text.length,
      end: text.length,
      focus: true,
    };

    updateActiveTab((tab) => ({
      ...tab,
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    }));

    setStatusMessage(`Imported ${file.name}.`);
  };

  const addMacro = () => {
    const trigger = newMacroTrigger.trim();
    const replacement = newMacroReplacement.trim();

    if (!trigger || !replacement) {
      return;
    }

    setMacros((previous) => [...previous, { id: createId('macro'), trigger, replacement }]);
    setNewMacroTrigger('');
    setNewMacroReplacement('');
    setStatusMessage(`Macro added: ${trigger} -> ${replacement}`);
  };

  const deleteMacro = (id: string) => {
    setMacros((previous) => previous.filter((macro) => macro.id !== id));
  };

  const addSavedSearch = () => {
    const query = filterQuery.trim();
    if (!query) {
      return;
    }

    const name = window.prompt('Saved search name', query)?.trim();
    if (!name) {
      return;
    }

    setSavedSearches((previous) => [...previous, { id: createId('search'), name, query }]);
  };

  const editSavedSearch = (id: string) => {
    const target = savedSearches.find((search) => search.id === id);
    if (!target) {
      return;
    }

    const nextName = window.prompt('Search name', target.name)?.trim();
    const nextQuery = window.prompt('Search query', target.query)?.trim();

    if (!nextName || !nextQuery) {
      return;
    }

    setSavedSearches((previous) =>
      previous.map((search) => (search.id === id ? { ...search, name: nextName, query: nextQuery } : search)),
    );
  };

  const deleteSavedSearch = (id: string) => {
    setSavedSearches((previous) => previous.filter((search) => search.id !== id));
  };

  const toggleSection = (key: keyof SectionVisibility) => {
    setSectionVisibility((previous) => ({
      ...previous,
      [key]: !previous[key],
    }));
  };

  const toggleCollapseNode = (nodeId: string) => {
    if (!activeTab) {
      return;
    }

    setCollapsedByTab((previous) => {
      const nextSet = new Set(previous[activeTab.id] ?? []);

      if (nextSet.has(nodeId)) {
        nextSet.delete(nodeId);
      } else {
        nextSet.add(nodeId);
      }

      return {
        ...previous,
        [activeTab.id]: [...nextSet],
      };
    });
  };

  const focusProjectNode = (nodeId: string) => {
    if (!activeTab) {
      return;
    }

    const node = outline.nodes[nodeId];
    if (!node || node.kind !== 'project') {
      return;
    }

    const nextFocus: FocusRange = {
      start: viewStart + node.startOffset,
      end: viewStart + node.subtreeEndOffset,
      label: node.title || 'project',
    };

    setFocusByTab((previous) => ({
      ...previous,
      [activeTab.id]: nextFocus,
    }));

    pendingSelectionRef.current = {
      start: nextFocus.start,
      end: nextFocus.start,
      focus: true,
    };

    setStatusMessage(`Focused project: ${nextFocus.label}`);
  };

  const clearFocus = () => {
    if (!activeTab) {
      return;
    }

    setFocusByTab((previous) => {
      const next = { ...previous };
      delete next[activeTab.id];
      return next;
    });

    setStatusMessage('Focus cleared.');
  };

  const handleLogin: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    const username = loginUsername.trim();
    const password = loginPassword;

    if (!username || !password) {
      setLoginError('Enter username and password.');
      return;
    }

    setLoginError('');

    void (async () => {
      try {
        const token = await loginApi(username, password);
        localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
        setAuthToken(token);
        setIsAuthenticated(true);
        setIsSyncReady(false);
        setLoginPassword('');
      } catch {
        setLoginError('Incorrect username or password.');
      }
    })();
  };

  const handleLogout = () => {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    setAuthToken('');
    setIsAuthenticated(false);
    setIsSyncReady(false);
    setIsSyncing(false);
    setLoginUsername('');
    setLoginPassword('');
    setLoginError('');
    setFilterQuery('');
    setStatusMessage('Logged out.');
  };

  const visibleProjectIds = outline.projectIds.filter((id) => matchMap[id]);

  const renderTree = (nodeId: string, depth = 0) => {
    if (!matchMap[nodeId]) {
      return null;
    }

    const node = outline.nodes[nodeId];
    if (!node) {
      return null;
    }

    const collapsed = collapsedSet.has(nodeId);
    const tags = tagsToString(node.tags);

    return (
      <div key={nodeId}>
        <div className="tree-row" style={{ paddingLeft: `${Math.min(depth, 10) * 16 + 10}px` }}>
          <button
            type="button"
            className="fold-toggle"
            onClick={() => {
              if (node.children.length > 0) {
                toggleCollapseNode(nodeId);
              }
            }}
          >
            {node.children.length > 0 ? (collapsed ? '▸' : '▾') : '·'}
          </button>

          <button
            type="button"
            className="tree-main"
            onClick={() => {
              if (node.kind === 'project') {
                focusProjectNode(nodeId);
              }
            }}
          >
            <span className={`tree-kind ${node.kind}`}>{node.kind === 'project' ? 'P' : node.kind === 'task' ? 'T' : 'N'}</span>
            <span className="tree-title">{node.title || '(blank)'}</span>
            {tags && <span className="tree-tags">{tags}</span>}
          </button>
        </div>

        {!collapsed && node.children.map((childId) => renderTree(childId, depth + 1))}
      </div>
    );
  };

  if (!isAuthenticated) {
    return (
      <div className={`app-shell auth-shell ${darkMode ? 'dark' : ''}`}>
        <main className="login-shell">
          <section className="login-card">
            <h1>Tasks</h1>
            <p>Sign in to load your saved tabs and lists.</p>
            <form className="login-form" onSubmit={handleLogin}>
              <input
                type="text"
                value={loginUsername}
                onChange={(event) => {
                  setLoginUsername(event.target.value);
                  if (loginError) {
                    setLoginError('');
                  }
                }}
                placeholder="Username"
                autoComplete="username"
              />
              <input
                type="password"
                value={loginPassword}
                onChange={(event) => {
                  setLoginPassword(event.target.value);
                  if (loginError) {
                    setLoginError('');
                  }
                }}
                placeholder="Password"
                autoComplete="current-password"
              />
              <button type="submit">Login</button>
            </form>
            {loginError && <p className="login-error">{loginError}</p>}
          </section>
        </main>
      </div>
    );
  }

  if (!isSyncReady || isSyncing) {
    return (
      <div className={`app-shell auth-shell ${darkMode ? 'dark' : ''}`}>
        <main className="login-shell">
          <section className="login-card">
            <h1>Syncing</h1>
            <p>Loading shared task list for this account.</p>
            <button type="button" onClick={handleLogout}>
              Logout
            </button>
          </section>
        </main>
      </div>
    );
  }

  if (!activeTab) {
    return <div className="empty-app">No tabs available.</div>;
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${darkMode ? 'dark' : ''}`}>
      {sidebarCollapsed && (
        <button
          type="button"
          className="sidebar-restore-fab"
          onClick={() => setSidebarCollapsed(false)}
          aria-label="Show sidebar"
        >
          Show Sidebar
        </button>
      )}
      <aside className={`left-panel ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <section className="panel-block">
          <div className="panel-head">
            <h2>Projects</h2>
            <button type="button" onClick={() => toggleSection('projects')}>
              {sectionVisibility.projects ? 'Hide' : 'Show'}
            </button>
          </div>

          {sectionVisibility.projects && (
            <div className="section-content">
              <button type="button" onClick={clearFocus}>
                Home
              </button>
              {visibleProjectIds.map((projectId) => {
                const project = outline.nodes[projectId];
                if (!project) {
                  return null;
                }

                return (
                  <button key={projectId} type="button" className="project-chip" onClick={() => focusProjectNode(projectId)}>
                    {project.title || '(untitled)'}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="panel-block">
          <div className="panel-head">
            <h2>Searches</h2>
            <button type="button" onClick={() => toggleSection('searches')}>
              {sectionVisibility.searches ? 'Hide' : 'Show'}
            </button>
          </div>

          {sectionVisibility.searches && (
            <div className="section-content">
              {savedSearches.map((search) => (
                <div className="saved-search" key={search.id}>
                  <button
                    type="button"
                    className="saved-main"
                    onClick={() => {
                      setFilterQuery(search.query);
                      setStatusMessage(`Filter: ${search.name}`);
                    }}
                  >
                    {search.name}
                  </button>
                  <button type="button" onClick={() => editSavedSearch(search.id)}>
                    edit
                  </button>
                  <button type="button" onClick={() => deleteSavedSearch(search.id)}>
                    x
                  </button>
                </div>
              ))}
              <button type="button" onClick={addSavedSearch}>
                Save Current Filter
              </button>
            </div>
          )}
        </section>

        <section className="panel-block">
          <div className="panel-head">
            <h2>Tags</h2>
            <button type="button" onClick={() => toggleSection('tags')}>
              {sectionVisibility.tags ? 'Hide' : 'Show'}
            </button>
          </div>

          {sectionVisibility.tags && (
            <div className="section-content tags-grid">
              {Object.entries(outline.tagCounts)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([tag, count]) => (
                  <button key={tag} type="button" onClick={() => setFilterQuery(`@${tag}`)}>
                    @{tag} ({count})
                  </button>
                ))}
            </div>
          )}
        </section>

        <section className="panel-block">
          <div className="panel-head">
            <h2>Macros</h2>
            <button type="button" onClick={() => toggleSection('macros')}>
              {sectionVisibility.macros ? 'Hide' : 'Show'}
            </button>
          </div>

          {sectionVisibility.macros && (
            <div className="section-content">
              {macros.map((macro) => (
                <div className="macro-row" key={macro.id}>
                  <span>
                    {macro.trigger} {'->'} {macro.replacement}
                  </span>
                  <button type="button" onClick={() => deleteMacro(macro.id)}>
                    x
                  </button>
                </div>
              ))}
              <input
                value={newMacroTrigger}
                onChange={(event) => setNewMacroTrigger(event.target.value)}
                placeholder="Trigger (e.g. ;lx)"
              />
              <input
                value={newMacroReplacement}
                onChange={(event) => setNewMacroReplacement(event.target.value)}
                placeholder="Replacement"
              />
              <button type="button" onClick={addMacro}>
                Add Macro
              </button>
            </div>
          )}
        </section>
      </aside>

      <main className="editor-panel">
        <header className="tabs-bar">
          <div className="tabs">
            <button type="button" className="sidebar-toggle" onClick={() => setSidebarCollapsed((previous) => !previous)}>
              {sidebarCollapsed ? 'Show Sidebar' : 'Hide Sidebar'}
            </button>
            {tabs.map((tab) => (
              <div key={tab.id} className={`tab-chip ${tab.id === activeTab.id ? 'active' : ''}`}>
                <button type="button" onClick={() => switchTab(tab.id)}>
                  {tab.name}
                </button>
                {tabs.length > 1 && (
                  <button type="button" className="close-tab" onClick={() => closeTab(tab.id)}>
                    ×
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="new-tab" onClick={createNewTab}>
              + Tab
            </button>
          </div>

          <div className="top-actions">
            <button type="button" onClick={() => setShowGuide(true)}>
              Guide
            </button>
            <button type="button" onClick={handleLogout}>
              Logout
            </button>
            <button
              type="button"
              className="icon-toggle"
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              onClick={() => setDarkMode((previous) => !previous)}
            >
              {darkMode ? (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M12 4a1 1 0 0 1 1 1v1.3a1 1 0 1 1-2 0V5a1 1 0 0 1 1-1Zm0 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 4a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 1-1ZM4 12a1 1 0 0 1 1-1h1.3a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Zm12.7 0a1 1 0 0 1 1-1H19a1 1 0 1 1 0 2h-1.3a1 1 0 0 1-1-1ZM6.8 6.8a1 1 0 0 1 1.4 0l.9.9a1 1 0 0 1-1.4 1.4l-.9-.9a1 1 0 0 1 0-1.4Zm8.1 8.1a1 1 0 0 1 1.4 0l.9.9a1 1 0 0 1-1.4 1.4l-.9-.9a1 1 0 0 1 0-1.4ZM17.2 6.8a1 1 0 0 1 0 1.4l-.9.9a1 1 0 1 1-1.4-1.4l.9-.9a1 1 0 0 1 1.4 0Zm-8.1 8.1a1 1 0 0 1 0 1.4l-.9.9a1 1 0 1 1-1.4-1.4l.9-.9a1 1 0 0 1 1.4 0Z"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M14.8 3.2a1 1 0 0 1 .9 1.4 8 8 0 1 0 3.7 10.3 1 1 0 0 1 1.9.5A10 10 0 1 1 13.9 2.8a1 1 0 0 1 .9.4Z"
                  />
                </svg>
              )}
            </button>
            <button type="button" onClick={renameActiveTab}>
              Rename Tab
            </button>
            <button type="button" onClick={exportActiveTab}>
              Export
            </button>
            <button type="button" onClick={() => importFileRef.current?.click()}>
              Import
            </button>
            <button type="button" onClick={() => importReminderRef.current?.click()}>
              Import Reminders
            </button>
            <input
              ref={importFileRef}
              type="file"
              accept=".taskpaper,.txt,text/plain"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void importToActiveTab(file);
                }
                event.currentTarget.value = '';
              }}
            />
            <input
              ref={importReminderRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void importReminders(file);
                }
                event.currentTarget.value = '';
              }}
            />
          </div>
        </header>

        <section className="command-bar">
          <input
            ref={searchInputRef}
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder="Filter tree: @tag, not @done, @done and @today"
          />
          <button type="button" onClick={() => setFilterQuery('')}>
            Clear Filter
          </button>

          <select value={quickAction} onChange={(event) => setQuickAction(event.target.value as QuickAction)}>
            <option value="new_project">Item &gt; New Project</option>
            <option value="new_task">Item &gt; New Task</option>
            <option value="new_note">Item &gt; New Note</option>
            <option value="group_items">Item &gt; Group Items</option>
            <option value="duplicate_items">Item &gt; Duplicate Items</option>
            <option value="format_project">Item &gt; Format as Project</option>
            <option value="format_task">Item &gt; Format as Task</option>
            <option value="format_note">Item &gt; Format as Note</option>
            <option value="move_up">Item &gt; Move Up</option>
            <option value="move_down">Item &gt; Move Down</option>
            <option value="move_to_project">Item &gt; Move to Project...</option>
            <option value="delete_items">Item &gt; Delete Items</option>
            <option value="tag_with">Item &gt; Tag With...</option>
            <option value="toggle_done">Tag &gt; Toggle @done</option>
            <option value="archive_done">Tag &gt; Archive @done Items</option>
            <option value="insert_date">Edit &gt; Insert Date</option>
            <option value="tag_due">Tag &gt; Due</option>
            <option value="tag_start">Tag &gt; Start</option>
            <option value="export_reminders">Item &gt; Export to Reminders JSON</option>
          </select>
          <button type="button" onClick={runQuickAction}>
            Run
          </button>

          {clampedFocus && (
            <button type="button" onClick={clearFocus}>
              Unfocus ({clampedFocus.label})
            </button>
          )}
        </section>

        <section className="editor-surface">
          <textarea
            ref={editorRef}
            className="free-editor"
            value={viewText}
            spellCheck={false}
            onChange={handleEditorChange}
            onKeyDown={handleEditorKeyDown}
            onSelect={captureSelection}
            placeholder="Type free text here.\n\nProject 1:\n\t- First task\n\t- Second task"
          />

          <aside className="outline-surface">
            <div className="outline-head">Hierarchy (Current Screen)</div>
            <div className="outline-list">
              {outline.rootIds.length === 0 && <p className="empty-tree">Start typing to build hierarchy.</p>}
              {outline.rootIds.map((rootId) => renderTree(rootId))}
            </div>
          </aside>
        </section>

        <footer className="editor-footer">
          <span>Enter: auto item formatting</span>
          <span>Option+Enter: plain newline</span>
          <span>Tab/Shift+Tab: indent/outdent selected items</span>
          <span>Cmd/Ctrl+D: toggle @done</span>
          <span>{statusMessage}</span>
        </footer>
      </main>

      {showGuide && (
        <div
          className="guide-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="guide-title"
          onClick={() => setShowGuide(false)}
        >
          <section className="guide-modal" onClick={(event) => event.stopPropagation()}>
            <div className="guide-head">
              <h2 id="guide-title">Navigation Guide</h2>
              <button type="button" className="guide-close" onClick={() => setShowGuide(false)} aria-label="Close guide">
                ×
              </button>
            </div>

            <div className="guide-content">
              <p>
                <strong>Quick Open:</strong> press <kbd>Cmd/Ctrl + /</kbd> anytime. Press <kbd>Esc</kbd> to close.
              </p>

              <section className="guide-section">
                <h3>Typing Conventions</h3>
                <ul>
                  <li>
                    <strong>Project:</strong> end a line with <code>:</code> (example: <em>Launch Plan:</em>)
                  </li>
                  <li>
                    <strong>Task:</strong> start with <code>- </code> (example: <em>- Draft homepage copy</em>)
                  </li>
                  <li>
                    <strong>Note:</strong> any plain line that is not a project/task pattern
                  </li>
                  <li>
                    <strong>Tags:</strong> type <code>@tag</code> or <code>@tag(value)</code> (example: <code>@due(2026-03-08)</code>)
                  </li>
                  <li>
                    <strong>Macros:</strong> triggers like <code>;lx</code> auto-expand while typing
                  </li>
                </ul>
              </section>

              <section className="guide-section">
                <h3>Core Keyboard</h3>
                <ul>
                  <li>
                    <kbd>Enter</kbd>: new item with auto-format/indent
                  </li>
                  <li>
                    <kbd>Option + Enter</kbd>: plain newline
                  </li>
                  <li>
                    <kbd>Tab</kbd> / <kbd>Shift + Tab</kbd>: indent / outdent
                  </li>
                  <li>
                    <kbd>Cmd/Ctrl + D</kbd>: toggle <code>@done</code> on selected tasks
                  </li>
                  <li>
                    <kbd>Cmd/Ctrl + Shift + A</kbd>: archive done items to <em>Archive:</em>
                  </li>
                </ul>
              </section>

              <section className="guide-section">
                <h3>Selection and Organization</h3>
                <ul>
                  <li>
                    <kbd>Cmd/Ctrl + Shift + D</kbd>: duplicate selected lines
                  </li>
                  <li>
                    <kbd>Ctrl + Shift + K</kbd>: delete selected lines
                  </li>
                  <li>
                    <kbd>Cmd/Ctrl + \</kbd>: move selection to a project
                  </li>
                  <li>
                    <kbd>Cmd + Ctrl + ↑/↓</kbd>: move selected lines up/down
                  </li>
                  <li>
                    <kbd>Cmd/Ctrl + T</kbd>: apply tags to selection
                  </li>
                </ul>
              </section>

              <section className="guide-section">
                <h3>Filter and Focus</h3>
                <ul>
                  <li>
                    <kbd>Cmd/Ctrl + Shift + F</kbd>: jump to filter box
                  </li>
                  <li>
                    Use queries like <code>not @done</code>, <code>@due(today)</code>, or <code>@done and @today</code>
                  </li>
                  <li>Click a project in the sidebar to focus that branch</li>
                  <li>Use the tab bar to switch documents; each tab has its own hierarchy context</li>
                </ul>
              </section>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
