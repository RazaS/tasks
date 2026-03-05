import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import type { ItemKind, MacroDef, SavedSearch, TagValue, TaskDoc, TaskItem } from './types';
import {
  applyMacros,
  createId,
  defaultDocument,
  dueStatusFor,
  editableText,
  formatDateTime,
  matchesSearch,
  nextRepeatDate,
  normalizeDateValue,
  nowIso,
  parseEditableText,
  parseTaskPaper,
  serializeTaskPaper,
  tagsToString,
} from './lib/taskpaper';

const STORAGE_KEY = 'taskpaper-web-pro-v1';

type SiblingRef = {
  siblings: string[];
  parentId: string | null;
  index: number;
};

type CommandId =
  | 'refresh_due_tags'
  | 'normalize_due_dates'
  | 'archive_done'
  | 'sort_current_level'
  | 'sort_by_priority'
  | 'collapse_all'
  | 'expand_all'
  | 'create_inbox_focus'
  | 'remove_done'
  | 'prepend_parent_titles'
  | 'due_tomorrow_to_today'
  | 'add_project_tag'
  | 'leaf_search';

function cloneDoc(doc: TaskDoc): TaskDoc {
  return structuredClone(doc);
}

function getSiblingRef(doc: TaskDoc, id: string): SiblingRef | null {
  const item = doc.items[id];

  if (!item) {
    return null;
  }

  if (item.parentId) {
    const parent = doc.items[item.parentId];
    if (!parent) {
      return null;
    }

    return {
      siblings: parent.children,
      parentId: parent.id,
      index: parent.children.indexOf(id),
    };
  }

  return {
    siblings: doc.rootIds,
    parentId: null,
    index: doc.rootIds.indexOf(id),
  };
}

function removeFromParent(doc: TaskDoc, id: string): void {
  const ref = getSiblingRef(doc, id);

  if (!ref || ref.index === -1) {
    return;
  }

  ref.siblings.splice(ref.index, 1);
}

function insertIntoParent(doc: TaskDoc, id: string, parentId: string | null, index: number): void {
  const item = doc.items[id];
  if (!item) {
    return;
  }

  item.parentId = parentId;

  if (!parentId) {
    const boundedIndex = Math.max(0, Math.min(index, doc.rootIds.length));
    doc.rootIds.splice(boundedIndex, 0, id);
    return;
  }

  const parent = doc.items[parentId];
  if (!parent) {
    return;
  }

  const boundedIndex = Math.max(0, Math.min(index, parent.children.length));
  parent.children.splice(boundedIndex, 0, id);
}

function collectSubtreeIds(items: Record<string, TaskItem>, rootId: string): string[] {
  const list: string[] = [];

  const walk = (id: string) => {
    const item = items[id];
    if (!item) {
      return;
    }

    list.push(id);
    item.children.forEach(walk);
  };

  walk(rootId);
  return list;
}

function isDescendant(items: Record<string, TaskItem>, candidateId: string, ancestorId: string): boolean {
  let cursor: TaskItem | undefined = items[candidateId];

  while (cursor && cursor.parentId) {
    if (cursor.parentId === ancestorId) {
      return true;
    }

    cursor = items[cursor.parentId];
  }

  return false;
}

function itemSortKey(item: TaskItem): string {
  return `${item.title} ${tagsToString(item.tags)}`.toLowerCase();
}

function priorityValue(item: TaskItem): number {
  const raw = item.tags.priority;

  if (!raw) {
    return Number.MAX_SAFE_INTEGER;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    return Number.MAX_SAFE_INTEGER;
  }

  return parsed;
}

function lineTextForItem(item: TaskItem): string {
  const payload = editableText(item);

  if (item.kind === 'task') {
    return payload.length > 0 ? `- ${payload}` : '- ';
  }

  if (item.kind === 'project') {
    return `${payload}:`;
  }

  return payload;
}

