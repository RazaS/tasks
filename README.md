# TaskForge

TaskForge is a TaskPaper-style web app focused on fast outline editing, tag-driven workflows, keyboard navigation, and automation-style scripts.

## Implemented features

- Projects, tasks, and notes in a hierarchical outliner.
- Tag support with values: `@tag` and `@tag(value)`.
- Inline editing with macro auto-expansion while typing.
- Predefined macro support (for example `;lx -> los angeles`) plus custom macro management.
- Fold/unfold per node, plus global fold/unfold scripts.
- Focus mode on any branch.
- Search/filter by content, tags, item type, due status, and negation.
- Saved searches (including default Not Done/Due Today/Past Due).
- Due date helpers and scripts:
  - Convert informal `@due(...)` values to `yyyy-mm-dd` when possible.
  - Add/update `@dueToday`, `@dueTomorrow`, and `@pastDue` helper tags.
  - Replace tomorrow due dates with today.
- Completion workflows:
  - Toggle done with timestamp (`@done(yyyy-mm-dd hh:mm)`).
  - Archive completed branches into an Archive project.
  - Optional delete-done script.
- Recurring tasks using `@repeat(daily|weekly|monthly|Nd|Nw|Nm)` with next instance generation.
- Priority workflow with `@priority(n)` sorting.
- Import/export TaskPaper text (`.taskpaper` / `.txt`).
- Copy selected subtree as TaskPaper-formatted text.
- Keyboard shortcuts:
  - `Enter`: new sibling
  - `Tab` / `Shift+Tab`: indent / outdent
  - `Alt+ArrowUp/ArrowDown`: move node
  - `Cmd/Ctrl + D`: toggle done

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Production build

```bash
npm run build
npm run lint
```

Build output is in `dist/`.

## Deploy notes (VPS + Nginx)

This app is static and can be deployed by copying `dist/` to `/var/www/tasks` and serving it through Nginx.

Example Nginx server block:

```nginx
server {
  listen 80;
  server_name tasks.bloodapps.com;

  root /var/www/tasks;
  index index.html;

  location / {
    try_files $uri /index.html;
  }
}
```

Then run:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

For HTTPS on VPS, use Certbot after DNS points to the server.
