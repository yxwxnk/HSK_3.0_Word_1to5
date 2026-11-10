"use strict";
/* 汉语单词本 오프라인판 — 서버 없이 기기 안에서만 동작한다.
   단어 데이터: data/words.json (HSK 3.0 어휘 대강 1–5급 3,600개, 읽기 전용)
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
const DEFAULTS = { levels: [1], perDay: 20, direction: "alternate", scope: "levels", hanziFont: "song", bodyFont: "gothic", size: "normal", iv: [1, 3, 14] }; // scope: levels=선택한 급수 전체, selected=내가 고른 단어만
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
    // kv 저장소의 모든 항목(설정·예문·고른 단어·데이터 버전·보관 기록·안내)을 빠짐없이 읽는다.
    // (dataVersion을 읽지 않으면 실행할 때마다 '예전 기록 이전'이 다시 돌아 기록이 뒤섞이므로 반드시 포함해야 한다.)
    const KV_KEYS = ["settings", "examples", "selected", "dataVersion", "legacy", "notice"];
    const [cards, log, ...kvs] = await Promise.all([
      tx("cards", "readonly", (s) => s.getAll()),
      tx("log", "readonly", (s) => s.getAll()),
      ...KV_KEYS.map((k) => tx("kv", "readonly", (s) => s.get(k))),
    ]);
    cards.forEach((c) => mem.cards.set(c.key, c));
    mem.log = log;
    KV_KEYS.forEach((k, i) => { if (kvs[i] !== undefined) mem.kv.set(k, kvs[i]); });
  } catch { persistent = false; }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* 무시 */ }
}
async function saveCard(c) { mem.cards.set(c.key, c); if (idb && persistent) try { await tx("cards", "readwrite", (s) => s.put(c)); } catch { persistent = false; } }
async function deleteCard(key) { mem.cards.delete(key); if (idb && persistent) try { await tx("cards", "readwrite", (s) => s.delete(key)); } catch { persistent = false; } }
async function removeLog(ts) {
  const i = mem.log.map((l) => l.ts).lastIndexOf(ts); if (i >= 0) mem.log.splice(i, 1);
  if (!idb || !persistent) return;
  try { await new Promise((res, rej) => { const t = idb.transaction("log", "readwrite"), c = t.objectStore("log").openCursor(null, "prev");
    c.onsuccess = () => { const cur = c.result; if (!cur) return; if (cur.value.ts === ts) cur.delete(); else cur.continue(); };
    t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); }); } catch { persistent = false; }
}
async function saveLog(l) { mem.log.push(l); if (idb && persistent) try { await tx("log", "readwrite", (s) => s.add(l)); } catch { persistent = false; } }
async function saveSettings(v) { mem.kv.set("settings", v); if (idb && persistent) try { await tx("kv", "readwrite", (s) => s.put(v, "settings")); } catch { persistent = false; } }
const settings = () => ({ ...DEFAULTS, ...(mem.kv.get("settings") || {}) });

/* ---- 글꼴·글자 크기: 기기에 들어 있는 글꼴만 쓰므로 인터넷이 없어도 바뀐다. 없는 글꼴은 다음 후보로 자동 대체된다. ---- */
const HANZI_FONTS = {
  song: ["명조체 (宋体)", '"Songti SC","STSong","Noto Serif SC","Noto Serif CJK SC","Source Han Serif SC",serif'],
  hei: ["고딕체 (黑体)", '"PingFang SC","Heiti SC","Hiragino Sans GB","Noto Sans SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif'],
  kai: ["해서체 (楷体)", '"Kaiti SC","STKaiti","KaiTi","BiauKai","Noto Serif CJK SC",serif'],
  xing: ["행서 손글씨 (行楷)", '"Xingkai SC","STXingkai","Kaiti SC","STKaiti",serif'],
};
const BODY_FONTS = {
  gothic: ["고딕", '-apple-system,"Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif'],
  myeongjo: ["명조", '"AppleMyungjo","Nanum Myeongjo","Noto Serif KR",serif'],
};
const SIZES = { small: ["작게", 0.92], normal: ["보통", 1], large: ["크게", 1.12], xlarge: ["아주 크게", 1.25] };
function applyAppearance() {
  const s = settings(), root = document.documentElement.style;
  root.setProperty("--f-han", (HANZI_FONTS[s.hanziFont] || HANZI_FONTS.song)[1]);
  root.setProperty("--f-body", (BODY_FONTS[s.bodyFont] || BODY_FONTS.gothic)[1]);
  root.setProperty("--scale", String((SIZES[s.size] || SIZES.normal)[1]));
}

/* ---- 단어 목록이 2025 대강 기준으로 바뀌면서(데이터 버전 2) 예전 단어 번호(L1-0002 등)가 다른 단어를 가리키게 됐다.
   기기에 저장된 복습 기록·예문·선택을 (간체, 병음)이 같은 새 단어 번호로 옮기고, 새 목록에 없는 단어의 기록은 지우지 않고 legacy에 보관한다. ---- */
