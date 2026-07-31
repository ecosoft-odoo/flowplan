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
- Test health, sign-in, projects, timeline data, and revision history.

Dependabot checks npm, Docker, and GitHub Actions dependencies every week.

When a GitHub Release is published, the release workflow builds and publishes a Docker image to:

```text
ghcr.io/ecosoft-odoo/flowplan:<version>
```

The workflow can also be started manually. Manual runs publish an image tagged with the commit SHA. Server deployment is intentionally not automatic because the target server and its secrets must be set first.
