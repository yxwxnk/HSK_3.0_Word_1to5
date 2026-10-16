"use strict";
/* 汉语单词本 오프라인판 — 서버 없이 기기 안에서만 동작한다.
   단어 데이터: data/words.json (HSK 1–5급, 읽기 전용)
   복습 기록·설정: 이 기기의 IndexedDB. 다른 기기와 동기화되지 않는다. */

/* ---------------------------------------------------------------- 유틸 */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dayKey = (d) => { const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };

const SEP = /[\s'’\u2010-\u2015-]/g;
const normPy = (s) => s.normalize("NFKC").toLowerCase().replace(/ɡ/g, "g").replace(/u:/g, "u").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/v/g, "u").replace(SEP, "");
const normKo = (s) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const normZh = (s) => s.normalize("NFKC").replace(/\s+/g, "");
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/, HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const queryKind = (q) => (CJK.test(q) ? "chinese" : HANGUL.test(q) ? "korean" : "latin");

/* ---------------------------------------------------------------- 저장소 (IndexedDB, 실패하면 메모리) */
const DEFAULTS = { levels: [1], perDay: 20, direction: "alternate", retention: 0.9 };
let idb = null, persistent = true;
const mem = { cards: new Map(), log: [], kv: new Map() };

function openDb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("hanyu-wordbook", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("cards", { keyPath: "key" });
        db.createObjectStore("log", { autoIncrement: true });
        db.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
const tx = (store, mode, fn) => new Promise((resolve, reject) => {
  const t = idb.transaction(store, mode), s = t.objectStore(store);
  const r = fn(s);
  t.oncomplete = () => resolve(r && r.result);
  t.onerror = t.onabort = () => reject(t.error);
});

async function loadAll() {
  idb = await openDb();
  if (!idb) { persistent = false; return; }
  try {
    const [cards, log, settings] = await Promise.all([
      tx("cards", "readonly", (s) => s.getAll()),
      tx("log", "readonly", (s) => s.getAll()),
      tx("kv", "readonly", (s) => s.get("settings")),
    ]);
    cards.forEach((c) => mem.cards.set(c.key, c));
    mem.log = log;
    if (settings) mem.kv.set("settings", settings);
  } catch { persistent = false; }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* 무시 */ }
}
async function saveCard(c) { mem.cards.set(c.key, c); if (idb && persistent) try { await tx("cards", "readwrite", (s) => s.put(c)); } catch { persistent = false; } }
async function saveLog(l) { mem.log.push(l); if (idb && persistent) try { await tx("log", "readwrite", (s) => s.add(l)); } catch { persistent = false; } }
async function saveSettings(v) { mem.kv.set("settings", v); if (idb && persistent) try { await tx("kv", "readwrite", (s) => s.put(v, "settings")); } catch { persistent = false; } }
const settings = () => ({ ...DEFAULTS, ...(mem.kv.get("settings") || {}) });

/* ---------------------------------------------------------------- 데이터 */
let WORDS = [];
const byRef = new Map();

