import { useEffect, useMemo, useRef, useState, type ChangeEventHandler, type KeyboardEventHandler } from 'react';
import './App.css';
import type { MacroDef } from './types';
import { createId, parseTaskPaper, tagsToString } from './lib/taskpaper';

const STORAGE_KEY = 'taskforge-plain-text-v1';

type EditorTab = {
  id: string;
  name: string;
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

type PersistedState = {
  tabs: EditorTab[];
  activeTabId: string;
  macros: MacroDef[];
};

type PendingSelection = {
  start: number;
  end: number;
  focus: boolean;
};

const DEFAULT_TEXT = `Getting Started:
\t- Type a task and press Enter
\t- Use Tab / Shift+Tab to indent and outdent
\nProject 1:
\t- First task
\t- Second task
`;

const DEFAULT_MACROS: MacroDef[] = [
  { id: createId('macro'), trigger: ';lx', replacement: 'los angeles' },
  { id: createId('macro'), trigger: ';nyc', replacement: 'new york city' },
];

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
  const nextCursor = start + replacement.length;

  return { nextText, nextCursor };
}

function getLineStart(text: string, index: number): number {
  return text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
}

function calculateEnterInsert(text: string, start: number, end: number): { nextText: string; nextCursor: number } {
  if (start !== end) {
    return replaceRange(text, start, end, '\n');
  }

  const lineStart = getLineStart(text, start);
  const beforeCursor = text.slice(lineStart, start);
  const leadingWhitespace = beforeCursor.match(/^\s*/)?.[0] ?? '';
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
}

function indentCurrentLine(text: string, start: number, end: number): { nextText: string; nextStart: number; nextEnd: number } {
  const lineStart = getLineStart(text, start);
  const { nextText } = replaceRange(text, lineStart, lineStart, '\t');

  return {
    nextText,
    nextStart: start + 1,
    nextEnd: end + 1,
  };
}

function outdentCurrentLine(text: string, start: number, end: number): { nextText: string; nextStart: number; nextEnd: number } {
  const lineStart = getLineStart(text, start);

  if (text.startsWith('\t', lineStart)) {
    const { nextText } = replaceRange(text, lineStart, lineStart + 1, '');

    return {
      nextText,
      nextStart: Math.max(lineStart, start - 1),
      nextEnd: Math.max(lineStart, end - 1),
    };
  }

  if (text.startsWith('  ', lineStart)) {
    const { nextText } = replaceRange(text, lineStart, lineStart + 2, '');

    return {
      nextText,
      nextStart: Math.max(lineStart, start - 2),
      nextEnd: Math.max(lineStart, end - 2),
    };
  }

  return {
    nextText: text,
    nextStart: start,
    nextEnd: end,
  };
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
  let cursor = selectionStart;
  let expanded = false;

  const sorted = [...macros].sort((left, right) => right.trigger.length - left.trigger.length);

  for (const macro of sorted) {
    if (!macro.trigger) {
      continue;
    }

    const before = nextText.slice(0, cursor);
    if (!before.endsWith(macro.trigger)) {
      continue;
    }

    nextText = `${before.slice(0, -macro.trigger.length)}${macro.replacement}${nextText.slice(cursor)}`;
    cursor = cursor - macro.trigger.length + macro.replacement.length;
    expanded = true;
  }

  return {
    nextText,
    nextStart: cursor,
    nextEnd: cursor,
    expanded,
  };
}

function parseLoadedState(raw: string | null): PersistedState | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as PersistedState;

    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0 || !parsed.activeTabId || !Array.isArray(parsed.macros)) {
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
      activeTabId: parsed.activeTabId,
      macros: parsed.macros.filter((macro) => macro.trigger && macro.replacement),
    };
  } catch {
    return null;
  }
}

