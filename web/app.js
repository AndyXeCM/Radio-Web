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
};

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
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
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
