import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 7001);
const host = process.env.HOST ?? "127.0.0.1";
const dataFile = process.env.DATA_FILE ?? join(appDirectory, "data", "activities.json");
const corsOrigins = new Set((process.env.CORS_ORIGIN ?? "http://127.0.0.1:3000,http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean));
const settingsFile = process.env.COMPANION_SETTINGS_FILE ?? join(dirname(dataFile), "companion-settings.json");
// Browser extensions call from chrome-extension:// and moz-extension:// origins. They already hold
// localhost host permissions, so allowing their CORS origin does not widen access.
const allowExtensionOrigins = process.env.ALLOW_EXTENSION_ORIGINS !== "false";
const accessToken = process.env.WORKFLOW_DATA_TOKEN?.trim() || null;
const legacyActivityVersion = 1;
const legacyJournalVersion = 2;
const storageVersion = 3;
const sampleDataStates = new Set(["pending", "shown", "cleared"]);
const taskStatuses = new Set(["open", "in-progress", "on-hold", "fixed", "closed", "reopened"]);
const maximumBodyBytes = 2 * 1024 * 1024;
const activityColorTokens = new Set([
  "teal-600",
  "grey-600",
  "ngrey-600",
  "red-600",
  "orange-600",
  "yellow-600",
  "lime-600",
  "green-600",
  "cyan-600",
  "blue-600",
  "indigo-600",
  "violet-600",
  "pink-600",
  "jade-600",
  "cherry-600",
  "amber-600",
  "brown-600",
]);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

if (!accessToken && host !== "127.0.0.1" && host !== "localhost") {
  throw new Error("WORKFLOW_DATA_TOKEN is required when the data app is exposed beyond localhost.");
}

const json = (response, status, body, origin, headers = {}) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type, authorization, if-match",
    "access-control-allow-methods": "GET, PUT, OPTIONS",
    "access-control-expose-headers": "etag",
    vary: "Origin",
    ...headers,
  });
  response.end(JSON.stringify(body));
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const errorMessage = (error) => error instanceof Error ? error.message : "Unexpected data service error.";

// Journal validation and file writes run one at a time so a conditional write always compares
// against the exact state it is about to replace.
let writeChain = Promise.resolve();
const serialized = (task) => {
  const run = writeChain.then(task, task);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
};

// The ETag identifies the normalized journal content, so it is stable across restarts and file formats.
const etagFor = (store) => `"${createHash("sha256").update(JSON.stringify(store)).digest("hex").slice(0, 32)}"`;