function remapPayload(p, refmap) {
  const out = { cards: new Map(), log: p.log || [], examples: {}, selected: {}, legacy: { cards: [], examples: {}, selected: {} } };
  for (const c of p.cards || []) {
    const nr = refmap[c.ref];
    if (!nr) { out.legacy.cards.push(c); continue; }
    const key = nr + ":" + c.type, have = out.cards.get(key), nc = { ...c, ref: nr, key };
    if (!have || (nc.last_review || "") > (have.last_review || "")) out.cards.set(key, nc);
  }
  for (const [ref, arr] of Object.entries(p.examples || {})) {
    const nr = refmap[ref];
    if (!nr) { out.legacy.examples[ref] = arr; continue; }
    out.examples[nr] = (out.examples[nr] || []).concat(arr);
  }
  for (const ref of Object.keys(p.selected || {})) { const nr = refmap[ref]; if (nr) out.selected[nr] = true; else out.legacy.selected[ref] = true; }
  return out;
}
async function putKv(key, val) { mem.kv.set(key, val); if (idb && persistent) try { await tx("kv", "readwrite", (s) => s.put(val, key)); } catch { persistent = false; } }
async function migrateIfNeeded() {
  if ((mem.kv.get("dataVersion") || 1) >= 2) return;
  const had = mem.cards.size || Object.keys(allExamples()).length || selectedCount();
  if (had) {
    let refmap = {};
    try { refmap = await (await fetch("data/refmap.json")).json(); } catch { return; } // 대응표를 못 받으면 다음 실행에서 다시 시도
    const r = remapPayload({ cards: [...mem.cards.values()], examples: allExamples(), selected: selectedMap() }, refmap);
    mem.cards.clear(); r.cards.forEach((c, k) => mem.cards.set(k, c));
    if (idb && persistent) try { await tx("cards", "readwrite", (s) => { s.clear(); r.cards.forEach((c) => s.put(c)); }); } catch { persistent = false; }
    await putKv("examples", r.examples); await putKv("selected", r.selected);
    const lg = r.legacy, nLegacy = lg.cards.length + Object.values(lg.examples).reduce((n, a) => n + a.length, 0) + Object.keys(lg.selected).length;
    if (nLegacy) {
      const prev = mem.kv.get("legacy") || { cards: [], examples: {}, selected: {} };
      await putKv("legacy", { cards: prev.cards.concat(lg.cards), examples: { ...prev.examples, ...lg.examples }, selected: { ...prev.selected, ...lg.selected } });
    }
    await putKv("notice", "단어 목록이 2025 대강 기준으로 바뀌어 기존 기록 " + (r.cards.size + Object.keys(r.examples).length + Object.keys(r.selected).length) + "건을 새 목록으로 옮겼습니다." + (nLegacy ? " 새 목록에 없는 단어의 기록 " + nLegacy + "건은 지우지 않고 따로 보관했습니다(백업 파일에 포함)." : ""));
  }
  await putKv("dataVersion", 2);
}

/* 내가 직접 넣은 예문: { 단어ref: [{ id, zh, ko, updated }] } — 설정과 같은 저장소(kv)에 한 덩어리로 저장한다. */
const allExamples = () => mem.kv.get("examples") || {};
const examplesOf = (ref) => allExamples()[ref] || [];
async function saveExamples(v) { mem.kv.set("examples", v); if (idb && persistent) try { await tx("kv", "readwrite", (s) => s.put(v, "examples")); } catch { persistent = false; } }
/* 복습 대상으로 고른 단어: { 단어ref: true } */
const selectedMap = () => mem.kv.get("selected") || {};
const isSel = (ref) => !!selectedMap()[ref];
const selectedCount = () => Object.keys(selectedMap()).length;
async function saveSelected(v) { mem.kv.set("selected", v); if (idb && persistent) try { await tx("kv", "readwrite", (s) => s.put(v, "selected")); } catch { persistent = false; } }
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const exState = { ref: null, id: null, delId: null }; // 열려 있는 입력 폼(id=null이면 새 예문), 삭제 확인 중인 예문
function rerender() { if (currentTab === "dict") renderDict(); else if (currentTab === "review") drawReview(); }

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
/* 동형어 번호(本¹ 本²)는 작은 윗첨자로 */
const supHtml = (w) => (w.v ? '<sup class="hv">' + esc(w.v) + "</sup>" : "");
function wordCard(w, q, kind) {
  const on = isSel(w.r);
  return '<article class="card"><div class="head"><span class="hz" lang="zh-Hans">' +
    (kind === "chinese" ? mark(w.s, normZh(q)) : esc(w.s)) + supHtml(w) + "</span>" +
    (w.t ? '<span class="tr" lang="zh-Hant">' + esc(w.t) + "</span>" : "") +
    '<button type="button" class="star" data-ref="' + esc(w.r) + '" aria-pressed="' + on + '" aria-label="복습 대상으로 선택">' + (on ? "★" : "☆") + '<span>' + (on ? "복습 대상" : "복습에 추가") + "</span></button></div>" +
    '<p class="py">' + (kind === "latin" ? markPinyin(w.p, q) : esc(w.p)) + "</p>" +
    '<div class="lab">뜻</div><p class="mean">' + (kind === "korean" ? mark(w.m, q.trim()) : esc(w.m)) + "</p>" +
    '<div class="tags">' + (w.pos ? '<span class="tag">' + esc(w.pos) + "</span>" : "") + '<span class="tag hsk">HSK ' + w.h + "</span>" + (isMastered(w.r) ? '<span class="tag">완벽히 외움</span>' : "") + (w.h2 ? '<span class="tag" title="일부 의미·용법이 이 급수에서 추가됩니다">' + esc(w.h2.replace("-", "–")) + "급 용법 추가</span>" : "") + "</div>" +
    examplesHtml(w.r) +
    (w.c.length ? '<div class="lab">글자별 풀이</div><div class="tiles">' + tilesHtml(w) + "</div>" : "") + "</article>";
}
function exForm(ref, e) {
  return '<form class="exform" data-ref="' + esc(ref) + '" data-id="' + esc(e ? e.id : "") + '">' +
    '<label>중국어 예문<textarea name="zh" rows="2" maxlength="300" lang="zh-Hans" required placeholder="例: 我昨天做了一个好梦。">' + esc(e ? e.zh : "") + "</textarea></label>" +
    '<label>한국어 번역 (선택)<input name="ko" maxlength="300" value="' + esc(e ? e.ko : "") + '" placeholder="예: 나는 어제 좋은 꿈을 꿨다."></label>' +
    '<div class="btns" style="justify-content:flex-start"><button type="submit" class="btn sm">저장</button><button type="button" class="btn sec sm ex-cancel">취소</button></div></form>';
}
function examplesHtml(ref) {
  const list = examplesOf(ref), open = exState.ref === ref;
  let h = '<div class="lab">내 예문</div>';
  h += list.map((e) => {
    if (open && exState.id === e.id) return exForm(ref, e);
    const del = exState.delId === e.id
      ? '<span class="small">삭제할까요?</span><button type="button" class="lk danger ex-del-yes" data-ref="' + esc(ref) + '" data-id="' + esc(e.id) + '">삭제</button><button type="button" class="lk ex-del-no">취소</button>'
      : '<button type="button" class="lk ex-edit" data-ref="' + esc(ref) + '" data-id="' + esc(e.id) + '">수정</button><button type="button" class="lk ex-del" data-ref="' + esc(ref) + '" data-id="' + esc(e.id) + '">삭제</button>';
    return '<div class="ex"><p class="mean" lang="zh-Hans">' + esc(e.zh) + "</p>" + (e.ko ? '<p class="small muted">' + esc(e.ko) + "</p>" : "") + '<div class="ex-act">' + del + "</div></div>";
  }).join("");
  if (open && exState.id === null) h += exForm(ref, null);
  else h += '<button type="button" class="btn sec sm ex-add" data-ref="' + esc(ref) + '">+ 예문 추가</button>';
  return h;
}
document.addEventListener("click", (ev) => {
  const b = ev.target.closest && ev.target.closest("button");
  if (!b) return;
  if (b.classList.contains("star")) {
    const all = { ...selectedMap() }; if (all[b.dataset.ref]) delete all[b.dataset.ref]; else all[b.dataset.ref] = true;
    saveSelected(all).then(rerender); return;
  }
  const ref = b.dataset.ref, id = b.dataset.id;
  if (b.classList.contains("ex-add")) { exState.ref = ref; exState.id = null; exState.delId = null; }
  else if (b.classList.contains("ex-edit")) { exState.ref = ref; exState.id = id; exState.delId = null; }
  else if (b.classList.contains("ex-cancel")) { exState.ref = null; exState.id = null; }
  else if (b.classList.contains("ex-del")) { exState.delId = id; }
  else if (b.classList.contains("ex-del-no")) { exState.delId = null; }
  else if (b.classList.contains("ex-del-yes")) {
    const all = { ...allExamples() }; all[ref] = examplesOf(ref).filter((e) => e.id !== id); if (!all[ref].length) delete all[ref];
    exState.delId = null; saveExamples(all).then(rerender); return;
  } else return;
  rerender();
  const f = document.querySelector(".exform textarea"); if (f) f.focus();
});
document.addEventListener("submit", (ev) => {
  const f = ev.target.closest && ev.target.closest(".exform");
  if (!f) return;
  ev.preventDefault();
  const zh = f.elements.zh.value.trim(), ko = f.elements.ko.value.trim();
  if (!zh) { f.elements.zh.focus(); return; }
  const ref = f.dataset.ref, id = f.dataset.id, all = { ...allExamples() }, list = [...examplesOf(ref)];
  if (id) { const i = list.findIndex((e) => e.id === id); if (i >= 0) list[i] = { ...list[i], zh, ko, updated: new Date().toISOString() }; }
  else list.push({ id: newId(), zh, ko, updated: new Date().toISOString() });
  all[ref] = list; exState.ref = null; exState.id = null;
  saveExamples(all).then(rerender);
});

