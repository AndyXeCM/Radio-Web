#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 5173);
const DATA_FILE = path.join(ROOT, "data", "processed", "question_bank.compact.json");
const WEB_ROOT = fs.existsSync(path.join(ROOT, "web"))
  ? path.join(ROOT, "web")
  : path.join(ROOT, "Web");
const STORAGE_DIR = path.join(__dirname, "storage");
const DB_FILE = path.join(STORAGE_DIR, "db.json");
const REPEATER_SEED = path.join(__dirname, "repeaters.seed.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const questionBank = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
const questionById = new Map(questionBank.questions.map((question) => [question.id, question]));

function ensureStorage() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const repeaters = JSON.parse(fs.readFileSync(REPEATER_SEED, "utf-8"));
    writeDb({ users: {}, attempts: [], repeaters });
  }
}

function readDb() {
  ensureStorage();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function writeDb(db) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  res.end(body);
}

function sendError(res, statusCode, message, details = undefined) {
  sendJson(res, statusCode, { error: message, details });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function pickQuestions(searchParams) {
  const level = normalizeText(searchParams.get("level")).toUpperCase();
  const topic = normalizeText(searchParams.get("topic"));
  const query = normalizeText(searchParams.get("q"));
  const type = normalizeText(searchParams.get("type"));
  const limit = Math.min(Number(searchParams.get("limit") || 30), 200);
  const shuffle = searchParams.get("shuffle") !== "false";

  let questions = questionBank.questions.filter((question) => {
    if (level && question.level !== level) return false;
    if (topic && question.topicMajor !== topic && question.point !== topic) return false;
    if (type && question.type !== type) return false;
    if (query) {
      const haystack = [
        question.question,
        question.officialId,
        question.itemCode,
        question.point,
        question.topic,
        ...Object.values(question.choices),
      ].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  if (shuffle) {
    questions = questions
      .map((question) => ({ question, sort: crypto.randomInt(0, 1_000_000) }))
      .sort((a, b) => a.sort - b.sort)
      .map((entry) => entry.question);
  }

  return questions.slice(0, limit);
}

function extractKeywords(question) {
  return question
    .replace(/[：:，,。；;？！?（）()《》“”"、]/g, " ")
    .split(/\s+/)
    .filter((part) => part.length >= 2)
    .slice(0, 5);
}

function buildBreakdown(question, selected = []) {
  const answerText = question.answer
    .map((letter) => `${letter}. ${question.choices[letter]}`)
    .join(" / ");
  const selectedText = selected.length
    ? selected.map((letter) => `${letter}. ${question.choices[letter] || "未知选项"}`).join(" / ")
    : "尚未作答";
  const keywords = extractKeywords(question.question);

  return {
    heading: `${question.topic} · ${question.point}`,
    officialId: question.officialId,
    answerText,
    selectedText,
    weakPointKey: `${question.level}:${question.point}`,
    steps: [
      `题型：${question.type === "multiple" ? "多选" : "单选"}，需要选择 ${question.choiceCount} 个答案。`,
      `先抓题干关键词：${keywords.join(" / ") || question.topic}。`,
      `正确答案是 ${question.answer.join("")}，对应：${answerText}`,
      `复习时把它归入「${question.topic}」下的 ${question.point} 知识点。`,
    ],
  };
}

function isCorrect(question, selected) {
  const expected = [...question.answer].sort().join("");
  const received = [...new Set(selected || [])].sort().join("");
  return expected === received;
}

function computeStats(db, userId) {
  const attempts = db.attempts.filter((attempt) => attempt.userId === userId);
  const latestByQuestion = new Map();
  for (const attempt of attempts) {
    latestByQuestion.set(attempt.questionId, attempt);
  }

  const topicStats = {};
  const levelStats = {};
  for (const attempt of attempts) {
    const question = questionById.get(attempt.questionId);
    if (!question) continue;

    const topicKey = `${question.level}:${question.point}`;
    topicStats[topicKey] ||= {
      key: topicKey,
      level: question.level,
      point: question.point,
      topic: question.topic,
      attempts: 0,
      correct: 0,
    };
    topicStats[topicKey].attempts += 1;
    if (attempt.correct) topicStats[topicKey].correct += 1;

    levelStats[question.level] ||= { level: question.level, attempts: 0, correct: 0 };
    levelStats[question.level].attempts += 1;
    if (attempt.correct) levelStats[question.level].correct += 1;
  }

  const weakTopics = Object.values(topicStats)
    .map((stat) => ({
      ...stat,
      accuracy: stat.attempts ? Math.round((stat.correct / stat.attempts) * 100) : 0,
    }))
    .filter((stat) => stat.attempts >= 2)
    .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts)
    .slice(0, 8);

  const wrongQuestionIds = [...latestByQuestion.values()]
    .filter((attempt) => !attempt.correct)
    .map((attempt) => attempt.questionId);

  return {
    attempts: attempts.length,
    answered: latestByQuestion.size,
    correct: attempts.filter((attempt) => attempt.correct).length,
    accuracy: attempts.length ? Math.round((attempts.filter((attempt) => attempt.correct).length / attempts.length) * 100) : 0,
    wrongCount: wrongQuestionIds.length,
    wrongQuestionIds,
    levelStats,
    weakTopics,
  };
}

function readRequiredText(body, key) {
  const value = String(body[key] || "").trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function createUser(provider, profile = {}) {
  const db = readDb();
  const id = `${provider}_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.users[id] = {
    id,
    provider,
    displayName: profile.displayName || "无线电学习者",
    email: profile.email || null,
    createdAt: now,
    lastSignedInAt: now,
  };
  writeDb(db);
  return db.users[id];
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      generatedAt: questionBank.generatedAt,
      questionCount: questionBank.questions.length,
      storage: DB_FILE,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/banks") {
    sendJson(res, 200, {
      source: questionBank.source,
      topicMap: questionBank.topicMap,
      banks: questionBank.banks,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/questions") {
    sendJson(res, 200, { questions: pickQuestions(url.searchParams) });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/questions/")) {
    const id = decodeURIComponent(pathname.replace("/api/questions/", ""));
    const question = questionById.get(id);
    if (!question) {
      sendError(res, 404, "Question not found");
      return;
    }
    sendJson(res, 200, { question, breakdown: buildBreakdown(question) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/progress/attempt") {
    const body = await parseBody(req);
    const question = questionById.get(body.questionId);
    if (!question) {
      sendError(res, 400, "questionId is required");
      return;
    }
    const userId = body.userId || "guest";
    const selected = Array.isArray(body.selected) ? body.selected : [];
    const correct = isCorrect(question, selected);
    const db = readDb();
    db.attempts.push({
      id: crypto.randomUUID(),
      userId,
      questionId: question.id,
      selected,
      correct,
      mode: body.mode || "practice",
      durationMs: Number(body.durationMs || 0),
      createdAt: new Date().toISOString(),
    });
    writeDb(db);
    sendJson(res, 200, {
      correct,
      answer: question.answer,
      breakdown: buildBreakdown(question, selected),
      stats: computeStats(db, userId),
    });
    return;
  }

  if (req.method === "GET" && pathname.match(/^\/api\/users\/[^/]+\/progress$/)) {
    const userId = decodeURIComponent(pathname.split("/")[3]);
    const db = readDb();
    sendJson(res, 200, computeStats(db, userId));
    return;
  }

  if (req.method === "GET" && pathname.match(/^\/api\/users\/[^/]+\/mistakes$/)) {
    const userId = decodeURIComponent(pathname.split("/")[3]);
    const db = readDb();
    const stats = computeStats(db, userId);
    const level = normalizeText(url.searchParams.get("level")).toUpperCase();
    const questions = stats.wrongQuestionIds
      .map((id) => questionById.get(id))
      .filter(Boolean)
      .filter((question) => !level || question.level === level);
    sendJson(res, 200, { questions, stats });
    return;
  }

  if (req.method === "GET" && pathname.match(/^\/api\/users\/[^/]+\/review$/)) {
    const userId = decodeURIComponent(pathname.split("/")[3]);
    const db = readDb();
    const stats = computeStats(db, userId);
    const weakPoints = new Set(stats.weakTopics.map((topic) => topic.point));
    const level = normalizeText(url.searchParams.get("level")).toUpperCase();
    const reviewQuestions = questionBank.questions
      .filter((question) => weakPoints.has(question.point))
      .filter((question) => !level || question.level === level)
      .slice(0, 40);
    sendJson(res, 200, { questions: reviewQuestions, stats });
    return;
  }

  if (req.method === "POST" && pathname.match(/^\/api\/users\/[^/]+\/progress\/reset$/)) {
    const userId = decodeURIComponent(pathname.split("/")[3]);
    const db = readDb();
    db.attempts = db.attempts.filter((attempt) => attempt.userId !== userId);
    writeDb(db);
    sendJson(res, 200, computeStats(db, userId));
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/demo") {
    const body = await parseBody(req);
    const user = createUser("demo", body);
    sendJson(res, 200, { user });
    return;
  }

  if (req.method === "GET" && pathname === "/api/auth/apple/config") {
    sendJson(res, 200, {
      enabled: Boolean(process.env.APPLE_SERVICE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID),
      serviceId: process.env.APPLE_SERVICE_ID || null,
      bundleId: process.env.APPLE_BUNDLE_ID || "com.aoodyconcorde.Radio",
      redirectUri: process.env.APPLE_REDIRECT_URI || null,
      note: "iOS 端可直接使用 AuthenticationServices。服务端验签需配置 Apple Team ID、Key ID、私钥和 Service ID。",
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/apple/verify") {
    const body = await parseBody(req);
    if (!body.identityToken && !body.authorizationCode) {
      sendError(res, 400, "identityToken or authorizationCode is required");
      return;
    }

    if (process.env.APPLE_SIGN_IN_ALLOW_UNVERIFIED_DEV === "true") {
      const user = createUser("apple-dev", {
        displayName: body.displayName || "Apple 用户",
        email: body.email,
      });
      sendJson(res, 200, { user, mode: "development-unverified" });
      return;
    }

    sendError(res, 501, "Apple token verification is not configured", {
      requiredEnv: ["APPLE_SERVICE_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"],
      developmentBypass: "Set APPLE_SIGN_IN_ALLOW_UNVERIFIED_DEV=true only for local development.",
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/morse/lessons") {
    sendJson(res, 200, {
      lessons: [
        { id: "rhythm", title: "点划节奏", group: ". -", targetWpm: 5, drills: ["E", "T", "I", "M", "A", "N"] },
        { id: "letters-1", title: "高频字母", group: "A N S O R K", targetWpm: 8, drills: ["SOS", "CQ", "AR", "K"] },
        { id: "callsign", title: "呼号听抄", group: "字母与数字", targetWpm: 10, drills: ["B1ABC", "BA7XYZ", "CQ CQ DE"] },
        { id: "q-code", title: "Q 简语", group: "QTH / QSO / QRM", targetWpm: 12, drills: ["QTH", "QSO", "QRM", "QRZ"] },
      ],
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/repeaters") {
    const db = readDb();
    const query = normalizeText(url.searchParams.get("q"));
    const province = normalizeText(url.searchParams.get("province"));
    const repeaters = db.repeaters.filter((repeater) => {
      if (province && normalizeText(repeater.province) !== province) return false;
      if (!query) return true;
      return [repeater.name, repeater.province, repeater.city, repeater.band, repeater.mode]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
    sendJson(res, 200, { repeaters });
    return;
  }

  if (req.method === "POST" && pathname === "/api/repeaters") {
    const body = await parseBody(req);
    try {
      const repeater = {
        id: `local-${crypto.randomUUID()}`,
        name: readRequiredText(body, "name"),
        province: readRequiredText(body, "province"),
        city: readRequiredText(body, "city"),
        band: readRequiredText(body, "band").toUpperCase(),
        downlinkMHz: Number(body.downlinkMHz),
        uplinkMHz: Number(body.uplinkMHz),
        offsetMHz: Number(body.offsetMHz || 0),
        tone: String(body.tone || "未配置").trim(),
        mode: String(body.mode || "FM").trim().toUpperCase(),
        status: "local",
        notes: String(body.notes || "本地新增模板，待审核后可同步到正式数据源。").trim(),
        createdAt: new Date().toISOString(),
      };

      if (!Number.isFinite(repeater.downlinkMHz) || !Number.isFinite(repeater.uplinkMHz)) {
        sendError(res, 400, "downlinkMHz and uplinkMHz must be numbers");
        return;
      }

      const db = readDb();
      db.repeaters.unshift(repeater);
      writeDb(db);
      sendJson(res, 201, { repeater });
      return;
    } catch (error) {
      sendError(res, 400, error.message);
      return;
    }
  }

  sendError(res, 404, "API route not found");
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.resolve(WEB_ROOT, `.${requested}`);
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const fallback = path.join(WEB_ROOT, "index.html");
    res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
    res.end(fs.readFileSync(fallback));
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
  res.end(fs.readFileSync(filePath));
}

ensureStorage();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    sendError(res, 500, "Internal server error", error.message);
  }
});

server.listen(PORT, () => {
  console.log(`Radio service listening on http://localhost:${PORT}`);
  console.log(`Loaded ${questionBank.questions.length} CRAC questions from ${DATA_FILE}`);
});
