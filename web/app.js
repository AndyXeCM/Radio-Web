const state = {
  view: "dashboard",
  level: localStorage.getItem("radio.level") || "A",
  user: JSON.parse(localStorage.getItem("radio.user") || "null") || {
    id: "guest",
    displayName: "Guest",
  },
  banks: null,
  questions: [],
  currentIndex: 0,
  selected: new Set(),
  result: null,
  audioContext: null,
  staticMode: location.hostname.endsWith("github.io") || location.protocol === "file:",
  staticBank: null,
  questionById: new Map(),
};

const STORAGE_KEY = "radio.static.db";
const STATIC_BANK_URL = "data/processed/question_bank.compact.json";

const DEFAULT_REPEATERS = [
  {
    id: "cn-demo-bj-uhf-001",
    name: "北京 UHF 中继模板",
    province: "北京",
    city: "北京",
    band: "UHF",
    downlinkMHz: 439.5,
    uplinkMHz: 434.5,
    offsetMHz: -5,
    tone: "88.5 Hz",
    mode: "FM",
    status: "template",
    notes: "示例数据，请在上线前替换为已授权、可公开展示的本地中继资料。",
  },
  {
    id: "cn-demo-sh-vhf-001",
    name: "上海 VHF 中继模板",
    province: "上海",
    city: "上海",
    band: "VHF",
    downlinkMHz: 145.65,
    uplinkMHz: 145.05,
    offsetMHz: -0.6,
    tone: "未配置",
    mode: "FM",
    status: "template",
    notes: "用于展示查询、筛选和后续扩展的数据结构。",
  },
  {
    id: "cn-demo-gd-uhf-001",
    name: "广东 UHF 中继模板",
    province: "广东",
    city: "广州",
    band: "UHF",
    downlinkMHz: 439.75,
    uplinkMHz: 434.75,
    offsetMHz: -5,
    tone: "94.8 Hz",
    mode: "FM",
    status: "template",
    notes: "后续可以接入协会公开数据、用户提交审核流或后台管理。",
  },
];

const MORSE_LESSONS = [
  { id: "rhythm", title: "点划节奏", group: ". -", targetWpm: 5, drills: ["E", "T", "I", "M", "A", "N"] },
  { id: "letters-1", title: "高频字母", group: "A N S O R K", targetWpm: 8, drills: ["SOS", "CQ", "AR", "K"] },
  { id: "callsign", title: "呼号听抄", group: "字母与数字", targetWpm: 10, drills: ["B1ABC", "BA7XYZ", "CQ CQ DE"] },
  { id: "q-code", title: "Q 简语", group: "QTH / QSO / QRM", targetWpm: 12, drills: ["QTH", "QSO", "QRM", "QRZ"] },
];

const MORSE = {
  A: ".-",
  B: "-...",
  C: "-.-.",
  D: "-..",
  E: ".",
  F: "..-.",
  G: "--.",
  H: "....",
  I: "..",
  J: ".---",
  K: "-.-",
  L: ".-..",
  M: "--",
  N: "-.",
  O: "---",
  P: ".--.",
  Q: "--.-",
  R: ".-.",
  S: "...",
  T: "-",
  U: "..-",
  V: "...-",
  W: ".--",
  X: "-..-",
  Y: "-.--",
  Z: "--..",
  0: "-----",
  1: ".----",
  2: "..---",
  3: "...--",
  4: "....-",
  5: ".....",
  6: "-....",
  7: "--...",
  8: "---..",
  9: "----.",
};

const viewTitles = {
  dashboard: "总览",
  practice: "刷题",
  mistakes: "错题",
  review: "复习",
  analysis: "薄弱项",
  morse: "摩斯电码",
  repeaters: "中继查询",
  account: "账号",
};

function $(selector) {
  return document.querySelector(selector);
}