/* ---------------------------------------------------------------- 단어장 */
const dict = { q: "", level: 0, shown: 20, onlySel: false };
function searchWords(raw, level) {
  const q = raw.trim();
  let pool = level ? WORDS.filter((w) => w.h === level) : WORDS;
  if (dict.onlySel) pool = pool.filter((w) => isSel(w.r));
  if (!q) return { items: pool, kind: null };
  const kind = queryKind(q); let test, rank;
  if (kind === "chinese") {
    const z = normZh(q);
    const ks = (w) => w.k.concat(w.kt);
    test = (w) => ks(w).some((x) => x.includes(z));
    rank = (w) => { const a = ks(w); return a.some((x) => x === z) ? 0 : a.some((x) => x.startsWith(z)) ? 1 : 2; };
  } else if (kind === "korean") {
    const z = normKo(q);
    test = (w) => w.mn.includes(z);
    rank = (w) => (w.mn === z ? 0 : w.mn.startsWith(z) ? 1 : 2);
  } else {
    const p = normPy(q), z = normKo(q);
    test = (w) => (p && w.pn.some((x) => x.includes(p))) || w.mn.includes(z);
    rank = (w) => (w.pn.some((x) => x === p) ? 0 : w.pn.some((x) => x.startsWith(p)) ? 1 : 2);
  }
  const items = pool.filter(test).map((w) => [rank(w), w])
    .sort((a, b) => a[0] - b[0] || a[1].s.length - b[1].s.length || a[1].h - b[1].h || a[1].pn[0].localeCompare(b[1].pn[0]) || a[1].r.localeCompare(b[1].r))
    .map((x) => x[1]);
  return { items, kind };
}
function viewDict() {
  const v = $("#view");
  v.innerHTML = '<h1>단어장</h1><div class="bar"><div class="qwrap"><input id="q" type="search" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="간체, 병음, 한국어 뜻  예: 做梦, zuomeng, 꿈" aria-label="단어 검색">' +
    '<button type="button" class="qclear" id="qclear" aria-label="검색어 지우기" hidden><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9"/></svg></button></div>' +
    '<div class="chips" id="lv"></div><div class="chips" id="selbar"></div></div><div class="count" id="count" aria-live="polite"></div><div id="list"></div><div class="btns"><button class="btn sec" id="more" hidden>더 보기</button></div>';
  const q = $("#q"); q.value = dict.q;
  const lv = $("#lv");
  $("#selbar").onclick = (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.id === "onlysel") { dict.onlySel = !dict.onlySel; dict.shown = 20; renderDict(); return; }
    const items = searchWords(dict.q, dict.level).items, all = { ...selectedMap() };
    if (b.id === "selall") items.forEach((w) => { all[w.r] = true; });
    else if (b.id === "selnone") items.forEach((w) => { delete all[w.r]; });
    saveSelected(all).then(renderDict);
  };
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
  if (!$("#count")) return; // 검색 지연 타이머가 끝나기 전에 다른 탭으로 이동한 경우
  const r = searchWords(dict.q, dict.level);
  const q = dict.q.trim();
  $("#count").textContent = q ? "‘" + q + "’ 검색 결과 " + r.items.length.toLocaleString() + "개" : "단어 " + r.items.length.toLocaleString() + "개";
  $("#list").innerHTML = r.items.length ? r.items.slice(0, dict.shown).map((w) => wordCard(w, q, r.kind)).join("")
    : '<div class="empty">검색 결과가 없습니다. 철자를 줄이거나 다른 표기로 입력해 보세요.</div>';
  $("#selbar").innerHTML = '<button type="button" class="chip" id="onlysel" aria-pressed="' + dict.onlySel + '">★ 복습 대상만 (' + selectedCount() + ')</button>' +
    (r.items.length ? '<button type="button" class="chip" id="selall">결과 ' + r.items.length.toLocaleString() + '개 모두 선택</button><button type="button" class="chip" id="selnone">결과 모두 해제</button>' : "");
  const more = $("#more"); more.hidden = r.items.length <= dict.shown;
  more.textContent = "더 보기 (" + Math.min(20, r.items.length - dict.shown) + "개)";
}