const etagMatches = (header, etag) => String(header)
  .split(",")
  .map((candidate) => candidate.trim().replace(/^W\//, ""))
  .some((candidate) => candidate === etag);

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const isValidTimestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

const validateLegacyActivities = (value) => {
  if (!Array.isArray(value)) throw new Error("activities must be an array.");
  const ids = new Set();

  value.forEach((activity, index) => {
    if (!isRecord(activity)) throw new Error(`Activity ${index + 1} must be an object.`);
    if (typeof activity.id !== "string" || activity.id.trim() === "") throw new Error(`Activity ${index + 1} has an invalid id.`);
    if (ids.has(activity.id)) throw new Error(`Activity ids must be unique: ${activity.id}.`);
    ids.add(activity.id);
    if (typeof activity.title !== "string" || activity.title.trim() === "") throw new Error(`Activity ${index + 1} has an invalid title.`);
    if (!isValidTimestamp(activity.startAt)) throw new Error(`Activity ${index + 1} has an invalid start time.`);
    if (activity.endAt !== null && !isValidTimestamp(activity.endAt)) throw new Error(`Activity ${index + 1} has an invalid end time.`);
    if (activity.endAt !== null && Date.parse(activity.endAt) < Date.parse(activity.startAt)) {
      throw new Error(`Activity ${index + 1} ends before it starts.`);
    }
    if (typeof activity.categoryId !== "string" || activity.categoryId.trim() === "") throw new Error(`Activity ${index + 1} has an invalid category.`);
    if (activity.colorToken !== undefined && !activityColorTokens.has(activity.colorToken)) throw new Error(`Activity ${index + 1} has an invalid color.`);
    if (activity.isSample !== undefined && typeof activity.isSample !== "boolean") throw new Error(`Activity ${index + 1} has an invalid sample marker.`);
    if (typeof activity.notes !== "string") throw new Error(`Activity ${index + 1} has invalid notes.`);
    if (!Array.isArray(activity.tags) || activity.tags.some((tag) => typeof tag !== "string")) throw new Error(`Activity ${index + 1} has invalid tags.`);
    if (activity.priority !== undefined && (typeof activity.priority !== "string" || activity.priority.trim() === "")) throw new Error(`Activity ${index + 1} has an invalid priority.`);
    if (activity.taskId !== undefined && (typeof activity.taskId !== "string" || activity.taskId.trim() === "")) throw new Error(`Activity ${index + 1} has an invalid task link.`);
  });

  return value;
};

const validateSession = (session, taskIndex, index, sessionIds) => {
  const where = `Session ${index + 1} of task ${taskIndex + 1}`;
  if (!isRecord(session)) throw new Error(`${where} must be an object.`);
  if (typeof session.id !== "string" || session.id.trim() === "") throw new Error(`${where} has an invalid id.`);
  if (sessionIds.has(session.id)) throw new Error(`Work session ids must be unique: ${session.id}.`);
  sessionIds.add(session.id);
  if (!isValidTimestamp(session.startAt)) throw new Error(`${where} has an invalid start time.`);
  if (session.endAt !== null && !isValidTimestamp(session.endAt)) throw new Error(`${where} has an invalid end time.`);
  if (session.endAt !== null && Date.parse(session.endAt) < Date.parse(session.startAt)) {
    throw new Error(`${where} ends before it starts.`);
  }
  if (typeof session.categoryId !== "string" || session.categoryId.trim() === "") throw new Error(`${where} has an invalid category.`);
  if (session.colorToken !== undefined && !activityColorTokens.has(session.colorToken)) throw new Error(`${where} has an invalid color.`);
  if (session.isSample !== undefined && typeof session.isSample !== "boolean") throw new Error(`${where} has an invalid sample marker.`);
  if (typeof session.notes !== "string") throw new Error(`${where} has invalid notes.`);
  if (!Array.isArray(session.tags) || session.tags.some((tag) => typeof tag !== "string")) throw new Error(`${where} has invalid tags.`);
  if (session.priority !== undefined && (typeof session.priority !== "string" || session.priority.trim() === "")) throw new Error(`${where} has an invalid priority.`);
  return session;
};

const validateTaskMetadata = (task, index, ids) => {
  if (!isRecord(task)) throw new Error(`Task ${index + 1} must be an object.`);
  if (typeof task.id !== "string" || task.id.trim() === "") throw new Error(`Task ${index + 1} has an invalid id.`);
  if (ids.has(task.id)) throw new Error(`Task ids must be unique: ${task.id}.`);
  ids.add(task.id);
  if (typeof task.title !== "string" || task.title.trim() === "") throw new Error(`Task ${index + 1} has an invalid title.`);
  if (typeof task.description !== "string") throw new Error(`Task ${index + 1} has invalid description.`);
  if (task.dueDate !== null && (typeof task.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) || Number.isNaN(Date.parse(`${task.dueDate}T00:00:00Z`)))) throw new Error(`Task ${index + 1} has an invalid due date.`);
  if (!taskStatuses.has(task.status)) throw new Error(`Task ${index + 1} has an invalid status.`);
  if (!isValidTimestamp(task.createdAt) || !isValidTimestamp(task.updatedAt)) throw new Error(`Task ${index + 1} has invalid timestamps.`);
  return task;
};

// Tasks own their work sessions; nothing else carries a start or end time.
const validateTasks = (value) => {
  if (!Array.isArray(value)) throw new Error("tasks must be an array.");
  const ids = new Set();
  const sessionIds = new Set();

  return value.map((task, index) => {
    validateTaskMetadata(task, index, ids);
    if (task.sessions !== undefined && !Array.isArray(task.sessions)) throw new Error(`Task ${index + 1} has invalid work sessions.`);
    const sessions = (task.sessions ?? []).map((session, sessionIndex) => validateSession(session, index, sessionIndex, sessionIds));
    return { ...task, sessions };
  });
};

const sessionFromActivity = (activity, id) => {
  const { title: _title, taskId: _taskId, id: _id, ...rest } = activity;
  return { ...rest, id };
};

// Fold a pre-unification payload into tasks with sessions, preserving every record.
const migrateLegacyStore = (activities, legacyTasks) => {
  validateLegacyActivities(activities);
  const ids = new Set();
  const tasks = legacyTasks.map((task, index) => ({
    ...validateTaskMetadata(task, index, ids),
    sessions: [],
  }));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const usedIds = new Set(tasks.map((task) => task.id));
  const uniqueId = (candidate) => {
    if (!usedIds.has(candidate)) return candidate;
    let suffix = 2;
    while (usedIds.has(`${candidate}-${suffix}`)) suffix += 1;
    return `${candidate}-${suffix}`;
  };

  for (const activity of activities) {
    const linked = activity.taskId ? tasksById.get(activity.taskId) : undefined;
    if (linked) {
      linked.sessions.push(sessionFromActivity(activity, activity.id));
      continue;
    }
    const id = uniqueId(activity.id);
    usedIds.add(id);
    const timestamp = activity.createdAt ?? activity.startAt;
    const task = {
      id,
      title: activity.title,
      description: "",
      dueDate: null,
      status: "in-progress",
      createdAt: timestamp,
      updatedAt: activity.updatedAt ?? timestamp,
      sessions: [sessionFromActivity(activity, `${id}-session`)],
    };
    tasks.push(task);
    tasksById.set(task.id, task);
  }

  return tasks;
};

const normalizeStore = (tasks, sampleDataState) => {
  const validTasks = validateTasks(tasks);
  const normalizedSampleDataState = validTasks.length > 0
    ? sampleDataState === "cleared" ? "cleared" : "shown"
    : sampleDataStates.has(sampleDataState) ? sampleDataState : "pending";
  return { version: storageVersion, tasks: validTasks, sampleDataState: normalizedSampleDataState };
};

const emptyStore = () => ({ version: storageVersion, tasks: [], sampleDataState: "pending" });

const settingsVersion = 1;

const isValidTimezone = (value) => {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

// Companion settings are the small slice of Workflow's personal settings the extension needs
// to make the same decisions the app would: which day it is, and how a new session is categorized.
const validateCompanionSettings = (value) => {
  if (!isRecord(value)) throw new Error("Settings must be an object.");
  if (!isValidTimezone(value.timezone)) throw new Error("Settings have an invalid timezone.");
  if (typeof value.defaultCategoryId !== "string" || value.defaultCategoryId.trim() === "") {
    throw new Error("Settings have an invalid default category.");
  }
  if (!isRecord(value.categoryDefaults)) throw new Error("Settings have invalid category defaults.");
  const categoryDefaults = {};
  for (const [categoryId, entry] of Object.entries(value.categoryDefaults)) {
    if (!isRecord(entry)) throw new Error(`Settings have invalid defaults for category ${categoryId}.`);
    if (typeof entry.priority !== "string" || entry.priority.trim() === "") {
      throw new Error(`Settings have an invalid priority for category ${categoryId}.`);
    }
    categoryDefaults[categoryId] = { priority: entry.priority };
  }
  return {
    version: settingsVersion,
    timezone: value.timezone,
    defaultCategoryId: value.defaultCategoryId,
    categoryDefaults,
  };
};

const readSettings = async () => {
  try {
    const parsed = JSON.parse(await readFile(settingsFile, "utf8"));
    if (!isRecord(parsed) || parsed.version !== settingsVersion) throw new Error("Stored settings have an incompatible version.");
    return validateCompanionSettings(parsed);
  } catch (error) {
    // Nothing is published until Workflow has run once; the extension treats that as "not available".
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const writeSettings = async (settings) => {
  await mkdir(dirname(settingsFile), { recursive: true });
  const temporaryFile = `${settingsFile}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(settings, null, 2), "utf8");
  await rename(temporaryFile, settingsFile);
};

const readStore = async () => {
  try {
    const contents = await readFile(dataFile, "utf8");
    const parsed = JSON.parse(contents);
    if (!isRecord(parsed)) throw new Error("Stored activity data has an incompatible version.");
    if (parsed.version === storageVersion) {
      const savedEmpty = Array.isArray(parsed.tasks) && parsed.tasks.length === 0;
      return normalizeStore(parsed.tasks, parsed.sampleDataState ?? (savedEmpty ? "cleared" : undefined));
    }
    if (parsed.version !== legacyActivityVersion && parsed.version !== legacyJournalVersion) {
      throw new Error("Stored activity data has an incompatible version.");
    }
    const savedEmptyJournal = Array.isArray(parsed.activities)
      && parsed.activities.length === 0
      && (parsed.version === legacyActivityVersion || (Array.isArray(parsed.tasks) && parsed.tasks.length === 0));
    const migrated = migrateLegacyStore(
      parsed.activities ?? [],
      parsed.version === legacyJournalVersion && Array.isArray(parsed.tasks) ? parsed.tasks : [],
    );
    return normalizeStore(migrated, parsed.sampleDataState ?? (savedEmptyJournal ? "cleared" : undefined));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    throw error;
  }
};

const writeStore = async (tasks, sampleDataState) => {
  await mkdir(dirname(dataFile), { recursive: true });
  const temporaryFile = `${dataFile}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(normalizeStore(tasks, sampleDataState), null, 2), "utf8");
  await rename(temporaryFile, dataFile);
};

const readRequestBody = async (request) => {
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBodyBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
};

const authorized = (request) => {
  if (!accessToken) return true;
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = Buffer.from(accessToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

const server = createServer(async (request, response) => {
  const requestOrigin = request.headers.origin;
  const isExtensionOrigin = allowExtensionOrigins
    && typeof requestOrigin === "string"
    && /^(chrome|moz)-extension:\/\//.test(requestOrigin);
  const origin = requestOrigin && (corsOrigins.has("*") || corsOrigins.has(requestOrigin) || isExtensionOrigin)
    ? requestOrigin
    : [...corsOrigins][0] ?? "null";

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "content-type, authorization, if-match",
      "access-control-allow-methods": "GET, PUT, OPTIONS",
      "access-control-expose-headers": "etag",
      vary: "Origin",
    });
    response.end();
    return;
  }

  if (!authorized(request)) {
    json(response, 401, { error: "Unauthorized." }, origin);
    return;
  }

  try {
    if (request.url === "/health" && request.method === "GET") {
      json(response, 200, { ok: true, service: "workflow-data-app" }, origin);
      return;
    }

    if (request.url === "/activities" && request.method === "GET") {
      // Reads wait for any write in flight so they never observe a half-finished save.
      const store = await serialized(readStore);
      json(response, 200, store, origin, { etag: etagFor(store) });
      return;
    }

    if (request.url === "/activities" && request.method === "PUT") {
      const ifMatch = request.headers["if-match"];
      if (!ifMatch) {
        throw new HttpError(428, "Journal writes require an If-Match header. Reload the journal and try again.");
      }
      const payload = await readRequestBody(request);
      if (!isRecord(payload)) throw new Error("Request body must be an object.");
      // Older payload shapes are migrated before saving.
      const incoming = payload.version === storageVersion
        ? normalizeStore(payload.tasks, payload.sampleDataState)
        : normalizeStore(
          migrateLegacyStore(
            payload.activities ?? [],
            payload.version === legacyJournalVersion && Array.isArray(payload.tasks) ? payload.tasks : [],
          ),
          payload.sampleDataState,
        );
      const saved = await serialized(async () => {
        const current = await readStore();
        const currentEtag = etagFor(current);
        if (ifMatch !== "*" && !etagMatches(ifMatch, currentEtag)) {
          throw new HttpError(412, "The shared journal changed since it was last loaded. Reload it before saving again.");
        }
        await writeStore(incoming.tasks, incoming.sampleDataState);
        return incoming;
      });
      json(response, 200, saved, origin, { etag: etagFor(saved) });
      return;
    }

    if (request.url === "/companion-settings" && request.method === "GET") {
      const settings = await readSettings();
      if (!settings) {
        json(response, 404, { error: "Workflow has not published companion settings yet. Open Workflow once." }, origin);
        return;
      }
      json(response, 200, settings, origin);
      return;
    }

    if (request.url === "/companion-settings" && request.method === "PUT") {
      const settings = validateCompanionSettings(await readRequestBody(request));
      await serialized(() => writeSettings(settings));
      json(response, 200, settings, origin);
      return;
    }

    json(response, 404, { error: "Not found." }, origin);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error("Workflow data request failed:", error);
    if (error instanceof HttpError) {
      json(response, error.status, { error: error.message }, origin);
      return;
    }
    const status = errorMessage(error).startsWith("Request body")
      || errorMessage(error).startsWith("Settings") || errorMessage(error).startsWith("Activity") || errorMessage(error).startsWith("Task") || errorMessage(error).startsWith("Session") || errorMessage(error).startsWith("Work session") || errorMessage(error).startsWith("activities") || errorMessage(error).startsWith("tasks") || errorMessage(error).startsWith("Stored") ? 400 : 500;
    json(response, status, { error: errorMessage(error) }, origin);
  }
});

server.listen(port, host, () => {
  console.log(`Workflow data app listening at http://${host}:${port}`);
  console.log(`Persisting activity data in ${dataFile}`);
  if (!accessToken) console.warn("No WORKFLOW_DATA_TOKEN configured; this service is local-only.");
});
