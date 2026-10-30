# WorkFlow Data App

The local persistence service for [WorkFlow Journal](https://github.com/isravel/workflow) and [Workflow Companion](https://github.com/isravel/workflow-extension). It stores tasks and their work sessions in `data/activities.json` and exposes them through a small HTTP API. It has no external runtime dependencies.

## Run locally

```bash
git clone https://github.com/isravel/workflow-data.git
cd workflow-data
npm run dev
```

Use Node 20.11 or newer. The service listens on `http://127.0.0.1:7001` by default. `npm start` runs it without file watching. The `data/` directory is created when data is first saved and stays out of Git, along with environment files and logs.

For the browser extension's default connection and an app on port 3001, run:

```bash
PORT=7002 CORS_ORIGIN=http://localhost:3001,http://127.0.0.1:3001 npm start
```

In the original sibling-folder setup, `npm run dev:all` from `app/` starts this service from `../data-app` on port 7002 and the frontend on port 3001. Keep those folder names if you use that command. The combined command does not watch service files; restart it after editing the service.

For a separately started service on port 7001, configure `.env.local` in your Workflow app checkout:

```env
NEXT_PUBLIC_ACTIVITY_API_URL=http://127.0.0.1:7001
```

Restart the frontend after changing `.env.local`.

Run the data app in one terminal and the frontend in another:

```bash
cd workflow-data
npm run dev

cd ../workflow
npm run dev
```

When the API URL is configured, the journal loads and saves activity data through the data app. Existing browser data is uploaded automatically if the data service is empty.

## API

- `GET /health`
- `GET /activities` returns `{ "version": 3, "tasks": [...], "sampleDataState": "pending" | "shown" | "cleared" }` with an `ETag` header identifying that version of the journal.
- `PUT /activities` accepts the same shape and **requires an `If-Match` header** carrying the ETag the client last read. A mismatch returns `412` and changes nothing; a missing header returns `428`. `If-Match: *` is an explicit overwrite, used only for backup imports. A successful write returns the saved journal and its new `ETag`. Validation and file writes are serialized, so two simultaneous writers can never both succeed from the same version.
- `GET /companion-settings` returns `{ "version": 1, "timezone", "defaultCategoryId", "categoryDefaults" }`, or `404` before Workflow has published them.
- `PUT /companion-settings` stores them. Workflow publishes on startup and whenever preferences change; the browser extension reads them. They are saved beside the journal in `companion-settings.json` (override with `COMPANION_SETTINGS_FILE`).

Older version 1 and 2 payloads are still accepted and are upgraded on the next write.

Requests from `chrome-extension://` and `moz-extension://` origins are allowed by CORS so the Workflow Companion can call the service; set `ALLOW_EXTENSION_ORIGINS=false` to turn that off. See the [extension setup instructions](https://github.com/isravel/workflow-extension#readme).

## Configuration

Set these environment variables in the shell that starts the service. Environment files are not loaded automatically.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7001` | Service port. Use `7002` for the extension's default settings. |
| `HOST` | `127.0.0.1` | Listening address. |
| `CORS_ORIGIN` | `http://127.0.0.1:3000,http://localhost:3000` | Comma-separated allowed app origins. |
| `DATA_FILE` | `data/activities.json` in this checkout | Journal file. |
| `COMPANION_SETTINGS_FILE` | `companion-settings.json` beside the journal | Published app defaults. |
| `WORKFLOW_DATA_TOKEN` | unset | Optional bearer token on localhost; required beyond localhost. |
| `ALLOW_EXTENSION_ORIGINS` | `true` | Allow browser extension origins. |

The service validates activity ids, timestamps, required fields, and duplicate ids before writing. Writes use a temporary file and atomic rename to avoid partially written data.

By default the server binds to localhost, so any browser on this computer can use the same data while the service is running. To expose it to other devices, set `HOST`, `CORS_ORIGIN`, and `WORKFLOW_DATA_TOKEN`; do not expose the service without authentication.

This first version is intentionally a single-user data service. Hosting it online requires adding account-based authentication and a durable hosted database before using it for multiple users.
