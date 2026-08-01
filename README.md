# FlowPlan

[![CI](https://github.com/ecosoft-odoo/flowplan/actions/workflows/ci.yml/badge.svg)](https://github.com/ecosoft-odoo/flowplan/actions/workflows/ci.yml)

A simple project timeline that keeps old task dates so you can compare them with the current plan.

## Main features

- Create an account, sign in, and sign out. Passwords are hashed with bcrypt.
- Create separate projects with their own colors.
- Add tasks with dates, status, priority, and assignee.
- Sort the timeline by the earliest start date and jump to today.
- Create a revision automatically when task dates change.
- Show the current plan as a solid bar and the old plan as a dashed bar.
- Click a task to view its revision history and notes.
- View task totals, work in progress, upcoming due dates, and progress.
- Export the plan as an Excel file and import tasks from an Excel file.
- Works on desktop, tablet, and mobile.

## Start with Docker

```bash
docker compose up --build -d
```

Open <http://localhost:3000>

A demo account is created automatically when `SEED_DEMO=true`:

```text
Email: demo@flowplan.local
Password: demo1234
```

Stop the app:

```bash
docker compose down
```

Stop the app and remove all database data:

```bash
docker compose down -v
```

## Excel export and import

Use the **Export** and **Import** buttons next to **Add Task** to move a project plan in and out of Excel (`.xlsx`). Exported workbooks contain two sheets:

- **Timeline** opens first and shows task details next to a color-filled daily, weekly, or monthly timeline. The scale is selected automatically from the overall project duration. Year, month, and day/period are split across three header rows and stored as text, so narrow columns do not display Excel `###`. Month columns alternate between white and a subtle tinted background, while task colors remain prominent. Previous revision plans appear on separate muted rows above the current plan.
- **Raw Data** contains one current task per row for reliable editing and re-import. Import reads this sheet automatically, so formatting or colors in Timeline do not affect task data.

The first row of the sheet holds the column names:

| Column | Required | Values |
| --- | --- | --- |
| `Task` | Yes | Task name |
| `Start` | Yes | Excel date or `YYYY-MM-DD` |
| `End` | Yes | Excel date or `YYYY-MM-DD`, on or after Start |
| `Description` | No | Free text |
| `Status` | No | `Not started`, `In progress`, `Review`, or `Done` (defaults to Not started) |
| `Priority` | No | `Low`, `Medium`, or `High` (defaults to Medium) |
| `Assignee` | No | Person or team |

Import offers two modes. **Replace current tasks** is the default: after every row passes validation, the app deletes the project's existing tasks and revision history and imports the file in one database transaction. **Add to current tasks** keeps existing data and appends every imported row. If replacement fails, the transaction restores the existing plan. Files without a **Raw Data** sheet remain compatible: the app uses a sheet named **Tasks**, or otherwise the first sheet. Exporting an empty project gives a ready-made template — the same file is linked as **Download template** in the import dialog.

## Environment variables

Copy `.env.example` to `.env` to change the settings. Change `JWT_SECRET` before using the app in production.

| Variable | Docker default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Web server port |
| `DATABASE_URL` | PostgreSQL service in Compose | Database connection string |
| `JWT_SECRET` | Local development secret | Secret used to sign the session token |
| `SEED_DEMO` | `true` | Create the demo account and sample data |
| `COOKIE_SECURE` | `false` | Set to `true` when the app uses HTTPS |

## Project structure

```text
project_timeline/
├── public/              # Web page: HTML, CSS, and JavaScript
├── src/
│   ├── db.js            # Database schema and sample data
│   └── index.js         # API, sign-in system, and web server
├── Dockerfile
└── docker-compose.yml
```

The main PostgreSQL tables are `users`, `projects`, `project_members`, `tasks`, and `task_revisions`. The app creates the database schema and indexes automatically when it starts.

## CI and container releases

GitHub Actions runs these checks on every push and pull request to `main`:

- Install dependencies from `package-lock.json` and check JavaScript syntax.
- Audit production npm dependencies for high-severity issues.
- Build the Docker image and start the app with PostgreSQL.
- Test health, sign-in, projects, timeline data, revision history, and Excel export/import.

Dependabot checks npm, Docker, and GitHub Actions dependencies every week.

When a GitHub Release is published, the release workflow builds and publishes a Docker image to:

```text
ghcr.io/ecosoft-odoo/flowplan:<version>
```

The workflow can also be started manually. Manual runs publish an image tagged with the commit SHA. Server deployment is intentionally not automatic because the target server and its secrets must be set first.