/* ---------------------------------------------------------------- 단어 카드 표시 */
function tilesHtml(w) {
  return w.c.map(([s, t, j, hun, eum]) => {
    const shown = new Set([s, t].filter(Boolean));
    const hj = j && !shown.has(j) ? j : "";
    const he = [hun, eum].filter(Boolean).join(" · ");
    return '<div class="tile"><span class="a" lang="zh-Hans">' + esc(s) + "</span>" +
      (t ? '<span class="b" lang="zh-Hant">' + esc(t) + "</span>" : "") +
      '<div class="c">' + (hj ? esc(hj) + " " : "") + esc(he || "—") + "</div></div>";
  }).join("");
}
function mark(text, needle) {
  const t = esc(text); if (!needle) return t;
  const n = esc(needle), i = t.toLowerCase().indexOf(n.toLowerCase());
  return i < 0 ? t : t.slice(0, i) + "<mark>" + t.slice(i, i + n.length) + "</mark>" + t.slice(i + n.length);
}
function markPinyin(py, q) {
  const p = normPy(q); if (!p) return esc(py);
  const chars = [...py]; let flat = ""; const map = [];
  chars.forEach((ch, i) => { for (const x of normPy(ch)) { flat += x; map.push(i); } });
  const at = flat.indexOf(p); if (at < 0) return esc(py);
  const s = map[at], e = map[at + p.length - 1];
  return esc(chars.slice(0, s).join("")) + "<mark>" + esc(chars.slice(s, e + 1).join("")) + "</mark>" + esc(chars.slice(e + 1).join(""));
}
function wordCard(w, q, kind) {
  return '<article class="card"><div class="head"><span class="hz" lang="zh-Hans">' +
    (kind === "chinese" ? mark(w.s, normZh(q)) : esc(w.s)) + "</span>" +
    (w.t ? '<span class="tr" lang="zh-Hant">' + esc(w.t) + "</span>" : "") + "</div>" +
    '<p class="py">' + (kind === "latin" ? markPinyin(w.p, q) : esc(w.p)) + "</p>" +
    '<div class="lab">뜻</div><p class="mean">' + (kind === "korean" ? mark(w.m, q.trim()) : esc(w.m)) + "</p>" +
    '<div class="tags">' + (w.pos ? '<span class="tag">' + esc(w.pos) + "</span>" : "") + '<span class="tag hsk">HSK ' + w.h + "</span></div>" +
    (w.c.length ? '<div class="lab">글자별 풀이</div><div class="tiles">' + tilesHtml(w) + "</div>" : "") + "</article>";
}

/* ---------------------------------------------------------------- 단어장 */
const dict = { q: "", level: 0, shown: 20 };
function searchWords(raw, level) {
  const q = raw.trim();
  let pool = level ? WORDS.filter((w) => w.h === level) : WORDS;
  if (!q) return { items: pool, kind: null };
  const kind = queryKind(q); let test, rank;
  if (kind === "chinese") {
    const z = normZh(q);
    test = (w) => w.s.includes(z) || w.t.includes(z);
    rank = (w) => (w.s === z || w.t === z ? 0 : w.s.startsWith(z) || w.t.startsWith(z) ? 1 : 2);
  } else if (kind === "korean") {
    const z = normKo(q);
    test = (w) => w.mn.includes(z);
    rank = (w) => (w.mn === z ? 0 : w.mn.startsWith(z) ? 1 : 2);
  } else {
    const p = normPy(q), z = normKo(q);
    test = (w) => (p && w.pn.includes(p)) || w.mn.includes(z);
    rank = (w) => (w.pn === p ? 0 : w.pn.startsWith(p) ? 1 : 2);
  }
  const items = pool.filter(test).map((w) => [rank(w), w])
    .sort((a, b) => a[0] - b[0] || a[1].s.length - b[1].s.length || a[1].h - b[1].h || a[1].pn.localeCompare(b[1].pn) || a[1].r.localeCompare(b[1].r))
    .map((x) => x[1]);
  return { items, kind };
}
function viewDict() {
  const v = $("#view");
  v.innerHTML = '<h1>단어장</h1><div class="bar"><div class="qwrap"><input id="q" type="search" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="간체, 병음, 한국어 뜻  예: 做梦, zuomeng, 꿈" aria-label="단어 검색">' +
    '<button type="button" class="qclear" id="qclear" aria-label="검색어 지우기" hidden><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9"/></svg></button></div>' +
    '<div class="chips" id="lv"></div></div><div class="count" id="count" aria-live="polite"></div><div id="list"></div><div class="btns"><button class="btn sec" id="more" hidden>더 보기</button></div>';
  const q = $("#q"); q.value = dict.q;
  const lv = $("#lv");
  [[0, "전체"], [1, "1급"], [2, "2급"], [3, "3급"], [4, "4급"], [5, "5급"]].forEach(([n, label]) => {
    const b = document.createElement("button"); b.className = "chip"; b.type = "button"; b.textContent = label;
    b.setAttribute("aria-pressed", String(dict.level === n));
    b.onclick = () => { dict.level = n; dict.shown = 20; [...lv.children].forEach((c, i) => c.setAttribute("aria-pressed", String(i === n))); renderDict(); };
    lv.append(b);
  });
  let timer;
  const clr = $("#qclear");
  const syncClear = () => { clr.hidden = q.value === ""; };
  syncClear();
  q.addEventListener("input", () => { syncClear(); clearTimeout(timer); timer = setTimeout(() => { dict.q = q.value; dict.shown = 20; renderDict(); }, 120); });
  // 지우기: 입력칸을 비우고 바로 결과를 갱신한 뒤, 키보드가 계속 열려 있도록 입력칸에 포커스를 돌려준다.
  clr.addEventListener("click", () => { clearTimeout(timer); q.value = ""; dict.q = ""; dict.shown = 20; syncClear(); renderDict(); q.focus(); });
  $("#more").onclick = () => { dict.shown += 20; renderDict(); };
  renderDict();
}
function renderDict() {
  const r = searchWords(dict.q, dict.level);
  const q = dict.q.trim();
  $("#count").textContent = q ? "‘" + q + "’ 검색 결과 " + r.items.length.toLocaleString() + "개" : "단어 " + r.items.length.toLocaleString() + "개";
  $("#list").innerHTML = r.items.length ? r.items.slice(0, dict.shown).map((w) => wordCard(w, q, r.kind)).join("")
    : '<div class="empty">검색 결과가 없습니다. 철자를 줄이거나 다른 표기로 입력해 보세요.</div>';
  const more = $("#more"); more.hidden = r.items.length <= dict.shown;
  more.textContent = "더 보기 (" + Math.min(20, r.items.length - dict.shown) + "개)";
}

