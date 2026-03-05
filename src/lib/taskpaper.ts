import type { DueStatus, ItemKind, MacroDef, TagValue, TaskDoc, TaskItem } from '../types';

const TAG_PATTERN = /(^|\s)@([a-zA-Z0-9_-]+)(?:\(([^)]+)\))?/g;

function pad(value: number): string {
  return `${value}`.padStart(2, '0');
}

export function createId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseEditableText(text: string): { title: string; tags: Record<string, TagValue> } {
  const tags: Record<string, TagValue> = {};

  const stripped = text
    .replace(TAG_PATTERN, (_full, space, tagName, tagValue) => {
      const key = String(tagName).trim();
      const value = tagValue ? String(tagValue).trim() : true;

      if (key.length > 0) {
        tags[key] = value;
      }

      return space;
    })
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title: stripped,
    tags,
  };
}

export function tagsToString(tags: Record<string, TagValue>): string {
  return Object.entries(tags)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => (value === true ? `@${key}` : `@${key}(${value})`))
    .join(' ');
}

export function editableText(item: TaskItem): string {
  const tagText = tagsToString(item.tags);
  return tagText ? `${item.title} ${tagText}`.trim() : item.title;
}

function normalizeIndent(raw: string): number {
  return raw.replace(/\t/g, '  ').length;
}

function parseLine(rawLine: string): {
  indent: number;
  kind: ItemKind;
  title: string;
  tags: Record<string, TagValue>;
} | null {
  if (rawLine.trim().length === 0) {
    return null;
  }

  const match = rawLine.match(/^(\s*)(.*)$/);
  if (!match) {
    return null;
  }

  const indent = normalizeIndent(match[1]);
  const body = match[2].trimEnd();

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
    indent,
    kind,
    title: parsed.title,
    tags: parsed.tags,
  };
}

function serializeLine(item: TaskItem): string {
  const tagText = tagsToString(item.tags);
  const payload = tagText ? `${item.title} ${tagText}`.trim() : item.title;

  if (item.kind === 'task') {
    return `- ${payload}`;
  }

  if (item.kind === 'project') {
    return `${payload}:`;
  }

  return payload;
}

export function parseTaskPaper(text: string): Pick<TaskDoc, 'items' | 'rootIds'> {
  const items: Record<string, TaskItem> = {};
  const rootIds: string[] = [];
  const stack: Array<{ id: string; indent: number }> = [];

  const lines = text.replace(/\r\n/g, '\n').split('\n');

  for (const line of lines) {
    const parsed = parseLine(line);

    if (!parsed) {
      continue;
    }

    const id = createId('item');
    const created = nowIso();

    while (stack.length > 0 && stack[stack.length - 1].indent >= parsed.indent) {
      stack.pop();
    }

    const parent = stack.length > 0 ? stack[stack.length - 1] : null;

    const item: TaskItem = {
      id,
      parentId: parent ? parent.id : null,
      kind: parsed.kind,
      title: parsed.title,
      tags: parsed.tags,
      children: [],
      collapsed: false,
      createdAt: created,
      updatedAt: created,
    };

    items[id] = item;

    if (parent) {
      items[parent.id].children.push(id);
    } else {
      rootIds.push(id);
    }

    stack.push({ id, indent: parsed.indent });
  }

  return { items, rootIds };
}

export function serializeTaskPaper(items: Record<string, TaskItem>, rootIds: string[]): string {
  const lines: string[] = [];

  const walk = (id: string, depth: number) => {
    const item = items[id];
    if (!item) {
      return;
    }

    lines.push(`${'  '.repeat(depth)}${serializeLine(item)}`);

    item.children.forEach((childId) => {
      walk(childId, depth + 1);
    });
  };

  rootIds.forEach((rootId) => {
    walk(rootId, 0);
  });

  return lines.join('\n');
}

export function applyMacros(text: string, macros: MacroDef[]): string {
  let result = text;

  for (const macro of macros) {
    if (!macro.trigger) {
      continue;
    }

    const escaped = macro.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), macro.replacement);
  }

  return result;
}