function App() {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingSelectionRef = useRef<PendingSelection | null>(null);

  const loaded = parseLoadedState(localStorage.getItem(STORAGE_KEY));

  const [tabs, setTabs] = useState<EditorTab[]>(() => loaded?.tabs ?? [createTab('Home', DEFAULT_TEXT)]);
  const [activeTabId, setActiveTabId] = useState<string>(() => loaded?.activeTabId ?? loaded?.tabs[0]?.id ?? '');
  const [macros, setMacros] = useState<MacroDef[]>(() => loaded?.macros ?? DEFAULT_MACROS);
  const [newMacroTrigger, setNewMacroTrigger] = useState('');
  const [newMacroReplacement, setNewMacroReplacement] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const resolvedActiveTabId = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id ?? '';
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === resolvedActiveTabId) ?? null, [tabs, resolvedActiveTabId]);

  useEffect(() => {
    if (!activeTab) {
      return;
    }

    const payload: PersistedState = {
      tabs,
      activeTabId: activeTab.id,
      macros,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [tabs, activeTab, macros]);

  useEffect(() => {
    if (!activeTab) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const pending = pendingSelectionRef.current;
    if (!pending) {
      return;
    }

    pendingSelectionRef.current = null;

    requestAnimationFrame(() => {
      const safeStart = Math.min(pending.start, editor.value.length);
      const safeEnd = Math.min(pending.end, editor.value.length);

      if (pending.focus) {
        editor.focus();
      }

      editor.setSelectionRange(safeStart, safeEnd);
    });
  }, [activeTab]);

  const outline = useMemo(() => {
    if (!activeTab) {
      return { items: {}, rootIds: [] };
    }

    return parseTaskPaper(activeTab.text);
  }, [activeTab]);

  const updateActiveTab = (updater: (tab: EditorTab) => EditorTab) => {
    if (!activeTab) {
      return;
    }

    setTabs((previous) => previous.map((tab) => (tab.id === activeTab.id ? updater(tab) : tab)));
  };

  const applyEditorUpdate = (nextText: string, nextStart: number, nextEnd: number, focus = true) => {
    if (!activeTab) {
      return;
    }

    pendingSelectionRef.current = {
      start: nextStart,
      end: nextEnd,
      focus,
    };

    updateActiveTab((tab) => ({
      ...tab,
      text: nextText,
      selectionStart: nextStart,
      selectionEnd: nextEnd,
    }));
  };

  const captureSelection = () => {
    if (!activeTab) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const { selectionStart, selectionEnd } = editor;

    updateActiveTab((tab) => ({
      ...tab,
      selectionStart,
      selectionEnd,
    }));
  };

  const handleEditorChange: ChangeEventHandler<HTMLTextAreaElement> = (event) => {
    if (!activeTab) {
      return;
    }

    const text = event.target.value;
    const selectionStart = event.target.selectionStart;
    const selectionEnd = event.target.selectionEnd;

    const expanded = expandMacrosAtCursor(text, selectionStart, selectionEnd, macros);

    applyEditorUpdate(expanded.nextText, expanded.nextStart, expanded.nextEnd, true);

    if (expanded.expanded) {
      setStatusMessage('Macro expanded while typing.');
    }
  };

  const handleEditorKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (!activeTab) {
      return;
    }

    const editor = event.currentTarget;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;

    if (event.key === 'Enter') {
      event.preventDefault();
      const next = calculateEnterInsert(activeTab.text, start, end);
      applyEditorUpdate(next.nextText, next.nextCursor, next.nextCursor, true);
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();

      if (event.shiftKey) {
        const next = outdentCurrentLine(activeTab.text, start, end);
        applyEditorUpdate(next.nextText, next.nextStart, next.nextEnd, true);
        return;
      }

      const next = indentCurrentLine(activeTab.text, start, end);
      applyEditorUpdate(next.nextText, next.nextStart, next.nextEnd, true);
    }
  };

  const createNewTab = () => {
    const index = tabs.length + 1;
    const tab = createTab(`Tab ${index}`, '');

    setTabs((previous) => [...previous, tab]);
    setActiveTabId(tab.id);
    pendingSelectionRef.current = { start: 0, end: 0, focus: true };
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
          selectionStart: editor.selectionStart,
          selectionEnd: editor.selectionEnd,
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
    if (tabs.length === 1) {
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

    const blob = new Blob([activeTab.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = activeTab.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    link.href = url;
    link.download = `${safeName || 'tasks'}.taskpaper`;
    link.click();

    URL.revokeObjectURL(url);
    setStatusMessage(`Exported ${activeTab.name}.`);
  };

  const importToActiveTab = async (file: File) => {
    if (!activeTab) {
      return;
    }

    const text = await file.text();

    applyEditorUpdate(text, text.length, text.length, true);
    setStatusMessage(`Imported ${file.name} into ${activeTab.name}.`);
  };

  const addMacro = () => {
    const trigger = newMacroTrigger.trim();
    const replacement = newMacroReplacement.trim();

    if (!trigger || !replacement) {
      return;
    }

    setMacros((previous) => [
      ...previous,
      {
        id: createId('macro'),
        trigger,
        replacement,
      },
    ]);

    setNewMacroTrigger('');
    setNewMacroReplacement('');
    setStatusMessage(`Macro added: ${trigger} -> ${replacement}`);
  };

  const deleteMacro = (id: string) => {
    setMacros((previous) => previous.filter((macro) => macro.id !== id));
  };

  const renderTree = (id: string, depth = 0) => {
    const item = outline.items[id];

    if (!item) {
      return null;
    }

    const tags = tagsToString(item.tags);

    return (
      <div key={id}>
        <div className="tree-row" style={{ paddingLeft: `${Math.min(depth, 10) * 16 + 10}px` }}>
          <span className={`tree-kind ${item.kind}`}>{item.kind === 'project' ? 'P' : item.kind === 'task' ? 'T' : 'N'}</span>
          <span className="tree-title">{item.title || '(blank)'}</span>
          {tags && <span className="tree-tags">{tags}</span>}
        </div>
        {item.children.map((childId) => renderTree(childId, depth + 1))}
      </div>
    );
  };

  if (!activeTab) {
    return <div className="empty-app">No tabs available.</div>;
  }

  return (
    <div className="app-shell">
      <aside className="left-panel">
        <section className="tree-panel">
          <h2>Hierarchy</h2>
          <p>Active tab: {activeTab.name}</p>
          <div className="tree-list">
            {outline.rootIds.length === 0 && <p className="empty-tree">Start typing to build the tree automatically.</p>}
            {outline.rootIds.map((id) => renderTree(id))}
          </div>
        </section>

        <section className="macro-panel">
          <h2>Macros</h2>
          <p>Typed triggers auto-expand inside the editor.</p>
          <div className="macro-list">
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
          </div>
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
        </section>
      </aside>

      <main className="editor-panel">
        <header className="tabs-bar">
          <div className="tabs">
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
            <button type="button" onClick={renameActiveTab}>
              Rename Tab
            </button>
            <button type="button" onClick={exportActiveTab}>
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
                  void importToActiveTab(file);
                }

                event.currentTarget.value = '';
              }}
            />
          </div>
        </header>

        <section className="editor-surface">
          <textarea
            ref={editorRef}
            className="free-editor"
            value={activeTab.text}
            spellCheck={false}
            onChange={handleEditorChange}
            onKeyDown={handleEditorKeyDown}
            onSelect={captureSelection}
            placeholder="Type free text here.\n\nProject 1:\n\t- First task\n\t- Second task"
          />
        </section>

        <footer className="editor-footer">
          <span>Enter: auto project/task formatting</span>
          <span>Tab/Shift+Tab: indent/outdent current line</span>
          <span>Double Enter on empty bullet exits the list</span>
          <span>{statusMessage}</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