/* ---------------------------------------------------------------- 복습 (FSRS) */
const rev = { phase: "prompt", cur: null, skipped: new Set(), lastType: null };
const fsrsCache = {};
function scheduler() {
  const r = settings().retention;
  return fsrsCache[r] || (fsrsCache[r] = FSRS.fsrs(FSRS.generatorParameters({ request_retention: r, enable_fuzz: false })));
}
function toLib(c) {
  return { due: new Date(c.due), stability: c.stability, difficulty: c.difficulty, elapsed_days: 0, scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps, reps: c.reps, lapses: c.lapses, state: c.state, last_review: c.last_review ? new Date(c.last_review) : undefined };
}
function fromLib(key, ref, type, lib, created) {
  return { key, ref, type, due: lib.due.toISOString(), stability: lib.stability, difficulty: lib.difficulty, scheduled_days: lib.scheduled_days,
    learning_steps: lib.learning_steps, reps: lib.reps, lapses: lib.lapses, state: lib.state,
    last_review: lib.last_review ? lib.last_review.toISOString() : null, created };
}
function counts() {
  const now = Date.now(), s = settings(), today = dayKey(new Date());
  let due = 0, newToday = 0;
  for (const c of mem.cards.values()) {
    if (c.created && dayKey(new Date(c.created)) === today) newToday++;
    if (new Date(c.due).getTime() <= now) due++;
  }
  const doneToday = mem.log.filter((l) => dayKey(new Date(l.ts)) === today).length;
  return { due, newAvailable: Math.max(0, s.perDay - newToday), newToday, doneToday };
}
/* 다음 카드: 복습 시각이 지난 카드 → 새 카드(하루 한도 안). 같은 날 이미 푼 단어의 반대 방향은 정답이 노출되므로 미룬다. */
function pickNext() {
  const now = Date.now(), s = settings(), today = dayKey(new Date());
  const dueCards = [...mem.cards.values()].filter((c) => new Date(c.due).getTime() <= now && !rev.skipped.has(c.key))
    .sort((a, b) => new Date(a.due) - new Date(b.due));
  if (dueCards.length) { const c = dueCards[0]; return { word: byRef.get(c.ref), type: c.type, isNew: false, card: c }; }
  if (counts().newAvailable <= 0) return null;
  const types = s.direction === "zh_ko" ? ["zh_ko"] : s.direction === "ko_zh" ? ["ko_zh"]
    : rev.lastType === "zh_ko" ? ["ko_zh", "zh_ko"] : ["zh_ko", "ko_zh"];
  const todayWord = (ref) => ["zh_ko", "ko_zh"].some((t) => { const c = mem.cards.get(ref + ":" + t); return c && c.last_review && dayKey(new Date(c.last_review)) === today; });
  for (const w of WORDS) {
    if (!s.levels.includes(w.h)) continue;
    for (const t of types) {
      const key = w.r + ":" + t;
      if (mem.cards.has(key) || rev.skipped.has(key)) continue;
      if (todayWord(w.r)) continue;
      return { word: w, type: t, isNew: true, card: null };
    }
  }
  return null;
}
function viewReview() {
  const v = $("#view");
  v.innerHTML = '<h1>복습</h1><div class="counts" aria-label="복습 현황"></div><div id="area"></div>';
  nextCard();
}
function nextCard() {
  rev.cur = pickNext(); rev.phase = "prompt";
  if (rev.cur) rev.lastType = rev.cur.type;
  drawReview();
}
function drawReview() {
  const c = counts();
  $(".counts").innerHTML = "<span>복습할 카드 <b>" + c.due + "</b></span><span>오늘 새 카드 가능 <b>" + c.newAvailable + "</b></span><span>오늘 완료 <b>" + c.doneToday + "</b></span>";
  const a = $("#area");
  if (!rev.cur) {
    a.innerHTML = '<div class="empty">지금 복습할 카드가 없습니다.<div class="small">오늘 새 카드 한도를 모두 썼거나 복습 시각이 아직 되지 않았습니다. 통계·설정에서 하루 새 카드 수와 학습할 급수를 바꿀 수 있습니다.</div>' +
      (rev.skipped.size ? '<div class="btns" style="margin-top:12px"><button class="btn sec" id="unskip">건너뛴 카드 다시 보기</button></div>' : "") + "</div>";
    const u = $("#unskip"); if (u) u.onclick = () => { rev.skipped.clear(); nextCard(); };
    return;
  }
  const { word: w, type, isNew } = rev.cur, zk = type === "zh_ko";
  let h = '<div class="rv"><div class="q">' + (zk ? "이 단어의 한국어 뜻은?" : "이 뜻에 해당하는 중국어는?") + (isNew ? " · 새 카드" : "") + "</div>" +
    '<div class="prompt' + (zk ? "" : " ko") + '" lang="' + (zk ? "zh-Hans" : "ko") + '">' + esc(zk ? w.s : w.m) + "</div>";
  if (rev.phase === "prompt") {
    h += '<div class="btns"><button class="btn" id="reveal">정답 보기</button><button class="btn sec" id="skip">건너뛰기</button></div>';
  } else {
    h += wordCard(w, "", null) + '<div class="ratings" role="group" aria-label="얼마나 잘 기억했나요?">' +
      [[1, "다시"], [2, "어려움"], [3, "알맞음"], [4, "쉬움"]].map(([n, l]) => '<button class="rate r' + n + '" data-r="' + n + '">' + l + "<small>" + nextLabel(n) + "</small></button>").join("") +
      '</div><div class="btns" style="margin-top:12px"><button class="btn sec sm" id="skip">평가하지 않고 건너뛰기</button></div>';
  }
  a.innerHTML = h + "</div>";
  const r = $("#reveal"); if (r) r.onclick = () => { rev.phase = "revealed"; drawReview(); };
  const sk = $("#skip"); if (sk) sk.onclick = () => { rev.skipped.add(w.r + ":" + type); nextCard(); };
  a.querySelectorAll(".rate").forEach((b) => (b.onclick = () => rate(Number(b.dataset.r))));
}
function previewCard() {
  const { word, type, card } = rev.cur, now = new Date();
  return toLib(card || { ...fromLib(word.r + ":" + type, word.r, type, FSRS.createEmptyCard(now), now.toISOString()) });
}
function nextLabel(n) {
  try {
    const rec = scheduler().next(previewCard(), new Date(), n).card;
    const mins = (rec.due - new Date()) / 60000;
    return mins < 60 ? Math.max(1, Math.round(mins)) + "분 뒤" : mins < 1440 ? Math.round(mins / 60) + "시간 뒤" : Math.round(mins / 1440) + "일 뒤";
  } catch { return ""; }
}
let rating = false;
async function rate(n) {
  if (rating || !rev.cur || rev.phase !== "revealed") return;
  rating = true;
  try {
    const { word, type, card } = rev.cur, now = new Date();
    const key = word.r + ":" + type;
    const res = scheduler().next(previewCard(), now, n);
    const saved = fromLib(key, word.r, type, res.card, card ? card.created : now.toISOString());
    await saveCard(saved);
    await saveLog({ ts: now.toISOString(), key, rating: n, state_before: card ? card.state : 0 });
  } finally { rating = false; }
  nextCard();
}
document.addEventListener("keydown", (e) => {
  if (currentTab !== "review" || !rev.cur) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes((e.target || {}).tagName)) return;
  if (rev.phase === "prompt" && (e.key === " " || e.key === "Enter")) { e.preventDefault(); rev.phase = "revealed"; drawReview(); }
  else if (rev.phase === "revealed" && e.key.length === 1 && "1234".includes(e.key)) rate(Number(e.key));
});

