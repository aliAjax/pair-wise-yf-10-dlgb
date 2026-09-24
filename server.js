const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
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
      version: 1,
      createdAt: new Date().toISOString(),
      resolvedAt: null
    }
  ],
  history: []
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
  "GET /history?tuneId=&objectType=&objectId=&operator="
];

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
  if (!Array.isArray(db.history)) {
    db.history = [];
    changed = true;
  }
  for (const item of [...db.tunes, ...db.sections, ...db.issues]) {
    if (!Number.isInteger(item.version) || item.version < 1) {
      item.version = 1;
      changed = true;
    }
  }
  let maxSeq = db.history.reduce((max, entry) => Math.max(max, Number(entry.seq) || 0), 0);
  for (const entry of db.history) {
    if (!Number.isInteger(entry.seq) || entry.seq < 1) {
      entry.seq = ++maxSeq;
      changed = true;
    }
  }
  return changed;
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (migrate(db)) await writeDb(db);
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function clone(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function nextSeq(db) {
  return db.history.reduce((max, entry) => Math.max(max, Number(entry.seq) || 0), 0) + 1;
}

// 每次保存成功后追加的只读轨迹：对象、前后值、操作人、时间
function appendHistory(db, entry) {
  db.history.push({ seq: nextSeq(db), at: new Date().toISOString(), ...entry });
}

// 乐观锁：提交必须带当前版本；过期则抛 409，并附带最新内容
function checkVersion(object, version) {
  const expected = Number(version);
  if (!Number.isInteger(expected)) {
    const error = new Error("缺少字段或字段非法：version（必须为整数）");
    error.status = 400;
    throw error;
  }
  if (expected !== object.version) {
    const error = new Error(`版本已过期：当前版本为 v${object.version}，请基于最新内容重试`);
    error.status = 409;
    error.latest = object;
    throw error;
  }
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
    required(body, ["title", "stripSpec", "operator"]);
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      version: 1,
      createdAt: new Date().toISOString()
    };
    db.tunes.push(tune);
    appendHistory(db, {
      objectType: "tune",
      objectId: tune.id,
      tuneId: tune.id,
      action: "create",
      version: 1,
      operator: body.operator,
      before: null,
      after: clone(tune)
    });
    await writeDb(db);
    return send(res, 201, { data: tune });
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
    required(body, ["startBeat", "endBeat", "laneRange", "operator"]);
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
    appendHistory(db, {
      objectType: "section",
      objectId: section.id,
      tuneId,
      action: "create",
      version: 1,
      operator: body.operator,
      before: null,
      after: clone(section)
    });
    await writeDb(db);
    return send(res, 201, { data: section });
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
    const section = db.sections.find((item) => item.id === checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    const body = await parseBody(req);
    required(body, ["version", "operator"]);
    checkVersion(section, body.version);
    const before = clone(section);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    section.version += 1;
    appendHistory(db, {
      objectType: "section",
      objectId: section.id,
      tuneId: section.tuneId,
      action: "check",
      version: section.version,
      operator: body.operator,
      before,
      after: clone(section)
    });
    await writeDb(db);
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description", "operator"]);
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
      version: 1,
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    db.issues.push(issue);
    appendHistory(db, {
      objectType: "issue",
      objectId: issue.id,
      tuneId: issue.tuneId,
      action: "create",
      version: 1,
      operator: body.operator,
      before: null,
      after: clone(issue)
    });
    await writeDb(db);
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = db.issues.find((item) => item.id === issueStatusMatch[1]);
    if (!issue) return send(res, 404, { error: "问题不存在" });
    const body = await parseBody(req);
    required(body, ["status", "version", "operator"]);
    checkVersion(issue, body.version);
    const before = clone(issue);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    issue.version += 1;
    appendHistory(db, {
      objectType: "issue",
      objectId: issue.id,
      tuneId: issue.tuneId,
      action: "status",
      version: issue.version,
      operator: body.operator,
      before,
      after: clone(issue)
    });
    await writeDb(db);
    return send(res, 200, { data: issue });
  }

  if (req.method === "GET" && pathname === "/history") {
    const tuneId = searchParams.get("tuneId");
    const objectType = searchParams.get("objectType");
    const objectId = searchParams.get("objectId");
    const operator = searchParams.get("operator");
    const history = db.history
      .filter(
        (entry) =>
          (!tuneId || entry.tuneId === tuneId) &&
          (!objectType || entry.objectType === objectType) &&
          (!objectId || entry.objectId === objectId) &&
          (!operator || entry.operator === operator)
      )
      .sort((a, b) => b.seq - a.seq);
    return send(res, 200, { data: history });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const body = { error: error.message || "服务器错误" };
    // 版本过期时附上最新内容，本次修改与轨迹均未写入
    if (error.latest) body.latest = error.latest;
    send(res, error.status || 500, body);
  });
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