function parseAsDate(value: string): Date | null {
  const datePart = value.trim().toLowerCase();

  if (!datePart) {
    return null;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (datePart === 'today') {
    return today;
  }

  if (datePart === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }

  if (datePart === 'yesterday') {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  }

  const relativeMatch = datePart.match(/^\+(\d+)([dwm])$/);
  if (relativeMatch) {
    const valueAsNumber = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    const next = new Date(today);

    if (unit === 'd') {
      next.setDate(next.getDate() + valueAsNumber);
    } else if (unit === 'w') {
      next.setDate(next.getDate() + valueAsNumber * 7);
    } else if (unit === 'm') {
      next.setMonth(next.getMonth() + valueAsNumber);
    }

    return next;
  }

  const isoMatch = datePart.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?$/);
  if (isoMatch) {
    const date = new Date(
      Number(isoMatch[1]),
      Number(isoMatch[2]) - 1,
      Number(isoMatch[3]),
      isoMatch[4] ? Number(isoMatch[4]) : 0,
      isoMatch[5] ? Number(isoMatch[5]) : 0,
      0,
      0,
    );

    return Number.isNaN(date.getTime()) ? null : date;
  }

  const slashMatch = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const date = new Date(Number(slashMatch[3]), Number(slashMatch[1]) - 1, Number(slashMatch[2]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

export function normalizeDateValue(value: string): string {
  const parsed = parseAsDate(value);
  if (!parsed) {
    return value;
  }

  return formatDate(parsed);
}

export function dueStatusFor(item: TaskItem): DueStatus {
  const dueValue = item.tags.due;
  if (!dueValue || dueValue === true) {
    return null;
  }

  const due = parseAsDate(String(dueValue));
  if (!due) {
    return null;
  }

  due.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (due.getTime() < today.getTime()) {
    return 'pastDue';
  }

  if (due.getTime() === today.getTime()) {
    return 'dueToday';
  }

  if (due.getTime() === tomorrow.getTime()) {
    return 'dueTomorrow';
  }

  return null;
}

function dateShift(date: Date, days = 0, weeks = 0, months = 0): Date {
  const next = new Date(date);

  if (days) {
    next.setDate(next.getDate() + days);
  }

  if (weeks) {
    next.setDate(next.getDate() + weeks * 7);
  }

  if (months) {
    next.setMonth(next.getMonth() + months);
  }

  return next;
}

export function nextRepeatDate(currentValue: string | null, repeatRule: string): string | null {
  const base = currentValue ? parseAsDate(currentValue) : new Date();

  if (!base) {
    return null;
  }

  const rule = repeatRule.toLowerCase().trim();

  if (rule === 'daily') {
    return formatDate(dateShift(base, 1));
  }

  if (rule === 'weekly') {
    return formatDate(dateShift(base, 0, 1));
  }

  if (rule === 'monthly') {
    return formatDate(dateShift(base, 0, 0, 1));
  }

  const relative = rule.match(/^(\d+)([dwm])$/);
  if (!relative) {
    return null;
  }

  const amount = Number(relative[1]);
  const unit = relative[2];

  if (unit === 'd') {
    return formatDate(dateShift(base, amount));
  }

  if (unit === 'w') {
    return formatDate(dateShift(base, 0, amount));
  }

  if (unit === 'm') {
    return formatDate(dateShift(base, 0, 0, amount));
  }

  return null;
}

function tokenMatch(item: TaskItem, token: string, allItems: Record<string, TaskItem>): boolean {
  const normalized = token.toLowerCase();

  if (normalized.startsWith('@')) {
    const tagToken = normalized.slice(1);
    const tagMatch = tagToken.match(/^([a-z0-9_-]+)(?:\(([^)]+)\))?$/);
    if (!tagMatch) {
      return false;
    }

    const key = tagMatch[1];
    const expectedValue = tagMatch[2];
    const current = item.tags[key];

    if (current === undefined) {
      return false;
    }

    if (!expectedValue) {
      return true;
    }

    return String(current).toLowerCase().includes(expectedValue);
  }

  if (normalized.startsWith('type:')) {
    return item.kind === normalized.replace('type:', '');
  }

  if (normalized === 'leaf' || normalized === 'leaf:true') {
    return item.children.length === 0;
  }

  if (normalized.startsWith('id:')) {
    return item.id.includes(normalized.slice(3));
  }

  if (normalized.startsWith('project:')) {
    const projectName = normalized.slice(8);
    let cursor: TaskItem | undefined = item;

    while (cursor) {
      if (cursor.kind === 'project' && cursor.title.toLowerCase().includes(projectName)) {
        return true;
      }

      cursor = cursor.parentId ? allItems[cursor.parentId] : undefined;
    }

    return false;
  }

  if (normalized.startsWith('due:')) {
    const status = dueStatusFor(item);
    const expected = normalized.slice(4);

    if (expected === 'today') {
      return status === 'dueToday';
    }

    if (expected === 'tomorrow') {
      return status === 'dueTomorrow';
    }

    if (expected === 'past') {
      return status === 'pastDue';
    }
  }

  const haystack = `${item.title} ${tagsToString(item.tags)}`.toLowerCase();
  return haystack.includes(normalized);
}

export function matchesSearch(item: TaskItem, query: string, allItems: Record<string, TaskItem>): boolean {
  const trimmed = query.trim();

  if (!trimmed) {
    return true;
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);

  return tokens.every((rawToken) => {
    const negated = rawToken.startsWith('-');
    const token = negated ? rawToken.slice(1) : rawToken;
    const matched = tokenMatch(item, token, allItems);
    return negated ? !matched : matched;
  });
}

export function defaultDocument(): TaskDoc {
  const template = `Inbox:
  - Plan launch @priority(1) @due(today)
  - Prep recurring check-in @repeat(weekly) @due(tomorrow)
Work:
  - Outline sprint goals @priority(2)
Personal:
  - Grocery run @today
TaskPaper:
  Key Features:
    - Plain text style outline editing
    - Projects, tasks, notes, and @tags
    - Fold, focus, search, and saved queries
`;

  const parsed = parseTaskPaper(template);

  return {
    items: parsed.items,
    rootIds: parsed.rootIds,
    selectedId: parsed.rootIds[0] ?? null,
    focusId: null,
    searchQuery: '',
    savedSearches: [
      { id: createId('search'), name: 'Not Done', query: '-@done' },
      { id: createId('search'), name: 'Due Today', query: 'due:today -@done' },
      { id: createId('search'), name: 'Past Due', query: 'due:past -@done' },
    ],
    macros: [
      { id: createId('macro'), trigger: ';lx', replacement: 'los angeles' },
      { id: createId('macro'), trigger: ';nyc', replacement: 'new york city' },
    ],
  };
}
