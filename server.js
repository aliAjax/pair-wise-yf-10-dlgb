const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = path.join(__dirname, "data", "db.json");
const SCHEMA_VERSION = 2;
const DEFAULT_OPERATOR = "anonymous";

const initialData = {
  meta: { schemaVersion: SCHEMA_VERSION },
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      version: 1,
      createdAt: new Date().toISOString()
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏",
      version: 1
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对",
      version: 1
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      version: 1
    }
  ],
  auditLogs: []
};

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /audit-logs"
];

// 串行化所有写操作，保证“版本校验 + 写入 + 追加轨迹”是一个原子过程
let writeChain = Promise.resolve();
function withWriteLock(task) {
  const result = writeChain.then(() => task());
  writeChain = result.then(
    () => {},
    () => {}
  );
  return result;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

function migrate(db) {
  let changed = false;
  for (const tune of db.tunes || []) {
    if (tune.version === undefined) {
      tune.version = 1;
      changed = true;
    }
  }
  for (const section of db.sections || []) {
    if (section.version === undefined) {
      section.version = 1;
      changed = true;
    }
  }
  for (const issue of db.issues || []) {
    if (issue.version === undefined) {
      issue.version = 1;
      changed = true;
    }
  }
  if (!Array.isArray(db.auditLogs)) {
    db.auditLogs = [];
    changed = true;
  }
  if (!db.meta || db.meta.schemaVersion !== SCHEMA_VERSION) {
    db.meta = { ...(db.meta || {}), schemaVersion: SCHEMA_VERSION };
    changed = true;
  }
  return changed;
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (migrate(db)) {
    await writeFile(DB_FILE, JSON.stringify(db, null, 2));
  }
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

// 深拷贝快照，避免轨迹里保存的前后值被后续改动连带改掉
function snapshot(value) {
  return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

function getOperator(body) {
  return typeof body.operator === "string" && body.operator.trim() ? body.operator : DEFAULT_OPERATOR;
}

// 乐观锁：提交版本与当前版本不一致就报 409，并带上最新内容
function assertCurrentVersion(entity, body) {
  if (body.version === undefined || body.version === null || body.version === "") return;
  if (Number(body.version) !== entity.version) {
    const error = new Error(`版本已过期：当前版本为 v${entity.version}，请基于最新内容重新提交`);
    error.status = 409;
    error.code = "VERSION_CONFLICT";
    error.currentVersion = entity.version;
    error.current = snapshot(entity);
    throw error;
  }
}

// 追加只读轨迹：序号从 1 开始，按保存先后递增
function appendAuditLog(db, entry) {
  const seq = db.auditLogs.reduce((max, log) => Math.max(max, log.seq || 0), 0) + 1;
  const log = {
    seq,
    objectType: entry.objectType,
    objectId: entry.objectId,
    tuneId: entry.tuneId ?? null,
    action: entry.action,
    before: snapshot(entry.before),
    after: snapshot(entry.after),
    operator: entry.operator || DEFAULT_OPERATOR,
    createdAt: new Date().toISOString()
  };
  db.auditLogs.push(log);
  return log;
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const operator = getOperator(body);
    return withWriteLock(async () => {
      const db = await readDb();
      const tune = {
        id: makeId("tune"),
        title: body.title,
        composer: body.composer || "",
        stripSpec: body.stripSpec,
        version: 1,
        createdAt: new Date().toISOString()
      };
      db.tunes.push(tune);
      appendAuditLog(db, {
        objectType: "tune",
        objectId: tune.id,
        tuneId: tune.id,
        action: "create",
        before: null,
        after: tune,
        operator
      });
      await writeDb(db);
      send(res, 201, { data: tune });
    });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const operator = getOperator(body);
    return withWriteLock(async () => {
      const db = await readDb();
      findTune(db, tuneId);
      const section = {
        id: makeId("section"),
        tuneId,
        startBeat: Number(body.startBeat),
        endBeat: Number(body.endBeat),
        laneRange: body.laneRange,
        checked: Boolean(body.checked),
        note: body.note || "",
        version: 1
      };
      db.sections.push(section);
      appendAuditLog(db, {
        objectType: "section",
        objectId: section.id,
        tuneId,
        action: "create",
        before: null,
        after: section,
        operator
      });
      await writeDb(db);
      send(res, 201, { data: section });
    });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const sectionId = checkMatch[1];
    const body = await parseBody(req);
    const operator = getOperator(body);
    return withWriteLock(async () => {
      const db = await readDb();
      const section = db.sections.find((item) => item.id === sectionId);
      if (!section) return send(res, 404, { error: "区间不存在" });
      const before = snapshot(section);
      // 版本过期：直接 409 返回最新内容，本次修改和轨迹都不落库
      assertCurrentVersion(section, body);
      section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
      section.note = body.note ?? section.note;
      section.version += 1;
      appendAuditLog(db, {
        objectType: "section",
        objectId: section.id,
        tuneId: section.tuneId,
        action: "update",
        before,
        after: section,
        operator
      });
      await writeDb(db);
      send(res, 200, { data: section });
    });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    findTune(db, body.tuneId);
    const operator = getOperator(body);
    return withWriteLock(async () => {
      const db = await readDb();
      findTune(db, body.tuneId);
      const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
      if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
      const issue = {
        id: makeId("issue"),
        tuneId: body.tuneId,
        sectionId: body.sectionId,
        type: body.type,
        beat: body.beat === undefined ? null : Number(body.beat),
        lane: body.lane === undefined ? null : Number(body.lane),
        description: body.description,
        status: "open",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        version: 1
      };
      db.issues.push(issue);
      appendAuditLog(db, {
        objectType: "issue",
        objectId: issue.id,
        tuneId: issue.tuneId,
        action: "create",
        before: null,
        after: issue,
        operator
      });
      await writeDb(db);
      send(res, 201, { data: issue });
    });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issueId = issueStatusMatch[1];
    const body = await parseBody(req);
    required(body, ["status"]);
    const operator = getOperator(body);
    return withWriteLock(async () => {
      const db = await readDb();
      const issue = db.issues.find((item) => item.id === issueId);
      if (!issue) return send(res, 404, { error: "问题不存在" });
      const before = snapshot(issue);
      // 版本过期：直接 409 返回最新内容，本次修改和轨迹都不落库
      assertCurrentVersion(issue, body);
      issue.status = body.status;
      issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
      issue.note = body.note ?? issue.note;
      issue.version += 1;
      appendAuditLog(db, {
        objectType: "issue",
        objectId: issue.id,
        tuneId: issue.tuneId,
        action: "update",
        before,
        after: issue,
        operator
      });
      await writeDb(db);
      send(res, 200, { data: issue });
    });
  }

  // 编辑轨迹：按时间倒序（最新在前），序号本身旧记录从 1 开始
  if (req.method === "GET" && pathname === "/audit-logs") {
    const tuneId = searchParams.get("tuneId");
    const objectType = searchParams.get("objectType");
    const objectId = searchParams.get("objectId");
    const logs = db.auditLogs
      .filter(
        (log) =>
          (!tuneId || log.tuneId === tuneId) &&
          (!objectType || log.objectType === objectType) &&
          (!objectId || log.objectId === objectId)
      )
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
        return b.seq - a.seq;
      });
    return send(res, 200, { data: logs });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const body = { error: error.message || "服务器错误" };
    if (error.code) body.code = error.code;
    if (error.currentVersion !== undefined) {
      body.currentVersion = error.currentVersion;
      body.data = error.current;
    }
    send(res, error.status || 500, body);
  });
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