/* ---------------------------------------------------------------- 복습 (고정 간격) */
const rev = { phase: "prompt", cur: null, skipped: new Set(), lastType: null };
/* 평가 4가지. 간격은 '오늘 0시 + N일'로 정해, 그날 앱을 처음 여는 시각부터 다시 나온다.
   (어려움 1일 → 내일부터, 중간 3일 → 3일 뒤부터, 쉬움 14일 → 14일 뒤부터, 완벽히 외움 → 복습에서 제외) */
const IV_BASE = [1, 3, 14];
function ivDays() { const a = settings().iv || []; return [0, 1, 2].map((i) => { const v = Math.round(Number(a[i])); return v >= 1 && v <= 365 ? v : IV_BASE[i]; }); }
function ratings() {
  const d = ivDays();
  return [
    { n: 1, label: "어려움", sub: d[0] + "일 이내 다시", days: d[0] },
    { n: 2, label: "중간", sub: d[1] + "일 이내 다시", days: d[1] },
    { n: 3, label: "쉬움", sub: d[2] + "일 이내 다시", days: d[2] },
    { n: 4, label: "완벽히 외움", sub: "복습에서 제외", days: null },
  ];
}
function dueAfter(days) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days); return d.toISOString(); }
const isMastered = (ref) => ["zh_ko", "ko_zh"].some((t) => { const c = mem.cards.get(ref + ":" + t); return c && c.done; });
/* 복습 범위: 'selected'면 내가 고른 단어만, 아니면 설정한 급수 전체 */
const inScope = (ref) => (settings().scope === "selected" ? isSel(ref) : true);
function counts() {
  const now = Date.now(), s = settings(), today = dayKey(new Date());
  let due = 0, newToday = 0;
  for (const c of mem.cards.values()) {
    if (c.created && dayKey(new Date(c.created)) === today) newToday++;
    if (!c.done && new Date(c.due).getTime() <= now && inScope(c.ref)) due++;
  }
  const doneToday = mem.log.filter((l) => dayKey(new Date(l.ts)) === today).length;
  return { due, newAvailable: Math.max(0, s.perDay - newToday), newToday, doneToday };
}
/* 다음 카드: 복습할 카드(복습 시각이 지난 것)와 새 카드(하루 한도 안)를 완전히 무작위로 섞어 낸다.
   복습 카드와 새 카드 중 어느 쪽에서 뽑을지는 남은 장수에 비례해 정하고, 그 안에서는 균등한 무작위로 고른다.
   단어 순서(번호·병음)나 복습 시각 순서는 쓰지 않는다. 직전 카드가 바로 다시 나오지는 않는다.
   같은 날 이미 푼 단어의 반대 방향 카드는 정답이 노출되므로 새 카드로 뽑지 않는다. */
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
function pickNext() {
  const now = Date.now(), s = settings(), today = dayKey(new Date()), last = rev.lastKey;
  let dueCards = [...mem.cards.values()].filter((c) => !c.done && new Date(c.due).getTime() <= now && !rev.skipped.has(c.key) && inScope(c.ref) && byRef.has(c.ref));
  if (dueCards.length > 1) dueCards = dueCards.filter((c) => c.key !== last);
  let newCands = [];
  if (counts().newAvailable > 0) {
    const allowed = s.direction === "zh_ko" ? ["zh_ko"] : s.direction === "ko_zh" || s.direction === "ko_zh_pbt" ? ["ko_zh"] : ["zh_ko", "ko_zh"];
    const todayWord = (ref) => ["zh_ko", "ko_zh"].some((t) => { const c = mem.cards.get(ref + ":" + t); return c && c.last_review && dayKey(new Date(c.last_review)) === today; });
    const collect = (types) => {
      const out = [];
      for (const w of WORDS) {
        if (s.scope === "selected" ? !isSel(w.r) : !s.levels.includes(w.h)) continue;
        if (todayWord(w.r)) continue;
        for (const t of types) { const key = w.r + ":" + t; if (!mem.cards.has(key) && !rev.skipped.has(key) && key !== last) out.push({ word: w, type: t, key }); }
      }
      return out;
    };
    // '번갈아'는 직전과 반대 방향 새 카드를 우선하고, 후보가 없으면 두 방향 모두에서 뽑는다.
    newCands = s.direction === "alternate" && rev.lastType ? collect([rev.lastType === "zh_ko" ? "ko_zh" : "zh_ko"]) : [];
    if (!newCands.length) newCands = collect(allowed);
    const room = counts().newAvailable; // 오늘 더 낼 수 있는 새 카드 수(후보가 더 적으면 후보 수)
    if (newCands.length && room <= 0) newCands = [];
  }
  const nNew = Math.min(counts().newAvailable, newCands.length), nDue = dueCards.length;
  if (!nNew && !nDue) return null;
  if (nDue && Math.random() < nDue / (nDue + nNew)) { const c = rand(dueCards); return { word: byRef.get(c.ref), type: c.type, isNew: false, card: c }; }
  const n = rand(newCands); return { word: n.word, type: n.type, isNew: true, card: null };
}
function viewReview() {
  const v = $("#view");
  v.innerHTML = '<h1>복습</h1><div class="counts" aria-label="복습 현황"></div><div id="area"></div>';
  nextCard();
}
function nextCard() {
  rev.cur = pickNext(); rev.phase = "prompt"; rev.typed = ""; rev.strokes = [];
  if (rev.cur) { rev.lastType = rev.cur.type; rev.lastKey = rev.cur.word.r + ":" + rev.cur.type; }
  drawReview();
}
const undoHtml = () => (rev.undo ? '<div class="btns" style="margin-top:10px"><button type="button" class="lk" id="undo">↶ 방금 평가 되돌리기 (' + esc(rev.undo.word.s) + " · " + esc(rev.undo.label) + ")</button></div>" : "");
function drawReview() {
  const c = counts();
  $(".counts").innerHTML = "<span>복습할 카드 <b>" + c.due + "</b></span><span>오늘 새 카드 가능 <b>" + c.newAvailable + "</b></span><span>오늘 완료 <b>" + c.doneToday + "</b></span>";
  const a = $("#area");
  if (!rev.cur) {
    const none = settings().scope === "selected" && selectedCount() === 0;
    a.innerHTML = none ? '<div class="empty">복습 대상으로 고른 단어가 없습니다.<div class="small">단어장에서 카드의 ☆ 버튼을 눌러 복습할 단어를 고르거나, 통계·설정에서 복습 범위를 바꿔 주세요.</div></div>' : '<div class="empty">지금 복습할 카드가 없습니다.<div class="small">오늘 새 카드 한도를 모두 썼거나 복습 시각이 아직 되지 않았습니다. 통계·설정에서 하루 새 카드 수와 학습할 급수를 바꿀 수 있습니다.</div>' +
      (rev.skipped.size ? '<div class="btns" style="margin-top:12px"><button class="btn sec" id="unskip">건너뛴 카드 다시 보기</button></div>' : "") + "</div>";
    a.innerHTML += undoHtml(); const un = $("#undo"); if (un) un.onclick = undoLast;
    const u = $("#unskip"); if (u) u.onclick = () => { rev.skipped.clear(); nextCard(); };
    return;
  }
  const { word: w, type, isNew } = rev.cur, zk = type === "zh_ko", revealed = rev.phase === "revealed";
  const mode = zk ? "zh" : settings().direction === "ko_zh_pbt" ? "pbt" : "cbt";
  const X = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" fill="none"/></svg>';
  let h = '<div class="rv"><div class="q">' + (zk ? "이 단어의 한국어 뜻은?" : '이 뜻에 해당하는 <em>중국어</em>를 ' + (mode === "pbt" ? "손으로 쓰세요" : "입력하세요")) + "</div>" +
    '<div class="prompt' + (zk ? "" : " ko") + '" lang="' + (zk ? "zh-Hans" : "ko") + '">' + (zk ? esc(w.s) + supHtml(w) : esc(w.m)) + "</div>" +
    (zk ? "" : '<div class="meta">' + (w.pos ? '<span class="tag">' + esc(w.pos) + "</span>" : "") + '<span class="tag hsk">HSK ' + w.h + "</span></div>" +
      '<div class="ans-label"><span>답안</span><span class="mode">' + (mode === "pbt" ? "PBT · 손글씨" : "CBT · 문자 입력") + "</span></div>");
  if (mode === "cbt") {
    h += '<div class="qwrap"><input id="typed" type="text" lang="zh-Hans" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="여기에 중국어 입력" aria-label="답안 입력" value="' + esc(rev.typed || "") + '"' + (revealed ? " disabled" : "") + '>' +
      '<button type="button" class="qclear" id="tclear" aria-label="입력 지우기"' + (revealed || !rev.typed ? " hidden" : "") + ">" + X + "</button></div>";
  } else if (mode === "pbt") {
    h += '<div class="padwrap"><canvas id="pad" aria-label="손글씨 답안 칸"></canvas><div class="padhint" id="padhint">여기에 손가락이나 펜으로 쓰세요</div></div>' +
      '<div class="padtools"><button type="button" class="lk" id="pundo"' + (revealed ? " disabled" : "") + '>↶ 한 획 지우기</button><button type="button" class="lk" id="pclear"' + (revealed ? " disabled" : "") + ">모두 지우기</button></div>";
  }
  if (!revealed) {
    h += '<div class="btns"><button class="btn" id="reveal">정답 보기</button><button class="btn sec" id="skip">건너뛰기</button></div>';
  } else {
    if (mode === "cbt" && rev.typed !== null) {
      const t = rev.typed.trim(), ok = !!t && [...(w.k || []), ...(w.kt || []), w.s, w.t].includes(t);
      h += '<div class="verdict ' + (ok ? "ok" : "bad") + '">' + (ok ? "✓ 정답입니다" : "✗ 정답과 다릅니다") + "</div>";
    } else if (mode === "pbt") {
      h += '<div class="mine">아래 정답과 비교해 보고 직접 평가하세요.</div>';
    }
    h += (zk ? wordCard(w, "", null) : '<article class="card simple"><div class="hz" lang="zh-Hans">' + esc(w.s) + supHtml(w) + '</div><p class="py">' + esc(w.p) + "</p></article>") +
      '<div class="ratings" role="group" aria-label="얼마나 잘 기억했나요?">' +
      ratings().map((r) => '<button class="rate r' + r.n + '" data-r="' + r.n + '">' + r.label + "<small>" + r.sub + "</small></button>").join("") +
      '</div><div class="btns" style="margin-top:12px"><button class="btn sec sm" id="skip">평가하지 않고 건너뛰기</button></div>';
  }
  a.innerHTML = h + "</div>" + undoHtml();
  const un = $("#undo"); if (un) un.onclick = undoLast;
  const doReveal = () => { if (mode === "cbt" && $("#typed")) rev.typed = $("#typed").value; rev.phase = "revealed"; drawReview(); };
  const r = $("#reveal"); if (r) r.onclick = doReveal;
  if (mode === "cbt" && !revealed) {
    const t = $("#typed"), c = $("#tclear");
    t.oninput = () => { c.hidden = !t.value; };
    t.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doReveal(); } };
    c.onclick = () => { t.value = ""; c.hidden = true; t.focus(); };
    t.focus({ preventScroll: true });
  }
  if (mode === "pbt") setupPad(revealed);
  const sk = $("#skip"); if (sk) sk.onclick = () => { rev.skipped.add(w.r + ":" + type); nextCard(); };
  a.querySelectorAll(".rate").forEach((b) => (b.onclick = () => rate(Number(b.dataset.r))));
}
/* 손글씨 답안 칸 (PBT): 쓴 글씨는 정답 보기 전까지만 남고, 자동 채점은 하지 않는다 */
let cv, cx, dpr = 1, drawing = null;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function setupPad(locked) {
  cv = $("#pad"); dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect(); cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  cx = cv.getContext("2d"); cx.scale(dpr, dpr); padRedraw();
  const sync = () => { $("#pundo").disabled = locked || !rev.strokes.length; $("#pclear").disabled = locked || !rev.strokes.length; $("#padhint").style.display = rev.strokes.length ? "none" : "flex"; };
  sync();
  if (locked) return;
  const pt = (e) => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); drawing = [pt(e)]; rev.strokes.push(drawing); sync(); padRedraw(); });
  cv.addEventListener("pointermove", (e) => { if (!drawing) return; drawing.push(pt(e)); padRedraw(); });
  const end = () => { drawing = null; sync(); };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  $("#pundo").onclick = () => { rev.strokes.pop(); padRedraw(); sync(); };
  $("#pclear").onclick = () => { rev.strokes = []; padRedraw(); sync(); };
}
function padRedraw() {
  const w = cv.width / dpr, h = cv.height / dpr; cx.clearRect(0, 0, w, h);
  cx.strokeStyle = cssVar("--line"); cx.lineWidth = 1; cx.setLineDash([5, 5]);
  cx.beginPath(); cx.moveTo(0, h / 2); cx.lineTo(w, h / 2); cx.moveTo(w / 2, 0); cx.lineTo(w / 2, h); cx.stroke(); cx.setLineDash([]);
  cx.strokeStyle = cssVar("--fg"); cx.lineWidth = 4.5; cx.lineCap = "round"; cx.lineJoin = "round";
  rev.strokes.forEach((s) => { cx.beginPath(); s.forEach(([x, y], i) => (i ? cx.lineTo(x, y) : cx.moveTo(x, y))); if (s.length === 1) cx.lineTo(s[0][0] + 0.1, s[0][1]); cx.stroke(); });
}
let rating = false;
async function rate(n) {
  if (rating || !rev.cur || rev.phase !== "revealed") return;
  rating = true;
  try {
    const { word, type, card } = rev.cur, now = new Date(), key = word.r + ":" + type, r = ratings()[n - 1];
    const saved = { ...(card || {}), key, ref: word.r, type, created: card ? card.created : now.toISOString(),
      due: r.days ? dueAfter(r.days) : now.toISOString(), last_review: now.toISOString(), reps: ((card && card.reps) || 0) + 1, done: n === 4, interval_days: r.days || 0 };
    await saveCard(saved);
    await saveLog({ ts: now.toISOString(), key, rating: n, sch: 2 });
    rev.undo = { word, type, prev: card ? { ...card } : null, ts: now.toISOString(), label: r.label };
  } finally { rating = false; }
  nextCard();
}
/* 방금 한 평가 되돌리기 (잘못 눌렀을 때, 특히 '완벽히 외움') */
async function undoLast() {
  const u = rev.undo; if (!u) return;
  const key = u.word.r + ":" + u.type;
  if (u.prev) await saveCard(u.prev); else await deleteCard(key);
  await removeLog(u.ts);
  rev.undo = null; rev.cur = { word: u.word, type: u.type, isNew: !u.prev, card: u.prev }; rev.phase = "revealed"; rev.typed = null; rev.strokes = []; drawReview();
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
  const total = mem.cards.size, mastered = [...mem.cards.values()].filter((x) => x.done).length, learning = total - mastered;
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(dayKey(d)); }
  const perDay = Object.fromEntries(days.map((d) => [d, 0]));
  mem.log.forEach((l) => { const k = dayKey(new Date(l.ts)); if (k in perDay) perDay[k]++; });
  const max = Math.max(1, ...Object.values(perDay));
  v.innerHTML = "<h1>통계·설정</h1>" +
    (mem.kv.get("notice") ? '<div class="warn" id="notice">' + esc(mem.kv.get("notice")) + ' <button type="button" class="lk" id="notice-ok">확인</button></div>' : "") +
    storageHtml() +
    (persistent ? "" : '<div class="warn">이 브라우저에서는 기록을 저장할 수 없어 앱을 닫으면 사라집니다. 사파리에서 열었다면 홈 화면에 추가한 앱으로 실행해 보세요.</div>') +
    '<div class="stats"><div class="stat"><b>' + c.doneToday + '</b>오늘 복습</div><div class="stat"><b>' + total + '</b>시작한 카드</div>' +
    '<div class="stat"><b>' + learning + '</b>복습 중인 카드</div><div class="stat"><b>' + mastered + '</b>완벽히 외운 카드</div></div>' +
    (mastered ? '<div class="row"><span>완벽히 외운 카드 ' + mastered + '개를 복습에 다시 포함</span><button type="button" class="btn sec sm" id="unmaster">되돌리기</button></div>' : "") +
    '<h2>최근 14일 복습 수</h2><div class="bars" role="img" aria-label="최근 14일 복습 수">' + days.map((d) => '<div title="' + d + ": " + perDay[d] + '회" style="height:' + Math.max(2, Math.round(100 * perDay[d] / max)) + '%"></div>').join("") + "</div>" +
    '<h2>학습 설정</h2>' +
    '<div class="row"><label for="s-perday">하루 새 카드 수</label><input id="s-perday" type="number" min="0" max="200" value="' + s.perDay + '"></div>' +
    '<div class="row"><label for="s-scope">복습 범위</label><select id="s-scope"><option value="levels">선택한 급수 전체</option><option value="selected">내가 고른 단어만 (' + selectedCount() + '개)</option></select></div>' +
    '<div class="row"><label for="s-dir">카드 방향</label><select id="s-dir"><option value="alternate">번갈아 (중→한 / 한→중 CBT)</option><option value="zh_ko">중국어 → 한국어만</option><option value="ko_zh">한국어 → 중국어 (CBT · 문자 입력)</option><option value="ko_zh_pbt">한국어 → 중국어 (PBT · 손글씨)</option></select></div>' +
    '<div class="small muted" id="s-dirnote" style="margin:4px 0 0"></div>' +
    '<div class="row"><span>새 카드로 학습할 급수 <span class="small muted">(범위가 ‘급수 전체’일 때)</span></span><span class="chips" id="s-levels"></span></div>' +
    '<div class="msg muted" id="s-msg"></div>' +
    '<h2>복습 주기</h2><p class="small muted" style="margin:0 0 4px">평가 버튼을 눌렀을 때 몇 일 뒤에 다시 보여 줄지 정합니다 (1~365일). 완벽히 외움은 복습에서 제외됩니다.</p>' +
    [["어려움", 0], ["중간", 1], ["쉬움", 2]].map(([l, i]) => '<div class="row"><label for="s-iv' + i + '">' + l + '</label><span><input id="s-iv' + i + '" type="number" inputmode="numeric" min="1" max="365" value="' + ivDays()[i] + '"> 일 이내 다시</span></div>').join("") +
    '<h2>백업</h2><p class="small muted">복습 기록은 이 기기에만 저장됩니다. 기기를 바꾸거나 사파리 데이터를 지우기 전에 내보내기로 파일을 보관하세요.</p>' +
    '<div class="btns" style="justify-content:flex-start"><button class="btn sec" id="export">기록 내보내기</button><label class="btn sec" for="import" style="cursor:pointer">기록 가져오기</label><input id="import" type="file" accept="application/json,.json" hidden></div>' +
    '<div class="msg" id="b-msg" role="status"></div>' +
    '<p class="small muted" style="margin-top:22px">단어 데이터: HSK 3.0 1–5급 ' + WORDS.length.toLocaleString() + "개 (HSK 考试大纲, 中外语言交流合作中心 2025-11 발표 · 2026-07 시행). 한국어 뜻·한자음·훈음은 직접 제공한 엑셀 데이터이며 외부 사전·원문과 대조하지 않았습니다. 복습 간격: 어려움 1일 · 중간 3일 · 쉬움 14일 이내에 다시 나오고, 완벽히 외움은 복습에서 제외됩니다.</p>";
  $("#s-scope").value = s.scope; $("#s-levels").style.opacity = s.scope === "selected" ? ".45" : "1";
  $("#s-dir").value = s.direction;
  const DIRNOTE = { alternate: "카드마다 중국어→한국어와 한국어→중국어(CBT, 타자 입력)가 번갈아 나옵니다.", zh_ko: "한자를 보고 뜻을 떠올린 뒤 정답을 확인합니다.", ko_zh: "뜻을 보고 중국어를 타자로 입력합니다. 맞았는지 바로 표시됩니다.", ko_zh_pbt: "뜻을 보고 손글씨로 쓴 뒤 정답과 비교해 직접 평가합니다." };
  const dn = () => { $("#s-dirnote").textContent = DIRNOTE[$("#s-dir").value] || ""; }; dn(); $("#s-dir").addEventListener("change", dn);
  const um = $("#unmaster"); if (um) um.onclick = async () => {
    if (um.dataset.sure !== "1") { um.dataset.sure = "1"; um.textContent = "한 번 더 누르면 되돌립니다"; return; }
    for (const c of [...mem.cards.values()].filter((x) => x.done)) await saveCard({ ...c, done: false, due: new Date().toISOString() });
    viewStats();
  };
  const save = async () => {
    const levels = [...document.querySelectorAll("#s-levels .chip")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => Number(b.dataset.l));
    const perDayV = Math.max(0, Math.min(200, parseInt($("#s-perday").value, 10) || 0));
    await saveSettings({ ...settings(), levels: levels.length ? levels : [1], perDay: perDayV, direction: $("#s-dir").value, scope: $("#s-scope").value, iv: [0, 1, 2].map((i) => Math.max(1, Math.min(365, Math.round(Number($("#s-iv" + i).value)) || IV_BASE[i]))) });
    [0, 1, 2].forEach((i) => { $("#s-iv" + i).value = ivDays()[i]; });
    $("#s-levels").style.opacity = $("#s-scope").value === "selected" ? ".45" : "1";
    $("#s-msg").textContent = "저장했습니다.";
  };
  [1, 2, 3, 4, 5].forEach((n) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.dataset.l = n; b.textContent = n + "급";
    b.setAttribute("aria-pressed", String(s.levels.includes(n)));
    b.onclick = () => { b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")); save(); };
    $("#s-levels").append(b);
  });
  ["#s-perday", "#s-scope", "#s-dir", "#s-iv0", "#s-iv1", "#s-iv2"].forEach((id) => $(id).addEventListener("change", save));
  $("#export").onclick = exportData;
  fillStorageExtras();
  const nok = $("#notice-ok"); if (nok) nok.onclick = async () => { await putKv("notice", ""); $("#notice").remove(); };
  $("#import").onchange = importData;
}
/* 저장 상태: 기록이 어디에 얼마나 저장돼 있는지 화면에서 바로 확인할 수 있게 한다. */
function storageHtml() {
  const standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const exN = Object.values(allExamples()).reduce((n, a) => n + a.length, 0);
  return '<h2>저장 상태</h2><div class="warn"><b>' + (persistent ? "이 기기에 저장 중" : "저장 불가 (앱을 닫으면 사라짐)") + "</b> · " +
    (standalone ? "홈 화면 앱으로 실행 중" : "사파리(브라우저) 탭으로 실행 중") + "<br>고른 단어 " + selectedCount() + "개 · 내 예문 " + exN + "개 · 시작한 카드 " + mem.cards.size + "개<br>" +
    '<span id="persist-state"></span><div class="small muted" style="margin-top:4px">기록은 홈 화면 앱과 사파리 탭에 각각 따로 저장됩니다. 한쪽에서 넣은 것은 다른 쪽에서 보이지 않습니다. 항상 같은 쪽(홈 화면 앱)으로 여세요.</div></div>' +
    '<div id="legacy"></div>';
}
async function fillStorageExtras() {
  try {
    if (navigator.storage && navigator.storage.persisted) {
      const p = await navigator.storage.persisted(), el = $("#persist-state");
      if (el) el.textContent = p ? "브라우저가 이 저장소를 보존 대상으로 표시했습니다." : "보존 보장 없음: 기기 저장 공간이 부족하면 브라우저가 지울 수 있으니 가끔 기록을 내보내 두세요.";
    }
  } catch { /* 무시 */ }
  const lg = mem.kv.get("legacy"), box = $("#legacy"); if (!lg || !box) return;
  const exCount = Object.values(lg.examples || {}).reduce((n, a) => n + a.length, 0), selN = Object.keys(lg.selected || {}).length;
  if (!exCount && !selN && !(lg.cards || []).length) return;
  let names = {}; try { names = await (await fetch("data/legacy-words.json")).json(); } catch { /* 무시 */ }
  const label = (ref) => (names[ref] ? names[ref][0] + " (" + names[ref][1] + ") " + names[ref][2] : ref);
  const lines = [];
  Object.keys(lg.selected || {}).forEach((r) => lines.push("★ " + label(r)));
  Object.entries(lg.examples || {}).forEach(([r, arr]) => arr.forEach((e) => lines.push("예문 · " + label(r) + "\n  " + e.zh + (e.ko ? "\n  " + e.ko : ""))));
  box.innerHTML = '<h2>이전 단어 목록의 기록</h2><p class="small muted">단어 목록이 2025 대강 기준으로 바뀌면서 새 목록에 없는 단어 ' + (lg.cards || []).length + "개 카드의 복습 기록, 고른 단어 " + selN + "개, 예문 " + exCount + '개가 여기에 보관돼 있습니다. 지워지지 않았습니다.</p>' +
    '<div class="btns" style="justify-content:flex-start"><button type="button" class="btn sec sm" id="legacy-copy">보관된 선택·예문을 텍스트로 복사</button></div><div class="msg" id="legacy-msg"></div>';
  $("#legacy-copy").onclick = async () => {
    const text = lines.join("\n");
    try { await navigator.clipboard.writeText(text); $("#legacy-msg").textContent = "복사했습니다. 메모 앱 등에 붙여 넣어 보관하세요."; }
    catch { const ta = document.createElement("textarea"); ta.value = text; ta.readOnly = true; ta.rows = 8; ta.style.cssText = "width:100%;margin-top:8px"; box.append(ta); ta.select(); $("#legacy-msg").textContent = "아래 글을 직접 선택해 복사하세요."; }
  };
}
function exportData() {
  const data = { app: "hanyu-offline", version: 2, dataVersion: 2, legacy: mem.kv.get("legacy") || null, exported_at: new Date().toISOString(), settings: settings(), cards: [...mem.cards.values()], log: mem.log, examples: allExamples(), selected: selectedMap() };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "hanyu-backup-" + dayKey(new Date()) + ".json";
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $("#b-msg").textContent = "백업 파일을 만들었습니다. 파일 앱이나 다운로드 목록에서 확인하세요. (" + mem.cards.size + "개 카드, " + mem.log.length + "건 기록, 예문 " + Object.values(allExamples()).reduce((n, a) => n + a.length, 0) + "개)";
}
async function importData(e) {
  const f = e.target.files[0]; if (!f) return;
  const msg = $("#b-msg");
  try {
    let d = JSON.parse(await f.text());
    if (d.app !== "hanyu-offline" || !Array.isArray(d.cards) || !Array.isArray(d.log)) throw new Error("이 앱의 백업 파일이 아닙니다.");
    if (!d.dataVersion || d.dataVersion < 2) { // 예전 단어 목록 기준 백업 → 새 단어 번호로 변환
      const refmap = await (await fetch("data/refmap.json")).json();
      const r = remapPayload(d, refmap);
      d = { ...d, cards: [...r.cards.values()], examples: r.examples, selected: r.selected, dataVersion: 2 };
      if (Object.keys(r.legacy.cards).length || Object.keys(r.legacy.examples).length || Object.keys(r.legacy.selected).length) {
        const lg = mem.kv.get("legacy") || { cards: [], examples: {}, selected: {} };
        await putKv("legacy", { cards: lg.cards.concat(r.legacy.cards), examples: { ...lg.examples, ...r.legacy.examples }, selected: { ...lg.selected, ...r.legacy.selected } });
      }
    }
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
    if (d.selected && typeof d.selected === "object") {
      const all = { ...selectedMap() };
      for (const ref of Object.keys(d.selected)) if (byRef.has(ref)) all[ref] = true;
      await saveSelected(all);
    }
    let exAdded = 0;
    if (d.examples && typeof d.examples === "object") {
      const all = { ...allExamples() };
      for (const [ref, arr] of Object.entries(d.examples)) {
        if (!byRef.has(ref) || !Array.isArray(arr)) continue;
        const list = [...(all[ref] || [])];
        for (const e of arr) {
          if (!e || typeof e.id !== "string" || typeof e.zh !== "string" || !e.zh.trim()) continue;
          const i = list.findIndex((x) => x.id === e.id);
          const item = { id: e.id, zh: e.zh.slice(0, 300), ko: typeof e.ko === "string" ? e.ko.slice(0, 300) : "", updated: typeof e.updated === "string" ? e.updated : "" };
          if (i < 0) { list.push(item); exAdded++; } else if (item.updated > (list[i].updated || "")) list[i] = item;
        }
        if (list.length) all[ref] = list;
      }
      await saveExamples(all);
    }
    msg.textContent = "가져왔습니다. 새 카드 " + added + "개, 더 최근 기록으로 갱신 " + newer + "개, 복습 기록 " + logs + "건, 새 예문 " + exAdded + "개.";
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
  await migrateIfNeeded();
  applyAppearance();
  let tab = "dict"; try { tab = localStorage.getItem("hanyu-tab") || "dict"; } catch { /* 무시 */ }
  show(["dict", "review", "stats"].includes(tab) ? tab : "dict");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