/* ---------------------------------------------------------------- 통계·설정 */
function viewStats() {
  const s = settings(), c = counts(), v = $("#view");
  const total = mem.cards.size, learned = [...mem.cards.values()].filter((x) => x.state === 2).length;
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(dayKey(d)); }
  const perDay = Object.fromEntries(days.map((d) => [d, 0]));
  mem.log.forEach((l) => { const k = dayKey(new Date(l.ts)); if (k in perDay) perDay[k]++; });
  const max = Math.max(1, ...Object.values(perDay));
  const again = mem.log.filter((l) => l.rating === 1).length;
  const acc = mem.log.length ? Math.round(100 * (1 - again / mem.log.length)) : null;
  v.innerHTML = "<h1>통계·설정</h1>" +
    (persistent ? "" : '<div class="warn">이 브라우저에서는 기록을 저장할 수 없어 앱을 닫으면 사라집니다. 사파리에서 열었다면 홈 화면에 추가한 앱으로 실행해 보세요.</div>') +
    '<div class="stats"><div class="stat"><b>' + c.doneToday + '</b>오늘 복습</div><div class="stat"><b>' + total + '</b>시작한 카드</div>' +
    '<div class="stat"><b>' + learned + '</b>장기 기억 단계</div><div class="stat"><b>' + (acc === null ? "—" : acc + "%") + '</b>다시 아님 비율</div></div>' +
    '<h2>최근 14일 복습 수</h2><div class="bars" role="img" aria-label="최근 14일 복습 수">' + days.map((d) => '<div title="' + d + ": " + perDay[d] + '회" style="height:' + Math.max(2, Math.round(100 * perDay[d] / max)) + '%"></div>').join("") + "</div>" +
    '<h2>학습 설정</h2>' +
    '<div class="row"><label for="s-perday">하루 새 카드 수</label><input id="s-perday" type="number" min="0" max="200" value="' + s.perDay + '"></div>' +
    '<div class="row"><label for="s-dir">카드 방향</label><select id="s-dir"><option value="alternate">번갈아</option><option value="zh_ko">중국어 → 한국어만</option><option value="ko_zh">한국어 → 중국어만</option></select></div>' +
    '<div class="row"><label for="s-ret">목표 기억률</label><select id="s-ret">' + [0.8, 0.85, 0.9, 0.95].map((r) => '<option value="' + r + '">' + Math.round(r * 100) + "%</option>").join("") + "</select></div>" +
    '<div class="row"><span>새 카드로 학습할 급수</span><span class="chips" id="s-levels"></span></div>' +
    '<div class="msg muted" id="s-msg"></div>' +
    '<h2>백업</h2><p class="small muted">복습 기록은 이 기기에만 저장됩니다. 기기를 바꾸거나 사파리 데이터를 지우기 전에 내보내기로 파일을 보관하세요.</p>' +
    '<div class="btns" style="justify-content:flex-start"><button class="btn sec" id="export">기록 내보내기</button><label class="btn sec" for="import" style="cursor:pointer">기록 가져오기</label><input id="import" type="file" accept="application/json,.json" hidden></div>' +
    '<div class="msg" id="b-msg" role="status"></div>' +
    '<p class="small muted" style="margin-top:22px">단어 데이터: HSK 3.0 1–5급 ' + WORDS.length.toLocaleString() + "개 (ivankra/hsk30, 중국 교육부 2021 문서를 옮긴 자료). 한국어 뜻과 훈음은 직접 제공한 데이터이며 외부 사전과 대조하지 않았습니다. 스케줄러: FSRS (ts-fsrs).</p>";
  $("#s-dir").value = s.direction; $("#s-ret").value = String(s.retention);
  const save = async () => {
    const levels = [...document.querySelectorAll("#s-levels .chip")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => Number(b.dataset.l));
    const perDayV = Math.max(0, Math.min(200, parseInt($("#s-perday").value, 10) || 0));
    await saveSettings({ levels: levels.length ? levels : [1], perDay: perDayV, direction: $("#s-dir").value, retention: Number($("#s-ret").value) });
    $("#s-msg").textContent = "저장했습니다.";
  };
  [1, 2, 3, 4, 5].forEach((n) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.dataset.l = n; b.textContent = n + "급";
    b.setAttribute("aria-pressed", String(s.levels.includes(n)));
    b.onclick = () => { b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")); save(); };
    $("#s-levels").append(b);
  });
  ["#s-perday", "#s-dir", "#s-ret"].forEach((id) => $(id).addEventListener("change", save));
  $("#export").onclick = exportData;
  $("#import").onchange = importData;
}
function exportData() {
  const data = { app: "hanyu-offline", version: 1, exported_at: new Date().toISOString(), settings: settings(), cards: [...mem.cards.values()], log: mem.log };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "hanyu-backup-" + dayKey(new Date()) + ".json";
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $("#b-msg").textContent = "백업 파일을 만들었습니다. 파일 앱이나 다운로드 목록에서 확인하세요. (" + mem.cards.size + "개 카드, " + mem.log.length + "건 기록)";
}
async function importData(e) {
  const f = e.target.files[0]; if (!f) return;
  const msg = $("#b-msg");
  try {
    const d = JSON.parse(await f.text());
    if (d.app !== "hanyu-offline" || !Array.isArray(d.cards) || !Array.isArray(d.log)) throw new Error("이 앱의 백업 파일이 아닙니다.");
    const known = d.cards.filter((c) => c && typeof c.key === "string" && byRef.has(c.ref) && typeof c.due === "string");
    let added = 0, newer = 0;
    for (const c of known) {
      const have = mem.cards.get(c.key);
      if (!have || (c.last_review || "") > (have.last_review || "")) { await saveCard(c); have ? newer++ : added++; }
    }
    const seen = new Set(mem.log.map((l) => l.ts + l.key));
    let logs = 0;
    for (const l of d.log) if (l && l.ts && l.key && !seen.has(l.ts + l.key)) { await saveLog(l); logs++; }
    if (d.settings) await saveSettings({ ...DEFAULTS, ...d.settings });
    msg.textContent = "가져왔습니다. 새 카드 " + added + "개, 더 최근 기록으로 갱신 " + newer + "개, 복습 기록 " + logs + "건.";
    setTimeout(() => show("stats"), 1200);
  } catch (err) {
    msg.textContent = "가져오지 못했습니다: " + (err && err.message ? err.message : "파일을 읽을 수 없습니다.");
  }
  e.target.value = "";
}

/* ---------------------------------------------------------------- 탭 */
let currentTab = "dict";
function show(tab) {
  currentTab = tab;
  document.querySelectorAll("nav button").forEach((b) => (b.dataset.tab === tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  window.scrollTo(0, 0);
  ({ dict: viewDict, review: viewReview, stats: viewStats })[tab]();
  try { localStorage.setItem("hanyu-tab", tab); } catch { /* 무시 */ }
}
document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => show(b.dataset.tab)));

(async function start() {
  try {
    const res = await fetch("data/words.json");
    WORDS = await res.json();
  } catch {
    $("#view").innerHTML = '<div class="empty">단어 데이터를 불러오지 못했습니다. 인터넷에 연결한 상태에서 한 번 열어 주세요.</div>';
    return;
  }
  WORDS.forEach((w) => byRef.set(w.r, w));
  await loadAll();
  let tab = "dict"; try { tab = localStorage.getItem("hanyu-tab") || "dict"; } catch { /* 무시 */ }
  show(["dict", "review", "stats"].includes(tab) ? tab : "dict");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