function parseLineInput(raw: string): { kind: ItemKind; title: string; tags: Record<string, TagValue> } {
  const trimmed = raw.trim();

  let kind: ItemKind = 'note';
  let payload = trimmed;

  if (trimmed.startsWith('- ')) {
    kind = 'task';
    payload = trimmed.slice(2).trim();
  } else if (trimmed.endsWith(':')) {
    kind = 'project';
    payload = trimmed.slice(0, -1).trim();
  }

  const parsed = parseEditableText(payload);

  return {
    kind,
    title: parsed.title,
    tags: parsed.tags,
  };
}

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [doc, setDoc] = useState<TaskDoc>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return defaultDocument();
    }

    try {
      const parsed = JSON.parse(raw) as TaskDoc;

      if (!parsed.items || !parsed.rootIds || !parsed.savedSearches || !parsed.macros) {
        return defaultDocument();
      }

      return parsed;
    } catch {
      return defaultDocument();
    }
  });

  const [newMacroTrigger, setNewMacroTrigger] = useState('');
  const [newMacroReplacement, setNewMacroReplacement] = useState('');
  const [command, setCommand] = useState<CommandId>('refresh_due_tags');
  const [statusMessage, setStatusMessage] = useState('');

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  }, [doc]);

  const selectedItem = doc.selectedId ? doc.items[doc.selectedId] : null;

  const visibleRootIds = useMemo(() => (doc.focusId ? [doc.focusId] : doc.rootIds), [doc.focusId, doc.rootIds]);

  const matchMap = useMemo(() => {
    const map: Record<string, boolean> = {};

    const visit = (id: string): boolean => {
      const item = doc.items[id];
      if (!item) {
        map[id] = false;
        return false;
      }

      const selfMatch = matchesSearch(item, doc.searchQuery, doc.items);
      const childMatch = item.children.some((childId) => visit(childId));
      map[id] = selfMatch || childMatch;
      return map[id];
    };

    visibleRootIds.forEach((rootId) => visit(rootId));

    return map;
  }, [doc.items, doc.searchQuery, visibleRootIds]);

  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};

    Object.values(doc.items).forEach((item) => {
      Object.keys(item.tags).forEach((tag) => {
        counts[tag] = (counts[tag] ?? 0) + 1;
      });

      const dueStatus = dueStatusFor(item);
      if (dueStatus) {
        counts[dueStatus] = (counts[dueStatus] ?? 0) + 1;
      }
    });

    return Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  }, [doc.items]);

  const mutateDoc = (mutator: (draft: TaskDoc) => void) => {
    setDoc((previous) => {
      const draft = cloneDoc(previous);
      mutator(draft);
      return draft;
    });
  };

  const createItem = (kind: ItemKind, parentId: string | null, insertionIndex: number): string => {
    const id = createId('item');
    const timestamp = nowIso();

    mutateDoc((draft) => {
      draft.items[id] = {
        id,
        parentId,
        kind,
        title: kind === 'project' ? 'New Project' : kind === 'task' ? 'New Task' : 'New Note',
        tags: {},
        children: [],
        collapsed: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      insertIntoParent(draft, id, parentId, insertionIndex);
      draft.selectedId = id;
    });

    return id;
  };

  const addSibling = () => {
    if (!doc.selectedId) {
      createItem('project', null, doc.rootIds.length);
      return;
    }

    const selected = doc.items[doc.selectedId];
    if (!selected) {
      return;
    }

    const ref = getSiblingRef(doc, selected.id);
    if (!ref) {
      return;
    }

    createItem(selected.kind === 'project' ? 'project' : 'task', ref.parentId, ref.index + 1);
  };

  const addChild = (kind: ItemKind = 'task') => {
    if (!doc.selectedId) {
      createItem('project', null, doc.rootIds.length);
      return;
    }

    const parent = doc.items[doc.selectedId];
    if (!parent) {
      return;
    }

    createItem(kind, parent.id, parent.children.length);

    mutateDoc((draft) => {
      draft.items[parent.id].collapsed = false;
    });
  };

  const moveSelected = (direction: -1 | 1) => {
    if (!doc.selectedId) {
      return;
    }

    mutateDoc((draft) => {
      const ref = getSiblingRef(draft, draft.selectedId!);
      if (!ref) {
        return;
      }

      const nextIndex = ref.index + direction;
      if (nextIndex < 0 || nextIndex >= ref.siblings.length) {
        return;
      }

      const [id] = ref.siblings.splice(ref.index, 1);
      ref.siblings.splice(nextIndex, 0, id);
    });
  };

  const indentSelected = () => {
    if (!doc.selectedId) {
      return;
    }

    mutateDoc((draft) => {
      const selectedId = draft.selectedId;
      if (!selectedId) {
        return;
      }

      const ref = getSiblingRef(draft, selectedId);
      if (!ref || ref.index <= 0) {
        return;
      }

      const previousSiblingId = ref.siblings[ref.index - 1];
      const previousSibling = draft.items[previousSiblingId];

      if (!previousSibling) {
        return;
      }

      removeFromParent(draft, selectedId);
      draft.items[selectedId].parentId = previousSibling.id;
      previousSibling.children.push(selectedId);
      previousSibling.collapsed = false;
    });
  };

  const outdentSelected = () => {
    if (!doc.selectedId) {
      return;
    }

    mutateDoc((draft) => {
      const selectedId = draft.selectedId;
      if (!selectedId) {
        return;
      }

      const item = draft.items[selectedId];
      if (!item?.parentId) {
        return;
      }

      const parent = draft.items[item.parentId];
      if (!parent) {
        return;
      }

      const grandParentId = parent.parentId;
      const parentRef = getSiblingRef(draft, parent.id);
      if (!parentRef) {
        return;
      }

      removeFromParent(draft, selectedId);
      insertIntoParent(draft, selectedId, grandParentId, parentRef.index + 1);
    });
  };

  const deleteSelected = () => {
    if (!doc.selectedId) {
      return;
    }

    mutateDoc((draft) => {
      const selectedId = draft.selectedId;
      if (!selectedId) {
        return;
      }

      const ref = getSiblingRef(draft, selectedId);
      if (!ref) {
        return;
      }

      const nextSelection = ref.siblings[ref.index + 1] ?? ref.siblings[ref.index - 1] ?? null;
      const subtreeIds = collectSubtreeIds(draft.items, selectedId);

      removeFromParent(draft, selectedId);
      subtreeIds.forEach((id) => {
        delete draft.items[id];
      });

      draft.selectedId = nextSelection;
      if (draft.focusId && !draft.items[draft.focusId]) {
        draft.focusId = null;
      }
    });
  };

  const toggleCollapse = (id: string) => {
    mutateDoc((draft) => {
      const item = draft.items[id];
      if (!item) {
        return;
      }

      item.collapsed = !item.collapsed;
      item.updatedAt = nowIso();
    });
  };

  const selectItem = (id: string) => {
    mutateDoc((draft) => {
      if (!draft.items[id]) {
        return;
      }

      draft.selectedId = id;
    });
  };

  const setItemText = (id: string, rawValue: string) => {
    const expanded = applyMacros(rawValue, doc.macros);
    const parsed = parseLineInput(expanded);

    mutateDoc((draft) => {
      const item = draft.items[id];
      if (!item) {
        return;
      }

      const nextTags: Record<string, TagValue> = { ...parsed.tags };

      if (nextTags.today === true && nextTags.due === undefined) {
        nextTags.due = normalizeDateValue('today');
      }

      if (nextTags.tomorrow === true && nextTags.due === undefined) {
        nextTags.due = normalizeDateValue('tomorrow');
      }

      if (typeof nextTags.due === 'string') {
        nextTags.due = normalizeDateValue(nextTags.due);
      }

      if (nextTags.done === true) {
        nextTags.done = formatDateTime(new Date());
      }

      delete nextTags.dueToday;
      delete nextTags.dueTomorrow;
      delete nextTags.pastDue;

      const dueStatus = dueStatusFor({
        ...item,
        kind: parsed.kind,
        title: parsed.title,
        tags: nextTags,
      });

      if (dueStatus === 'dueToday') {
        nextTags.dueToday = true;
      }

      if (dueStatus === 'dueTomorrow') {
        nextTags.dueTomorrow = true;
      }

      if (dueStatus === 'pastDue') {
        nextTags.pastDue = true;
      }

      item.kind = parsed.kind;
      item.title = parsed.title;
      item.tags = nextTags;
      item.updatedAt = nowIso();
    });
  };

  const toggleDone = (id: string) => {
    mutateDoc((draft) => {
      const item = draft.items[id];
      if (!item) {
        return;
      }

      const alreadyDone = item.tags.done !== undefined;

      if (alreadyDone) {
        delete item.tags.done;
        item.updatedAt = nowIso();
        return;
      }

      item.tags.done = formatDateTime(new Date());
      item.updatedAt = nowIso();

      const repeatRule = item.tags.repeat;
      if (typeof repeatRule !== 'string') {
        return;
      }

      const cloneId = createId('item');
      const created = nowIso();
      const cloneTags: Record<string, TagValue> = {
        ...item.tags,
      };

      delete cloneTags.done;

      const currentDue = typeof cloneTags.due === 'string' ? cloneTags.due : null;
      const nextDue = nextRepeatDate(currentDue, repeatRule);

      if (nextDue) {
        cloneTags.due = nextDue;
      }

      const clone: TaskItem = {
        id: cloneId,
        parentId: item.parentId,
        kind: item.kind,
        title: item.title,
        tags: cloneTags,
        children: [],
        collapsed: false,
        createdAt: created,
        updatedAt: created,
      };

      draft.items[cloneId] = clone;

      const ref = getSiblingRef(draft, id);
      if (ref) {
        ref.siblings.splice(ref.index + 1, 0, cloneId);
      }
    });
  };

  const copySelectedSubtree = async () => {
    if (!doc.selectedId) {
      return;
    }

    const walk = (id: string, depth: number, lines: string[]) => {
      const item = doc.items[id];
      if (!item) {
        return;
      }

      const tagText = tagsToString(item.tags);
      const body = tagText ? `${item.title} ${tagText}`.trim() : item.title;
      const line =
        item.kind === 'task'
          ? `- ${body}`
          : item.kind === 'project'
            ? `${body}:`
            : body;

      lines.push(`${'  '.repeat(depth)}${line}`);
      item.children.forEach((childId) => walk(childId, depth + 1, lines));
    };

    const lines: string[] = [];
    walk(doc.selectedId, 0, lines);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setStatusMessage('Copied selected subtree to clipboard.');
    } catch {
      setStatusMessage('Clipboard access failed in this browser context.');
    }
  };

  const exportDocument = () => {
    const content = serializeTaskPaper(doc.items, doc.rootIds);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'tasks.taskpaper';
    anchor.click();
    URL.revokeObjectURL(url);
    setStatusMessage('Exported tasks.taskpaper');
  };

  const importDocument = async (file: File) => {
    const text = await file.text();
    const parsed = parseTaskPaper(text);

    mutateDoc((draft) => {
      draft.items = parsed.items;
      draft.rootIds = parsed.rootIds;
      draft.selectedId = parsed.rootIds[0] ?? null;
      draft.focusId = null;
    });

    setStatusMessage(`Imported ${file.name}`);
  };

  const addSavedSearch = () => {
    const query = doc.searchQuery.trim();
    if (!query) {
      setStatusMessage('Type a search query first.');
      return;
    }

    const name = window.prompt('Saved search name', query);
    if (!name) {
      return;
    }

    mutateDoc((draft) => {
      const search: SavedSearch = {
        id: createId('search'),
        name,
        query,
      };

      draft.savedSearches.push(search);
    });

    setStatusMessage(`Saved search: ${name}`);
  };

  const deleteSavedSearch = (id: string) => {
    mutateDoc((draft) => {
      draft.savedSearches = draft.savedSearches.filter((search) => search.id !== id);
    });
  };

  const addMacro = () => {
    const trigger = newMacroTrigger.trim();
    const replacement = newMacroReplacement.trim();

    if (!trigger || !replacement) {
      return;
    }

    mutateDoc((draft) => {
      const macro: MacroDef = {
        id: createId('macro'),
        trigger,
        replacement,
      };

      draft.macros.push(macro);
    });

    setNewMacroTrigger('');
    setNewMacroReplacement('');
    setStatusMessage(`Macro added: ${trigger} -> ${replacement}`);
  };

  const deleteMacro = (id: string) => {
    mutateDoc((draft) => {
      draft.macros = draft.macros.filter((macro) => macro.id !== id);
    });
  };

  const runCommand = () => {
    mutateDoc((draft) => {
      if (command === 'refresh_due_tags') {
        Object.values(draft.items).forEach((item) => {
          delete item.tags.dueToday;
          delete item.tags.dueTomorrow;
          delete item.tags.pastDue;

          const status = dueStatusFor(item);
          if (status === 'dueToday') {
            item.tags.dueToday = true;
          }

          if (status === 'dueTomorrow') {
            item.tags.dueTomorrow = true;
          }

          if (status === 'pastDue') {
            item.tags.pastDue = true;
          }
        });

        setStatusMessage('Refreshed @dueToday, @dueTomorrow, and @pastDue helper tags.');
        return;
      }

      if (command === 'normalize_due_dates') {
        Object.values(draft.items).forEach((item) => {
          const due = item.tags.due;
          if (typeof due === 'string') {
            item.tags.due = normalizeDateValue(due);
          }
        });

        setStatusMessage('Normalized informal @due values to yyyy-mm-dd when possible.');
        return;
      }

      if (command === 'archive_done') {
        let archiveId = draft.rootIds.find((id) => {
          const item = draft.items[id];
          return item?.kind === 'project' && item.title.toLowerCase() === 'archive';
        });

        if (!archiveId) {
          archiveId = createId('item');
          const stamp = nowIso();

          draft.items[archiveId] = {
            id: archiveId,
            parentId: null,
            kind: 'project',
            title: 'Archive',
            tags: {},
            children: [],
            collapsed: false,
            createdAt: stamp,
            updatedAt: stamp,
          };

          draft.rootIds.push(archiveId);
        }

        const doneIds = Object.values(draft.items)
          .filter((item) => item.tags.done !== undefined && item.id !== archiveId)
          .map((item) => item.id)
          .filter((id) => !isDescendant(draft.items, id, archiveId!));

        const topLevelMoveIds = doneIds.filter((id) => {
          let cursor = draft.items[id];
          while (cursor?.parentId) {
            if (doneIds.includes(cursor.parentId)) {
              return false;
            }
            cursor = draft.items[cursor.parentId];
          }
          return true;
        });

        topLevelMoveIds.forEach((id) => {
          removeFromParent(draft, id);
          insertIntoParent(draft, id, archiveId!, draft.items[archiveId!].children.length);
        });

        setStatusMessage(`Archived ${topLevelMoveIds.length} completed item(s).`);
        return;
      }

      if (command === 'sort_current_level') {
        if (!draft.selectedId) {
          return;
        }

        const ref = getSiblingRef(draft, draft.selectedId);
        if (!ref) {
          return;
        }

        ref.siblings.sort((leftId, rightId) => itemSortKey(draft.items[leftId]).localeCompare(itemSortKey(draft.items[rightId])));
        setStatusMessage('Sorted current level alphabetically.');
        return;
      }

      if (command === 'sort_by_priority') {
        if (!draft.selectedId) {
          return;
        }

        const selected = draft.items[draft.selectedId];
        if (!selected) {
          return;
        }

        const target = selected.kind === 'project' ? selected : selected.parentId ? draft.items[selected.parentId] : null;
        if (!target) {
          return;
        }

        target.children.sort((leftId, rightId) => {
          const priorityGap = priorityValue(draft.items[leftId]) - priorityValue(draft.items[rightId]);
          if (priorityGap !== 0) {
            return priorityGap;
          }

          return itemSortKey(draft.items[leftId]).localeCompare(itemSortKey(draft.items[rightId]));
        });

        setStatusMessage('Sorted selected branch by @priority then title.');
        return;
      }

      if (command === 'collapse_all') {
        Object.values(draft.items).forEach((item) => {
          item.collapsed = true;
        });

        setStatusMessage('Collapsed all items.');
        return;
      }

      if (command === 'expand_all') {
        Object.values(draft.items).forEach((item) => {
          item.collapsed = false;
        });

        setStatusMessage('Expanded all items.');
        return;
      }

      if (command === 'create_inbox_focus') {
        let inboxId = draft.rootIds.find((id) => {
          const item = draft.items[id];
          return item?.kind === 'project' && item.title.toLowerCase() === 'inbox';
        });

        if (!inboxId) {
          inboxId = createId('item');
          const stamp = nowIso();

          draft.items[inboxId] = {
            id: inboxId,
            parentId: null,
            kind: 'project',
            title: 'Inbox',
            tags: {},
            children: [],
            collapsed: false,
            createdAt: stamp,
            updatedAt: stamp,
          };

          draft.rootIds.unshift(inboxId);
        }

        draft.focusId = inboxId;
        draft.selectedId = inboxId;
        setStatusMessage('Focused Inbox project.');
        return;
      }

      if (command === 'remove_done') {
        const doomed = Object.values(draft.items)
          .filter((item) => item.tags.done !== undefined)
          .map((item) => item.id)
          .filter((id) => {
            const parent = draft.items[draft.items[id].parentId ?? ''];
            return !parent || parent.tags.done === undefined;
          });

        doomed.forEach((id) => {
          const subtree = collectSubtreeIds(draft.items, id);
          removeFromParent(draft, id);
          subtree.forEach((nodeId) => {
            delete draft.items[nodeId];
          });
        });

        if (draft.selectedId && !draft.items[draft.selectedId]) {
          draft.selectedId = draft.rootIds[0] ?? null;
        }

        if (draft.focusId && !draft.items[draft.focusId]) {
          draft.focusId = null;
        }

        setStatusMessage(`Deleted ${doomed.length} completed branch(es).`);
        return;
      }

      if (command === 'prepend_parent_titles') {
        if (!draft.selectedId) {
          return;
        }

        const item = draft.items[draft.selectedId];
        if (!item) {
          return;
        }

        const chain: string[] = [];
        let cursor = item.parentId ? draft.items[item.parentId] : undefined;

        while (cursor) {
          if (cursor.kind === 'project') {
            chain.unshift(cursor.title);
          }

          cursor = cursor.parentId ? draft.items[cursor.parentId] : undefined;
        }

        if (chain.length > 0) {
          item.title = `${chain.join(' / ')} :: ${item.title}`;
          item.updatedAt = nowIso();
          setStatusMessage('Prepended parent project path to selected item title.');
        }

        return;
      }

      if (command === 'due_tomorrow_to_today') {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowIso = `${tomorrow.getFullYear()}-${`${tomorrow.getMonth() + 1}`.padStart(2, '0')}-${`${tomorrow.getDate()}`.padStart(2, '0')}`;
        const todayIso = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;

        let changed = 0;

        Object.values(draft.items).forEach((item) => {
          const due = item.tags.due;
          if (typeof due !== 'string') {
            return;
          }

          if (due.toLowerCase() === 'tomorrow' || due === tomorrowIso) {
            item.tags.due = todayIso;
            changed += 1;
          }
        });

        setStatusMessage(`Changed ${changed} due date(s) from tomorrow to today.`);
        return;
      }

      if (command === 'add_project_tag') {
        if (!draft.selectedId) {
          return;
        }

        const selected = draft.items[draft.selectedId];
        if (!selected || selected.kind !== 'project') {
          return;
        }

        const descendants = collectSubtreeIds(draft.items, selected.id).filter((id) => id !== selected.id);
        descendants.forEach((id) => {
          draft.items[id].tags.project = selected.title.toLowerCase().replace(/\s+/g, '-');
        });

        setStatusMessage(`Tagged ${descendants.length} descendant item(s) with @project.`);
        return;
      }

      if (command === 'leaf_search') {
        draft.searchQuery = 'leaf:true';
        setStatusMessage('Showing items with no children.');
      }
    });
  };

  const renderTree = (id: string, depth = 0) => {
    const item = doc.items[id];

    if (!item) {
      return null;
    }

    if (!matchMap[id]) {
      return null;
    }

    const selected = doc.selectedId === id;
    const dueState = dueStatusFor(item);
    const done = item.tags.done !== undefined;
    const openChildren = !item.collapsed || doc.searchQuery.trim().length > 0;

    const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addSibling();
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();

        if (event.shiftKey) {
          outdentSelected();
        } else {
          indentSelected();
        }

        return;
      }

      if (event.altKey && event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelected(-1);
        return;
      }

      if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault();
        moveSelected(1);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        toggleDone(id);
      }
    };

    return (
      <div key={id}>
        <div
          className={`row depth-${Math.min(depth, 7)} ${selected ? 'selected' : ''} ${done ? 'done' : ''} ${dueState ?? ''}`}
          onClick={() => selectItem(id)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              selectItem(id);
            }
          }}
        >
          <button
            className="collapse"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              toggleCollapse(id);
            }}
            title="Fold or unfold"
          >
            {item.children.length === 0 ? '·' : item.collapsed ? '▸' : '▾'}
          </button>

          <input
            className="line"
            value={lineTextForItem(item)}
            onFocus={() => selectItem(id)}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setItemText(id, event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type plain text patterns: - task @due(today), Project:, note"
          />
        </div>

        {openChildren && item.children.map((childId) => renderTree(childId, depth + 1))}
      </div>
    );
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <h1>TaskForge</h1>
        <p className="sidebar-copy">TaskPaper-style outliner with saved scripts, macros, tags, and due logic.</p>

        <section>
          <h2>Quick Add</h2>
          <div className="button-grid">
            <button type="button" onClick={() => createItem('project', null, doc.rootIds.length)}>
              + Project
            </button>
            <button type="button" onClick={() => createItem('task', null, doc.rootIds.length)}>
              + Task
            </button>
            <button type="button" onClick={() => addSibling()}>
              + Sibling
            </button>
            <button type="button" onClick={() => addChild('task')}>
              + Child
            </button>
          </div>
        </section>

        <section>
          <h2>Saved Searches</h2>
          <div className="list">
            {doc.savedSearches.map((search) => (
              <div className="list-row" key={search.id}>
                <button
                  type="button"
                  className="list-main"
                  onClick={() => {
                    setDoc((previous) => ({ ...previous, searchQuery: search.query }));
                  }}
                >
                  {search.name}
                </button>
                <button type="button" onClick={() => deleteSavedSearch(search.id)}>
                  x
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={addSavedSearch}>
            Save Current Query
          </button>
        </section>

        <section>
          <h2>Tags</h2>
          <div className="tag-list">
            {tagCounts.map(([tag, count]) => (
              <button
                type="button"
                key={tag}
                onClick={() => setDoc((previous) => ({ ...previous, searchQuery: `@${tag}` }))}
              >
                @{tag} ({count})
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>Macros</h2>
          <p className="small">Example: `;lx` auto-expands to `los angeles` while typing.</p>
          <div className="list">
            {doc.macros.map((macro) => (
              <div className="list-row" key={macro.id}>
                <span className="mono">
                  {macro.trigger} {'->'} {macro.replacement}
                </span>
                <button type="button" onClick={() => deleteMacro(macro.id)}>
                  x
                </button>
              </div>
            ))}
          </div>
          <input
            value={newMacroTrigger}
            onChange={(event) => setNewMacroTrigger(event.target.value)}
            placeholder="Trigger, e.g. ;sf"
          />
          <input
            value={newMacroReplacement}
            onChange={(event) => setNewMacroReplacement(event.target.value)}
            placeholder="Replacement text"
          />
          <button type="button" onClick={addMacro}>
            Add Macro
          </button>
        </section>

        <section>
          <h2>Scripts</h2>
          <select value={command} onChange={(event) => setCommand(event.target.value as CommandId)}>
            <option value="refresh_due_tags">Add/refresh @dueToday @dueTomorrow @pastDue</option>
            <option value="normalize_due_dates">Convert informal @due values to yyyy-mm-dd</option>
            <option value="archive_done">Archive completed items into Archive project</option>
            <option value="sort_current_level">Sort selected level alphabetically</option>
            <option value="sort_by_priority">Sort selected branch by @priority</option>
            <option value="collapse_all">Fold all items</option>
            <option value="expand_all">Unfold all items</option>
            <option value="create_inbox_focus">Create/focus Inbox</option>
            <option value="remove_done">Delete @done items instead of archive</option>
            <option value="prepend_parent_titles">Prepend parent project names</option>
            <option value="due_tomorrow_to_today">Replace due tomorrow with today</option>
            <option value="add_project_tag">Add @project tag to descendants</option>
            <option value="leaf_search">Show nodes with no children</option>
          </select>
          <button type="button" onClick={runCommand}>
            Run Script
          </button>
        </section>
      </aside>

      <main className="workspace">
        <header className="toolbar">
          <div className="left">
            <input
              value={doc.searchQuery}
              onChange={(event) => setDoc((previous) => ({ ...previous, searchQuery: event.target.value }))}
              placeholder="Search by text, @tag, type:task, due:today, -@done"
            />
            <button type="button" onClick={() => setDoc((previous) => ({ ...previous, searchQuery: '' }))}>
              Clear
            </button>
            <button type="button" onClick={() => setDoc((previous) => ({ ...previous, focusId: null }))}>
              Unfocus
            </button>
          </div>

          <div className="right">
            <button
              type="button"
              onClick={() => {
                if (!doc.selectedId) {
                  return;
                }

                setDoc((previous) => ({ ...previous, focusId: previous.selectedId }));
              }}
            >
              Focus Selected
            </button>
            <button type="button" onClick={deleteSelected}>
              Delete
            </button>
            <button type="button" onClick={copySelectedSubtree}>
              Copy Branch
            </button>
            <button type="button" onClick={exportDocument}>
              Export
            </button>
            <button type="button" onClick={() => fileInputRef.current?.click()}>
              Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".taskpaper,.txt,text/plain"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void importDocument(file);
                }

                event.currentTarget.value = '';
              }}
            />
          </div>
        </header>

        <section className="status-bar">
          <div>
            Selected:{' '}
            <strong>
              {selectedItem ? `${selectedItem.title || '(untitled)'} [${selectedItem.kind}]` : 'None'}
            </strong>
          </div>
          <div className="status-message">{statusMessage}</div>
        </section>

        <section className="editor">
          {visibleRootIds.length === 0 && <p className="empty">No items yet. Use Quick Add.</p>}
          {visibleRootIds.map((id) => renderTree(id))}
        </section>

        <footer className="hints">
          <span>Enter: new sibling</span>
          <span>Tab/Shift+Tab: indent/outdent</span>
          <span>Alt+Arrow: move up/down</span>
          <span>Cmd/Ctrl+D: toggle done</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
