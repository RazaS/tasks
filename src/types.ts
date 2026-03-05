export type TagValue = true | string;

export type ItemKind = 'project' | 'task' | 'note';

export interface TaskItem {
  id: string;
  parentId: string | null;
  kind: ItemKind;
  title: string;
  tags: Record<string, TagValue>;
  children: string[];
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
}

export interface MacroDef {
  id: string;
  trigger: string;
  replacement: string;
}

export interface TaskDoc {
  items: Record<string, TaskItem>;
  rootIds: string[];
  selectedId: string | null;
  focusId: string | null;
  searchQuery: string;
  savedSearches: SavedSearch[];
  macros: MacroDef[];
}

export type DueStatus = 'pastDue' | 'dueToday' | 'dueTomorrow' | null;