function $all(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

async function api(path, options = {}) {
  if (state.staticMode) {
    return staticApi(path, options);
  }

  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    state.staticMode = true;
    return staticApi(path, options);
  }
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

function loadLocalDb() {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  return saved || { users: {}, attempts: [], repeaters: DEFAULT_REPEATERS };
}

function saveLocalDb(db) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

async function loadStaticBank() {
  if (state.staticBank) return state.staticBank;
  const response = await fetch(STATIC_BANK_URL);
  if (!response.ok) throw new Error("无法加载静态题库 JSON");
  state.staticBank = await response.json();
  state.questionById = new Map(state.staticBank.questions.map((question) => [question.id, question]));
  return state.staticBank;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function staticPickQuestions(searchParams) {
  const level = normalizeText(searchParams.get("level")).toUpperCase();
  const topic = normalizeText(searchParams.get("topic"));
  const query = normalizeText(searchParams.get("q"));
  const type = normalizeText(searchParams.get("type"));
  const limit = Math.min(Number(searchParams.get("limit") || 30), 200);
  const shuffle = searchParams.get("shuffle") !== "false";

  let questions = state.staticBank.questions.filter((question) => {
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

  if (shuffle) questions = questions.map((question) => ({ question, sort: Math.random() })).sort((a, b) => a.sort - b.sort).map((entry) => entry.question);
  return questions.slice(0, limit);
}

function staticCorrect(question, selected) {
  return [...question.answer].sort().join("") === [...new Set(selected || [])].sort().join("");
}

function staticBreakdown(question, selected = []) {
  const answerText = question.answer.map((letter) => `${letter}. ${question.choices[letter]}`).join(" / ");
  const selectedText = selected.length ? selected.map((letter) => `${letter}. ${question.choices[letter] || "未知选项"}`).join(" / ") : "尚未作答";
  return {
    heading: `${question.topic} · ${question.point}`,
    officialId: question.officialId,
    answerText,
    selectedText,
    weakPointKey: `${question.level}:${question.point}`,
    steps: [
      `题型：${question.type === "multiple" ? "多选" : "单选"}，需要选择 ${question.choiceCount} 个答案。`,
      `先抓题干关键词：${question.question.slice(0, 36)}。`,
      `正确答案是 ${question.answer.join("")}，对应：${answerText}`,
      `复习时把它归入「${question.topic}」下的 ${question.point} 知识点。`,
    ],
  };
}

function staticStats(userId) {
  const db = loadLocalDb();
  const attempts = db.attempts.filter((attempt) => attempt.userId === userId);
  const latestByQuestion = new Map(attempts.map((attempt) => [attempt.questionId, attempt]));
  const topicStats = {};
  const levelStats = {};

  for (const attempt of attempts) {
    const question = state.questionById.get(attempt.questionId);
    if (!question) continue;
    const key = `${question.level}:${question.point}`;
    topicStats[key] ||= { key, level: question.level, point: question.point, topic: question.topic, attempts: 0, correct: 0 };
    topicStats[key].attempts += 1;
    if (attempt.correct) topicStats[key].correct += 1;
    levelStats[question.level] ||= { level: question.level, attempts: 0, correct: 0 };
    levelStats[question.level].attempts += 1;
    if (attempt.correct) levelStats[question.level].correct += 1;
  }

  const correctCount = attempts.filter((attempt) => attempt.correct).length;
  const wrongQuestionIds = [...latestByQuestion.values()].filter((attempt) => !attempt.correct).map((attempt) => attempt.questionId);
  const weakTopics = Object.values(topicStats)
    .map((stat) => ({ ...stat, accuracy: stat.attempts ? Math.round((stat.correct / stat.attempts) * 100) : 0 }))
    .filter((stat) => stat.attempts >= 2)
    .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts)
    .slice(0, 8);

  return {
    attempts: attempts.length,
    answered: latestByQuestion.size,
    correct: correctCount,
    accuracy: attempts.length ? Math.round((correctCount / attempts.length) * 100) : 0,
    wrongCount: wrongQuestionIds.length,
    wrongQuestionIds,
    levelStats,
    weakTopics,
  };
}

async function staticApi(path, options = {}) {
  await loadStaticBank();
  const url = new URL(path, location.origin);
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : {};

  if (method === "GET" && url.pathname === "/api/banks") {
    return { source: state.staticBank.source, topicMap: state.staticBank.topicMap, banks: state.staticBank.banks };
  }
  if (method === "GET" && url.pathname === "/api/questions") {
    return { questions: staticPickQuestions(url.searchParams) };
  }
  if (method === "GET" && url.pathname.startsWith("/api/questions/")) {
    const id = decodeURIComponent(url.pathname.replace("/api/questions/", ""));
    const question = state.questionById.get(id);
    return { question, breakdown: staticBreakdown(question) };
  }
  if (method === "POST" && url.pathname === "/api/progress/attempt") {
    const db = loadLocalDb();
    const question = state.questionById.get(body.questionId);
    const selected = Array.isArray(body.selected) ? body.selected : [];
    const correct = staticCorrect(question, selected);
    const userId = body.userId || "guest";
    db.attempts.push({ id: crypto.randomUUID(), userId, questionId: question.id, selected, correct, mode: body.mode || "practice", createdAt: new Date().toISOString() });
    saveLocalDb(db);
    return { correct, answer: question.answer, breakdown: staticBreakdown(question, selected), stats: staticStats(userId) };
  }
  if (method === "GET" && url.pathname.match(/^\/api\/users\/[^/]+\/progress$/)) {
    return staticStats(decodeURIComponent(url.pathname.split("/")[3]));
  }
  if (method === "POST" && url.pathname.match(/^\/api\/users\/[^/]+\/progress\/reset$/)) {
    const userId = decodeURIComponent(url.pathname.split("/")[3]);
    const db = loadLocalDb();
    db.attempts = db.attempts.filter((attempt) => attempt.userId !== userId);
    saveLocalDb(db);
    return staticStats(userId);
  }
  if (method === "GET" && url.pathname.match(/^\/api\/users\/[^/]+\/mistakes$/)) {
    const userId = decodeURIComponent(url.pathname.split("/")[3]);
    const stats = staticStats(userId);
    const level = normalizeText(url.searchParams.get("level")).toUpperCase();
    const questions = stats.wrongQuestionIds.map((id) => state.questionById.get(id)).filter(Boolean).filter((question) => !level || question.level === level);
    return { questions, stats };
  }
  if (method === "GET" && url.pathname.match(/^\/api\/users\/[^/]+\/review$/)) {
    const userId = decodeURIComponent(url.pathname.split("/")[3]);
    const stats = staticStats(userId);
    const weakPoints = new Set(stats.weakTopics.map((topic) => topic.point));
    const level = normalizeText(url.searchParams.get("level")).toUpperCase();
    const questions = state.staticBank.questions.filter((question) => weakPoints.has(question.point)).filter((question) => !level || question.level === level).slice(0, 40);
    return { questions, stats };
  }
  if (method === "POST" && url.pathname === "/api/auth/demo") {
    const db = loadLocalDb();
    const user = { id: `demo_${crypto.randomUUID()}`, provider: "static-demo", displayName: body.displayName || "无线电学习者", email: null, createdAt: new Date().toISOString() };
    db.users[user.id] = user;
    saveLocalDb(db);
    return { user };
  }
  if (method === "GET" && url.pathname === "/api/auth/apple/config") {
    return { enabled: false, serviceId: null, bundleId: "com.aoodyconcorde.Radio", redirectUri: null, note: "GitHub Pages 静态版本不执行服务端验签；iOS 端和 Node 服务端模板已保留 Apple 登录接入点。" };
  }
  if (method === "GET" && url.pathname === "/api/morse/lessons") {
    return { lessons: MORSE_LESSONS };
  }
  if (method === "GET" && url.pathname === "/api/repeaters") {
    const db = loadLocalDb();
    const query = normalizeText(url.searchParams.get("q"));
    const repeaters = db.repeaters.filter((repeater) => !query || [repeater.name, repeater.province, repeater.city, repeater.band, repeater.mode].join(" ").toLowerCase().includes(query));
    return { repeaters };
  }
  if (method === "POST" && url.pathname === "/api/repeaters") {
    const db = loadLocalDb();
    const repeater = {
      id: `local-${crypto.randomUUID()}`,
      name: body.name,
      province: body.province,
      city: body.city,
      band: String(body.band || "UHF").toUpperCase(),
      downlinkMHz: Number(body.downlinkMHz),
      uplinkMHz: Number(body.uplinkMHz),
      offsetMHz: Number(body.offsetMHz || 0),
      tone: body.tone || "未配置",
      mode: "FM",
      status: "local",
      notes: body.notes || "本地新增模板，待审核后可同步到正式数据源。",
      createdAt: new Date().toISOString(),
    };
    db.repeaters.unshift(repeater);
    saveLocalDb(db);
    return { repeater };
  }
  throw new Error(`Static route not implemented: ${method} ${url.pathname}`);
}

function setView(view) {
  state.view = view;
  $("#viewTitle").textContent = viewTitles[view] || view;
  $all(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $all(".view").forEach((section) => section.classList.remove("active"));
  $(`#${view}View`).classList.add("active");

  if (view === "mistakes") loadMistakes();
  if (view === "review") loadReview();
  if (view === "analysis") loadStats();
  if (view === "morse") loadMorseLessons();
  if (view === "repeaters") loadRepeaters();
}

function saveUser(user) {
  state.user = user;
  localStorage.setItem("radio.user", JSON.stringify(user));
  $("#sidebarUser").textContent = user.displayName || user.id;
}

function setLevel(level) {
  state.level = level;
  localStorage.setItem("radio.level", level);
  populateTopics();
  if (state.view === "practice") loadPractice();
  if (state.view === "analysis") loadStats();
}

function renderBanks() {
  const banks = state.banks.banks;
  $("#sourceLine").textContent = `${state.banks.source.name} · ${state.banks.source.detailUrl}`;
  $("#bankMetrics").innerHTML = Object.values(banks)
    .map(
      (bank) => `
      <div class="metric">
        <span>${bank.level} 类题库</span>
        <strong>${bank.count}</strong>
        <span>${bank.multipleCount} 道多选 · ${bank.figureCount} 道图示题</span>
      </div>
    `,
    )
    .join("");
  populateTopics();
}

function populateTopics() {
  if (!state.banks) return;
  const select = $("#topicSelect");
  const bank = state.banks.banks[state.level];
  select.innerHTML =
    '<option value="">全部主题</option>' +
    Object.entries(bank.topics)
      .map(([key, value]) => `<option value="${key}">${value.name} (${value.count})</option>`)
      .join("");
}

async function renderDashboard() {
  const stats = await api(`/api/users/${encodeURIComponent(state.user.id)}/progress`);
  $("#dashboardProgress").innerHTML = `
    <div class="status-row"><span>已作答</span><strong>${stats.answered}</strong></div>
    <div class="status-row"><span>总尝试</span><strong>${stats.attempts}</strong></div>
    <div class="status-row"><span>正确率</span><strong>${stats.accuracy}%</strong></div>
    <div class="status-row"><span>错题数</span><strong>${stats.wrongCount}</strong></div>
  `;

  const weak = stats.weakTopics[0];
  $("#recommendations").innerHTML = weak
    ? `
      <div class="recommendation">
        <strong>优先复习 ${weak.topic}</strong>
        <p>${weak.level} 类 ${weak.point}，最近正确率 ${weak.accuracy}%，建议进入复习队列。</p>
      </div>
      <div class="recommendation">
        <strong>刷一组 ${state.level} 类随机题</strong>
        <p>每组 20 题，做完后看题目拆解和薄弱项。</p>
      </div>
    `
    : `
      <div class="recommendation">
        <strong>先完成一组随机题</strong>
        <p>系统需要至少几次作答，才能判断薄弱知识点。</p>
      </div>
      <div class="recommendation">
        <strong>摩斯节奏热身</strong>
        <p>从 E/T/I/M 开始，先听出点划长短，再练呼号。</p>
      </div>
    `;
}

async function loadPractice() {
  $("#quizStage").innerHTML = '<div class="empty">正在抽题</div>';
  const topic = $("#topicSelect").value;
  const payload = await api(`/api/questions?level=${state.level}&topic=${topic}&limit=20`);
  state.questions = payload.questions;
  state.currentIndex = 0;
  state.selected = new Set();
  state.result = null;
  renderQuestion();
}

function renderQuestion() {
  const question = state.questions[state.currentIndex];
  if (!question) {
    $("#quizStage").innerHTML = '<div class="empty">没有可显示的题目，请重新抽题。</div>';
    $("#sessionMeterFill").style.width = "100%";
    return;
  }

  const canSubmit = state.selected.size > 0 && !state.result;
  const progress = state.questions.length ? ((state.currentIndex + 1) / state.questions.length) * 100 : 0;
  const figure = question.figure
    ? `<div class="figure-note">图示题：${question.figure}。官方 PDF 仅包含附件文件名，当前先以占位状态展示。</div>`
    : "";

  $("#quizTitle").textContent = `${state.level} 类刷题 · ${state.currentIndex + 1}/${state.questions.length}`;
  $("#sessionMeterFill").style.width = `${Math.max(4, Math.min(100, progress))}%`;
  $("#quizStage").innerHTML = `
    <div class="question-meta">
      <span class="chip">${question.topic}</span>
      <span class="chip">${question.point}</span>
      <span class="chip">${question.type === "multiple" ? "多选" : "单选"}</span>
      <span class="chip">${question.officialId}</span>
    </div>
    ${figure}
    <div class="question-text">${question.question}</div>
    <div class="choice-grid">
      ${Object.entries(question.choices)
        .map(([letter, text]) => {
          const selected = state.selected.has(letter);
          const correct = state.result && question.answer.includes(letter);
          const wrong = state.result && selected && !question.answer.includes(letter);
          return `
            <button class="choice-button ${selected ? "selected" : ""} ${correct ? "correct" : ""} ${wrong ? "wrong" : ""}" data-choice="${letter}">
              <strong>${letter}</strong>
              <span>${text}</span>
            </button>
          `;
        })
        .join("")}
    </div>
    <div class="answer-actions">
      <button id="submitAnswerButton" class="primary-button" ${canSubmit ? "" : "disabled"}>提交</button>
      <button id="nextQuestionButton" class="ghost-button">${state.result ? "下一题" : "跳过"}</button>
    </div>
    ${state.result ? renderBreakdown(state.result) : ""}
  `;

  $all(".choice-button").forEach((button) => {
    button.addEventListener("click", () => selectChoice(button.dataset.choice));
  });
  $("#submitAnswerButton").addEventListener("click", submitAnswer);
  $("#nextQuestionButton").addEventListener("click", nextQuestion);
}

function renderBreakdown(result) {
  return `
    <div class="breakdown">
      <h3>${result.correct ? "回答正确" : "需要复习"} · ${result.breakdown.heading}</h3>
      <ol>
        ${result.breakdown.steps.map((step) => `<li>${step}</li>`).join("")}
      </ol>
    </div>
  `;
}

function selectChoice(letter) {
  if (state.result) return;
  const question = state.questions[state.currentIndex];
  if (question.type === "single") {
    state.selected = new Set([letter]);
  } else if (state.selected.has(letter)) {
    state.selected.delete(letter);
  } else {
    state.selected.add(letter);
  }
  renderQuestion();
}

async function submitAnswer() {
  const question = state.questions[state.currentIndex];
  const result = await api("/api/progress/attempt", {
    method: "POST",
    body: JSON.stringify({
      userId: state.user.id,
      questionId: question.id,
      selected: [...state.selected],
      mode: "practice",
    }),
  });
  state.result = result;
  renderQuestion();
  renderDashboard().catch(console.error);
}

function nextQuestion() {
  state.currentIndex += 1;
  state.selected = new Set();
  state.result = null;
  renderQuestion();
}

function renderQuestionRows(container, questions) {
  if (!questions.length) {
    container.innerHTML = '<div class="empty">暂无题目。先去刷题，系统会自动沉淀错题和复习队列。</div>';
    return;
  }
  container.innerHTML = questions
    .map(
      (question) => `
      <div class="question-row">
        <div>
          <strong>${question.level}-${question.itemCode} · ${question.topic}</strong>
          <p>${question.question}</p>
        </div>
        <button class="ghost-button" data-open-question="${question.id}">练这题</button>
      </div>
    `,
    )
    .join("");

  $all("[data-open-question]").forEach((button) => {
    button.addEventListener("click", async () => {
      const payload = await api(`/api/questions/${encodeURIComponent(button.dataset.openQuestion)}`);
      state.questions = [payload.question];
      state.currentIndex = 0;
      state.selected = new Set();
      state.result = null;
      setView("practice");
      renderQuestion();
    });
  });
}

async function loadMistakes() {
  $("#mistakesList").innerHTML = '<div class="empty">正在读取错题</div>';
  const payload = await api(`/api/users/${encodeURIComponent(state.user.id)}/mistakes?level=${state.level}`);
  renderQuestionRows($("#mistakesList"), payload.questions);
}

async function loadReview() {
  $("#reviewList").innerHTML = '<div class="empty">正在生成复习队列</div>';
  const payload = await api(`/api/users/${encodeURIComponent(state.user.id)}/review?level=${state.level}`);
  renderQuestionRows($("#reviewList"), payload.questions);
}

async function loadStats() {
  const stats = await api(`/api/users/${encodeURIComponent(state.user.id)}/progress`);
  $("#analysisSummary").innerHTML = `
    <div class="analysis-card"><span>总尝试</span><strong>${stats.attempts}</strong></div>
    <div class="analysis-card"><span>已作答</span><strong>${stats.answered}</strong></div>
    <div class="analysis-card"><span>正确率</span><strong>${stats.accuracy}%</strong></div>
    <div class="analysis-card"><span>错题</span><strong>${stats.wrongCount}</strong></div>
  `;
  $("#weakTopics").innerHTML = stats.weakTopics.length
    ? stats.weakTopics
        .map(
          (topic) => `
        <div class="weak-item">
          <strong>${topic.level} 类 ${topic.topic} · ${topic.point}</strong>
          <span>${topic.attempts} 次作答，正确率 ${topic.accuracy}%</span>
          <div class="bar"><span style="width:${100 - topic.accuracy}%"></span></div>
        </div>
      `,
        )
        .join("")
    : '<div class="empty">薄弱项需要至少 2 次同知识点作答后生成。</div>';
}

async function loadMorseLessons() {
  const payload = await api("/api/morse/lessons");
  $("#morseLessons").innerHTML = payload.lessons
    .map(
      (lesson) => `
      <div class="lesson-item">
        <strong>${lesson.title}</strong>
        <p>${lesson.group} · 目标 ${lesson.targetWpm} WPM</p>
        <button class="ghost-button" data-drill="${lesson.drills[0]}">载入 ${lesson.drills[0]}</button>
      </div>
    `,
    )
    .join("");
  $all("[data-drill]").forEach((button) => {
    button.addEventListener("click", () => {
      $("#morseInput").value = button.dataset.drill;
      $("#morseDisplay").textContent = button.dataset.drill;
    });
  });
}

function scheduleTone(context, start, duration, frequency = 660) {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.16, start + 0.01);
  gain.gain.setValueAtTime(0.16, start + duration - 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(context.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function playMorse() {
  const text = $("#morseInput").value.toUpperCase();
  $("#morseDisplay").textContent = text || "CQ";
  const wpm = Number($("#wpmInput").value);
  const unit = 1.2 / wpm;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  state.audioContext ||= new AudioContext();
  const context = state.audioContext;
  let time = context.currentTime + 0.08;

  for (const char of text) {
    if (char === " ") {
      time += unit * 7;
      continue;
    }
    const code = MORSE[char];
    if (!code) continue;
    for (const symbol of code) {
      const duration = symbol === "." ? unit : unit * 3;
      scheduleTone(context, time, duration);
      time += duration + unit;
    }
    time += unit * 2;
  }
}

async function loadRepeaters() {
  const query = encodeURIComponent($("#repeaterSearch").value || "");
  const payload = await api(`/api/repeaters?q=${query}`);
  $("#repeaterList").innerHTML = payload.repeaters
    .map(
      (repeater) => `
      <div class="repeater-item">
        <div>
          <strong>${escapeHTML(repeater.name)}</strong>
          <p>${escapeHTML(repeater.province)} ${escapeHTML(repeater.city)} · ${escapeHTML(repeater.notes)}</p>
        </div>
        <dl>
          <dt>下行</dt><dd>${Number(repeater.downlinkMHz).toFixed(3)}</dd>
          <dt>上行</dt><dd>${Number(repeater.uplinkMHz).toFixed(3)}</dd>
          <dt>频差</dt><dd>${escapeHTML(repeater.offsetMHz)}</dd>
          <dt>亚音</dt><dd>${escapeHTML(repeater.tone)}</dd>
        </dl>
      </div>
    `,
    )
    .join("");
}

async function saveRepeater(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  await api("/api/repeaters", {
    method: "POST",
    body: JSON.stringify(data),
  });
  event.currentTarget.reset();
  await loadRepeaters();
}

async function demoLogin() {
  const displayName = $("#displayNameInput").value.trim() || "无线电学习者";
  const payload = await api("/api/auth/demo", {
    method: "POST",
    body: JSON.stringify({ displayName }),
  });
  saveUser(payload.user);
  $("#accountStatus").textContent = JSON.stringify(payload, null, 2);
  renderDashboard().catch(console.error);
}

async function checkAppleConfig() {
  const payload = await api("/api/auth/apple/config");
  $("#accountStatus").textContent = JSON.stringify(payload, null, 2);
}

async function exportProgress() {
  const [progress, mistakes] = await Promise.all([
    api(`/api/users/${encodeURIComponent(state.user.id)}/progress`),
    api(`/api/users/${encodeURIComponent(state.user.id)}/mistakes`),
  ]);
  $("#accountStatus").textContent = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      user: state.user,
      progress,
      mistakes: mistakes.questions.map((question) => question.id),
    },
    null,
    2,
  );
}

async function resetProgress() {
  if (!confirm("确认清空当前用户的刷题记录和错题统计？")) return;
  const payload = await api(`/api/users/${encodeURIComponent(state.user.id)}/progress/reset`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  $("#accountStatus").textContent = JSON.stringify(payload, null, 2);
  await renderDashboard();
  if (state.view === "analysis") await loadStats();
}

async function init() {
  $("#levelSelect").value = state.level;
  $("#sidebarUser").textContent = state.user.displayName || state.user.id;

  $all(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $all("[data-jump]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.jump)));
  $("#levelSelect").addEventListener("change", (event) => setLevel(event.target.value));
  $("#newSessionButton").addEventListener("click", loadPractice);
  $("#topicSelect").addEventListener("change", loadPractice);
  $("#loadMistakesButton").addEventListener("click", loadMistakes);
  $("#loadReviewButton").addEventListener("click", loadReview);
  $("#refreshStatsButton").addEventListener("click", loadStats);
  $("#playMorseButton").addEventListener("click", playMorse);
  $("#morseInput").addEventListener("input", (event) => {
    $("#morseDisplay").textContent = event.target.value || "CQ";
  });
  $("#repeaterSearch").addEventListener("input", () => loadRepeaters().catch(console.error));
  $("#repeaterForm").addEventListener("submit", (event) => saveRepeater(event).catch(console.error));
  $("#demoLoginButton").addEventListener("click", demoLogin);
  $("#appleConfigButton").addEventListener("click", checkAppleConfig);
  $("#exportProgressButton").addEventListener("click", exportProgress);
  $("#resetProgressButton").addEventListener("click", resetProgress);

  state.banks = await api("/api/banks");
  renderBanks();
  await renderDashboard();
  await loadPractice();
}

init().catch((error) => {
  document.body.innerHTML = `<main class="app-shell"><div class="empty">启动失败：${error.message}</div></main>`;
});
