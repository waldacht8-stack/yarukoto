'use strict';

const APP_VERSION = '9';
const STORE_KEY = 'yarukoto.tasks.v1';
const THEME_KEY = 'yarukoto.theme';
const BADGE_KEY = 'yarukoto.badge';
const EXPORT_KEY = 'yarukoto.lastExport';
// テーマ名と、iPhone の上部バーに使う色
const THEMES = {
  ink: { name: '白とインク', bar: '#FFFFFF' },
  forest: { name: '石と森', bar: '#E6E8E1' },
  night: { name: '夜の紺', bar: '#0E1525' },
};
const FOLD_KEY = 'yarukoto.folded';
const BANNER_KEY = 'yarukoto.installBannerClosed';
const SWIPE_TIP_KEY = 'yarukoto.swipeTipClosed';
const WEEK = '日月火水木金土';
const REPEAT_LABEL = { daily: '毎日', weekdays: '平日', weekly: '毎週', monthly: '毎月' };

const $ = (sel) => document.querySelector(sel);

let tasks = loadTasks();
let editingId = null;
let undoSnapshot = null;
let toastTimer = null;
// クイック入力の下のボタンで選んだ期限（undefined なら今日）と重要フラグ
let quickDue;
let quickStar = false;
// 次の描画で特定のタスクに付けるアニメーション用クラス（id → クラス）
const fx = new Map();
let lastCounts = null;
let lastRemain = null;

function mark(id, cls) {
  fx.set(id, `${fx.get(id) || ''} ${cls}`);
}

/* ---------- 保存 ---------- */

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function loadTasks() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function persist() {
  if (!safeSet(STORE_KEY, JSON.stringify(tasks))) toast('保存に失敗しました');
  updateBadge();
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------- 日付 ---------- */

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function today() { return ymd(new Date()); }
function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
function diffDays(a, b) { return Math.round((parseYmd(a) - parseYmd(b)) / 86400000); }
function nowHM() {
  const n = new Date();
  return `${pad(n.getHours())}:${pad(n.getMinutes())}`;
}
function fmtMD(s) {
  const d = parseYmd(s);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
}
// 次の指定曜日。includeToday なら今日も候補に含める
function nextDow(dow, includeToday) {
  const td = today();
  let diff = (dow - parseYmd(td).getDay() + 7) % 7;
  if (diff === 0 && !includeToday) diff = 7;
  return addDays(td, diff);
}
function monthDay(m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const y = new Date().getFullYear();
  if (new Date(y, m - 1, d).getMonth() !== m - 1) return null;
  const s = `${y}-${pad(m)}-${pad(d)}`;
  return s < today() ? `${y + 1}-${pad(m)}-${pad(d)}` : s;
}
function presetDue(key) {
  switch (key) {
    case 'today': return today();
    case 'tomorrow': return addDays(today(), 1);
    case 'weekend': return nextDow(6, true);
    case 'nextweek': return nextDow(1, false);
    default: return '';
  }
}

/* ---------- タスクの状態 ---------- */

function isOverdue(t) {
  if (t.done || !t.due) return false;
  const td = today();
  if (t.due < td) return true;
  return t.due === td && !!t.time && t.time < nowHM();
}
function isDueToday(t) { return !t.done && t.due === today() && !isOverdue(t); }
function activeTasks() { return tasks.filter((t) => !t.done); }
function cmpTask(a, b) {
  return (a.due || '9999').localeCompare(b.due || '9999')
    || (b.star ? 1 : 0) - (a.star ? 1 : 0)
    || (a.time || '99').localeCompare(b.time || '99')
    || a.createdAt - b.createdAt;
}
function dueLabel(t) {
  const diff = diffDays(t.due, today());
  let label;
  if (diff < 0) label = diff === -1 ? '昨日' : `${-diff}日超過 · ${fmtMD(t.due)}`;
  else if (diff === 0) label = '今日';
  else if (diff === 1) label = '明日';
  else if (diff < 7) label = `${WEEK[parseYmd(t.due).getDay()]}曜`;
  else label = fmtMD(t.due);
  return t.time ? `${label} ${t.time}` : label;
}
function stepRepeat(due, repeat, monthDayAnchor) {
  const d = parseYmd(due);
  switch (repeat) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekdays':
      do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'monthly': {
      const last = new Date(d.getFullYear(), d.getMonth() + 2, 0).getDate();
      return ymd(new Date(d.getFullYear(), d.getMonth() + 1, Math.min(monthDayAnchor, last)));
    }
  }
  return ymd(d);
}
// 遅れて完了しても、次回は必ず明日以降になるように進める
function nextDue(t) {
  const td = today();
  const anchor = t.monthDay || parseYmd(t.due || td).getDate();
  let d = t.due || td;
  do { d = stepRepeat(d, t.repeat, anchor); } while (d <= td);
  return d;
}

/* ---------- 操作 ---------- */

function findTask(id) { return tasks.find((t) => t.id === id); }
function commit(msg, snap) {
  persist();
  render();
  if (msg) toast(msg, snap);
}

function addTask(fields) {
  const t = {
    id: uid(), title: '', note: '', due: null, time: null, repeat: 'none',
    star: false, done: false, doneAt: null, createdAt: Date.now(), ...fields,
  };
  if (t.repeat === 'monthly' && t.due) t.monthDay = parseYmd(t.due).getDate();
  tasks.push(t);
  mark(t.id, 'is-new');
  return t;
}

function completeTask(id) {
  const t = findTask(id);
  if (!t) return;
  const snap = JSON.stringify(tasks);
  // 期日内に終えたかを記録しておく（期限なしは対象外）
  const late = t.due ? isOverdue(t) : null;
  if (t.repeat && t.repeat !== 'none') {
    // 完了履歴を残しつつ、本体は次回の期限へ
    tasks.push({ ...t, id: uid(), repeat: 'none', done: true, doneAt: Date.now(), late });
    t.due = nextDue(t);
    commit(`完了！ 次回は ${fmtMD(t.due)}`, snap);
  } else {
    t.done = true;
    t.doneAt = Date.now();
    t.late = late;
    commit(late ? '完了しました（遅れて完了）' : '完了しました', snap);
  }
}

function uncompleteTask(id) {
  const t = findTask(id);
  if (!t) return;
  t.done = false;
  t.doneAt = null;
  delete t.late;
  commit('未完了に戻しました');
}

function moveTasks(ids, due) {
  const snap = JSON.stringify(tasks);
  for (const id of ids) {
    const t = findTask(id);
    if (!t) continue;
    t.due = due;
    // 今日に移しても時刻が過ぎていたら期限切れのままになるので時刻を外す
    if (due === today() && t.time && t.time < nowHM()) t.time = null;
  }
  const where = due === today() ? '今日' : due === addDays(today(), 1) ? '明日' : fmtMD(due);
  commit(`${ids.length > 1 ? `${ids.length}件を` : ''}${where}に移動しました`, snap);
}

function toggleStar(id) {
  const t = findTask(id);
  if (!t) return;
  t.star = !t.star;
  if (t.star) mark(t.id, 'star-pop');
  commit();
}

function deleteTask(id) {
  const snap = JSON.stringify(tasks);
  tasks = tasks.filter((t) => t.id !== id);
  commit('削除しました', snap);
}

function clearDone() {
  const n = tasks.filter((t) => t.done).length;
  if (!n) return;
  const snap = JSON.stringify(tasks);
  tasks = tasks.filter((t) => !t.done);
  commit(`完了済み ${n} 件を削除しました`, snap);
}

/* ---------- クイック入力の解析 ---------- */

function toHalfWidth(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function parseToken(raw) {
  const tok = toHalfWidth(raw);
  const td = today();
  const words = { 今日: 0, きょう: 0, 明日: 1, あした: 1, 明後日: 2, あさって: 2 };
  if (tok in words) return { due: addDays(td, words[tok]) };
  if (tok === '週末') return { due: nextDow(6, true) };
  if (tok === '来週') return { due: nextDow(1, false) };
  if (tok === '!' || tok === '！') return { star: true };
  let m;
  if ((m = tok.match(/^([日月火水木金土])曜日?$/))) return { due: nextDow(WEEK.indexOf(m[1]), false) };
  if ((m = tok.match(/^(\d{1,2})[/／](\d{1,2})$/)) || (m = tok.match(/^(\d{1,2})月(\d{1,2})日$/))) {
    const d = monthDay(+m[1], +m[2]);
    if (d) return { due: d };
  }
  if ((m = tok.match(/^(\d{1,2})[:：](\d{2})$/)) && +m[1] < 24 && +m[2] < 60) {
    return { time: `${pad(+m[1])}:${m[2]}` };
  }
  if ((m = tok.match(/^(\d{1,2})時(半)?$/)) && +m[1] < 24) {
    return { time: `${pad(+m[1])}:${m[2] ? '30' : '00'}` };
  }
  return null;
}

// 言葉の末尾にくっついた日付・時刻（「歯医者11/16」「会議15:00」）
const ATTACHED_DATE = /^(.*?\S)(\d{1,2}[/／]\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}[:：]\d{2}|\d{1,2}時半?)$/;

// 1 語の末尾から日付・時刻を最大 2 つ切り出す。戻り値は [残りの語, 読み取った値の一覧]
function peelAttached(word) {
  const found = [];
  for (let k = 0; k < 2; k++) {
    // 全角数字を半角にしても文字数は変わらないので、位置はそのまま使える
    const m = toHalfWidth(word).match(ATTACHED_DATE);
    // 数字の途中で切らない（「11/16」だけを「1」と「1/16」に分けない）
    if (!m || /\d$/.test(m[1])) break;
    const r = parseToken(m[2]);
    if (!r) break;
    found.unshift(r);
    word = word.slice(0, m[1].length);
  }
  return [word, found];
}

function parseQuick(text) {
  const rest = [];
  const out = {};
  for (const tok of text.trim().split(/\s+/)) {
    if (!tok) continue;
    const r = parseToken(tok);
    if (r) {
      Object.assign(out, r);
      continue;
    }
    const [word, found] = peelAttached(tok);
    found.forEach((f) => Object.assign(out, f));
    rest.push(word);
  }
  // 日付の言葉だけを入力した場合はそのままタイトルにする
  if (!rest.length) return { title: text.trim() };
  return { title: rest.join(' '), ...out };
}

function resolveQuick(text) {
  const p = parseQuick(text);
  let due = p.due !== undefined ? p.due : quickDue !== undefined ? quickDue : today();
  if (!due && p.time) due = today();
  return { title: p.title, due, time: p.time || null, star: !!p.star || quickStar };
}

/* ---------- 描画 ---------- */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// 行を縮めながら消す。完了・移動でリストから外れるときに使う
function animateOut(el, delay = 0) {
  if (!el.animate || reduceMotion()) return Promise.resolve();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return sleep(delay).then(() => Promise.race([
    el.animate(
      [{ height: `${el.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
      { duration: 320, easing: 'cubic-bezier(.45, 0, .2, 1)', fill: 'forwards' },
    ).finished.catch(() => {}),
    // 描画が止まっている（バックグラウンドなど）ときもアニメーション待ちで固まらないようにする
    sleep(450),
  ]));
}

// 期限が今日以前なら「明日へ」、それ以外は「今日へ」
// チェック時に小さな粒を飛ばす
function burst(el, { count = 8, dist = 20 } = {}) {
  if (reduceMotion()) return;
  const b = h('span', { class: 'burst', style: `--d:${-dist}px` });
  for (let i = 0; i < count; i++) b.append(h('i', { style: `--a:${(360 / count) * i}deg` }));
  el.append(b);
  setTimeout(() => b.remove(), 700);
}

// 数字をなめらかに増減させる
function countUp(el, from, to) {
  if (reduceMotion() || from === to) {
    el.textContent = to;
    return;
  }
  const start = performance.now();
  let finished = false;
  const step = (now) => {
    if (finished) return;
    const p = Math.min(1, (now - start) / 600);
    el.textContent = Math.round(from + (to - from) * (1 - (1 - p) ** 3));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // 描画が止まっていても最終的な値にはしておく
  setTimeout(() => {
    finished = true;
    el.textContent = to;
  }, 650);
}

function swipeLeftAction(t) {
  return t.due && t.due <= today()
    ? { label: '明日へ', due: addDays(today(), 1) }
    : { label: '今日へ', due: today() };
}

const LONG_PRESS_MS = 450;

function enableSwipe(li, row, { onRight, onLeft, onLongPress }) {
  const THRESHOLD = 80;
  let x0 = null;
  let y0 = 0;
  let dx = 0;
  let dragging = false;
  let pressTimer = null;

  // 長押し：指を動かさずに押し続けたら詳細を開く
  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
    li.classList.remove('pressing');
  };
  const reset = () => {
    x0 = null;
    cancelPress();
    li.classList.remove('swiping', 'sw-armed', 'sw-right', 'sw-left');
    row.style.transform = '';
  };
  // iOS の長押しメニュー（文字の選択やコピー）を出さない
  row.addEventListener('contextmenu', (e) => e.preventDefault());
  // スワイプ直後のタップで編集画面が開かないようにする
  const swallowClick = (ms = 80) => {
    const stopClick = (e) => { e.stopPropagation(); e.preventDefault(); };
    row.addEventListener('click', stopClick, { capture: true, once: true });
    setTimeout(() => row.removeEventListener('click', stopClick, { capture: true }), ms);
  };

  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.check, .star, .pill')) return;
    x0 = e.clientX;
    y0 = e.clientY;
    dx = 0;
    dragging = false;
    if (onLongPress) {
      li.classList.add('pressing');
      pressTimer = setTimeout(() => {
        pressTimer = null;
        x0 = null;
        li.classList.remove('pressing');
        swallowClick(600);
        onLongPress();
      }, LONG_PRESS_MS);
    }
  });
  row.addEventListener('pointermove', (e) => {
    if (x0 == null) return;
    const mx = e.clientX - x0;
    const my = e.clientY - y0;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) cancelPress();
    if (!dragging) {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { x0 = null; return; }
      if (Math.abs(mx) < 10) return;
      dragging = true;
      try { row.setPointerCapture(e.pointerId); } catch { /* 取れなくても続行できる */ }
      li.classList.add('swiping');
    }
    dx = mx < 0 && !onLeft ? 0 : mx;
    row.style.transform = `translateX(${dx}px)`;
    li.classList.toggle('sw-right', dx > 0);
    li.classList.toggle('sw-left', dx < 0);
    li.classList.toggle('sw-armed', Math.abs(dx) > THRESHOLD);
  });
  row.addEventListener('pointerup', () => {
    cancelPress();
    if (x0 == null || !dragging) { x0 = null; return; }
    swallowClick();
    const action = dx > THRESHOLD ? onRight : dx < -THRESHOLD ? onLeft : null;
    if (!action) return reset();
    x0 = null;
    li.classList.remove('swiping');
    row.style.transform = `translateX(${dx > 0 ? '' : '-'}100%)`;
    action();
  });
  row.addEventListener('pointercancel', reset);
}

// 左の日付列に出す文字（上段・下段）
function whenLabels(t, showDate) {
  if (t.done) {
    const d = t.doneAt ? new Date(t.doneAt) : null;
    return [d ? `${d.getHours()}:${pad(d.getMinutes())}` : '', '完了'];
  }
  if (!t.due) return ['', ''];
  const d = parseYmd(t.due);
  const main = showDate ? `${d.getMonth() + 1}/${d.getDate()}` : '';
  // 時刻があれば時刻、なければ曜日（今日と期限切れは曜日を省く）
  const sub = t.time || (showDate && t.due > today() ? WEEK[d.getDay()] : '');
  return [main, sub];
}

function taskItem(t, { showDate = true } = {}) {
  const td = today();
  const over = isOverdue(t);
  const meta = [];
  if (t.done) {
    if (t.late === true) meta.push(h('span', { class: 'tag late' }, '遅れて完了'));
    if (t.late === false) meta.push(h('span', { class: 'tag ontime' }, '期日内'));
    if (t.due) meta.push(h('span', {}, `期限 ${fmtMD(t.due)}`));
  } else if (over) {
    const days = diffDays(td, t.due);
    meta.push(h('span', { class: 'over' }, days > 0 ? `${days}日超過` : '時刻を過ぎています'));
  }
  if (t.repeat && t.repeat !== 'none') meta.push(h('span', {}, `↻ ${REPEAT_LABEL[t.repeat]}`));
  if (t.note) meta.push(h('span', { class: 'note' }, t.note.split('\n')[0]));

  const kind = t.done ? 'is-done'
    : over ? 'is-over'
      : !t.due ? 'is-someday'
        : t.due === td ? 'is-today'
          : t.due > addDays(td, 7) ? 'is-later' : '';
  const [whenMain, whenSub] = whenLabels(t, showDate);
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const left = swipeLeftAction(t);
  const li = h('li', { class: `task ${kind}${fx.get(t.id) || ''}` });
  const complete = (delay) => {
    li.classList.add('completing');
    return animateOut(li, delay).then(() => completeTask(t.id));
  };
  const restore = (delay) => animateOut(li, delay).then(() => uncompleteTask(t.id));
  const moveOut = (due, delay = 0) => animateOut(li, delay).then(() => moveTasks([t.id], due));

  const check = h('button', {
    type: 'button',
    class: 'check',
    'aria-label': t.done ? '未完了に戻す' : '完了にする',
    onclick: stop(() => {
      if (t.done) return restore(0);
      check.classList.add('checking');
      burst(check);
      complete(320);
    }),
  });

  const row = h('div', { class: 'row' },
    h('div', { class: 'when' },
      h('span', { class: 'when-main' }, whenMain),
      whenSub ? h('span', { class: 'when-sub' }, whenSub) : null),
    h('div', { class: 'rail' }, check, h('span', { class: 'rail-line' })),
    h('div', { class: 'body', onclick: () => openEditor(t.id) },
      h('div', { class: 'title' }, t.title),
      meta.length ? h('div', { class: 'meta' }, meta) : null,
      over ? h('div', { class: 'quick-actions' },
        h('button', { type: 'button', class: 'pill strong', onclick: stop(() => moveOut(today())) }, '今日やる'),
        h('button', { type: 'button', class: 'pill', onclick: stop(() => moveOut(addDays(today(), 1))) }, '明日へ'),
      ) : null,
    ),
    t.done ? h('span') : h('button', {
      type: 'button',
      class: `star${t.star ? ' on' : ''}`,
      'aria-label': t.star ? '重要を外す' : '重要にする',
      onclick: stop(() => toggleStar(t.id)),
    }, t.star ? '★' : '☆'),
  );

  li.append(
    h('div', { class: 'swipe-bg', 'aria-hidden': 'true' },
      h('span', { class: 'sw-label-right' }, t.done ? '↩ 戻す' : '✓ 完了'),
      h('span', { class: 'sw-label-left' }, t.done ? '' : `${left.label} →`),
    ),
    row,
  );
  enableSwipe(li, row, {
    onRight: t.done ? () => restore(120) : () => complete(120),
    onLeft: t.done ? null : () => moveOut(left.due, 120),
    onLongPress: () => openPeek(t.id, row),
  });
  li.dataset.id = t.id;
  return li;
}

// 折りたたんだセクション（key → true/false）
const folded = (() => {
  try { return JSON.parse(safeGet(FOLD_KEY)) || {}; } catch { return {}; }
})();

// key を渡すと、見出しをタップして折りたためるセクションになる
function section(title, items, { key = null, danger = false, action = null, count = true, foldDefault = false } = {}) {
  const head = [h('h2', {}, title, count ? h('span', { class: 'section-count' }, items.length) : null), action];
  // 見出し内のボタンを押しても折りたたまれないようにする
  if (action) action.addEventListener('click', (e) => e.preventDefault());
  const list = h('ul', { class: 'tasks' }, items.map((t, i) => {
    // 同じ日付が続くときは、日付列を最初の 1 件だけに出す
    const li = taskItem(t, { showDate: i === 0 || items[i - 1].due !== t.due });
    li.style.setProperty('--i', i);
    return li;
  }));
  if (!key) {
    return h('section', { class: `section${danger ? ' danger' : ''}` }, h('div', { class: 'section-head' }, head), list);
  }
  const isFolded = key in folded ? folded[key] : foldDefault;
  const el = h('details', { class: `section fold${danger ? ' danger' : ''}`, open: !isFolded },
    // summary 自体を flex にすると古い iOS Safari で崩れるので内側で並べる
    h('summary', {}, h('div', { class: 'section-head' }, head)),
    list,
  );
  el.addEventListener('toggle', () => {
    folded[key] = !el.open;
    safeSet(FOLD_KEY, JSON.stringify(folded));
  });
  return el;
}

// 上部の件数（期限切れ・今日・完了）。数が変わったら前の値から数え直す
function renderCounts(over, todays, done) {
  const el = $('#counts');
  const now = { over, today: todays, done };
  const tile = (key, label) => {
    const n = now[key];
    const from = lastCounts ? lastCounts[key] : n;
    const num = h('span', { class: 'count-num' }, from);
    if (from !== n) countUp(num, from, n);
    return h('div', { class: `count-tile ${key}${n ? '' : ' zero'}` },
      h('span', { class: 'count-label' }, label), num);
  };
  el.replaceChildren(tile('over', '期限切れ'), tile('today', '今日'), tile('done', '完了'));

  // 今日の分を全部終えた瞬間だけ祝う
  const remain = over + todays;
  const celebrate = lastRemain > 0 && remain === 0 && done > 0;
  el.classList.remove('celebrate');
  if (celebrate) {
    void el.offsetWidth;
    el.classList.add('celebrate');
    setTimeout(() => burst(el.querySelector('.count-tile.done'), { count: 14, dist: 40 }), 300);
  }
  lastRemain = remain;
  lastCounts = now;
}

function dayKey(ts) { return ymd(new Date(ts)); }

function logStats() {
  const td = today();
  const done = tasks.filter((t) => t.done && t.doneAt);
  const perDay = new Map();
  for (const t of done) {
    const k = dayKey(t.doneAt);
    perDay.set(k, (perDay.get(k) || 0) + 1);
  }
  const week = done.filter((t) => dayKey(t.doneAt) >= addDays(td, -6)).length;
  const judged = done.filter((t) => dayKey(t.doneAt) >= addDays(td, -29) && typeof t.late === 'boolean');
  const onTime = judged.length
    ? Math.round((judged.filter((t) => !t.late).length / judged.length) * 100)
    : null;
  // 今日まだ完了がなくても、昨日まで続いていれば連続として数える
  let streak = 0;
  let d = perDay.has(td) ? td : addDays(td, -1);
  while (perDay.has(d)) {
    streak++;
    d = addDays(d, -1);
  }
  return { perDay, week, onTime, judged: judged.length, streak, overdue: activeTasks().filter(isOverdue).length };
}

function statTile(label, value, unit, sub, { cls = '', onclick = null } = {}) {
  return h(onclick ? 'button' : 'div', { type: onclick ? 'button' : null, class: `stat ${cls}`, onclick },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value, unit ? h('small', {}, unit) : null),
    h('div', { class: 'stat-sub' }, sub),
  );
}

// 直近 14 日の完了数。バーをタップするとその日の件数を表示する
function doneChart(perDay) {
  const td = today();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(td, -i);
    days.push({ d, n: perDay.get(d) || 0 });
  }
  const max = Math.max(1, ...days.map((x) => x.n));
  const caption = h('span', { class: 'chart-value' });
  const bars = [];
  const select = (idx) => {
    const { d, n } = days[idx];
    caption.textContent = `${d === td ? '今日' : fmtMD(d)}  ${n}件`;
    bars.forEach((b, i) => b.classList.toggle('sel', i === idx));
  };
  days.forEach(({ d, n }, i) => {
    const dow = parseYmd(d).getDay();
    bars.push(h('button', {
      type: 'button',
      class: `col${d === td ? ' is-today' : ''}`,
      style: `--h:${(n / max) * 100}%; --i:${i}`,
      'aria-label': `${fmtMD(d)} ${n}件`,
      onclick: () => select(i),
    },
    h('span', { class: 'col-n' }, n || ''),
    h('span', { class: 'col-track' }, h('span', { class: 'col-bar' })),
    h('span', { class: `col-day${dow === 0 ? ' sun' : ''}` }, d === td ? '今日' : parseYmd(d).getDate())));
  });
  select(days.length - 1);
  return h('section', { class: 'chart' },
    h('div', { class: 'chart-head' }, h('h2', {}, '完了数（14日）'), caption),
    h('div', { class: 'bars' }, bars),
  );
}

function swipeTip() {
  if (safeGet(SWIPE_TIP_KEY) || !activeTasks().length) return null;
  const el = h('div', { class: 'tip' },
    h('p', {}, '右にスワイプで完了、左にスワイプで明日（または今日）へ移動できます。'),
    h('button', {
      type: 'button', class: 'text-btn', 'aria-label': '閉じる',
      onclick: () => { safeSet(SWIPE_TIP_KEY, '1'); el.remove(); },
    }, 'OK'),
  );
  return el;
}

function empty(strong, text) {
  return h('div', { class: 'empty' }, h('strong', {}, strong), text);
}

function installBanner() {
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (standalone || safeGet(BANNER_KEY)) return null;
  const el = h('div', { class: 'banner' },
    h('p', {}, 'Safari の共有ボタン → 「ホーム画面に追加」で、アプリとして使えます。データが消えにくくなるので、先に追加してから使うのがおすすめです。'),
    h('button', {
      type: 'button', class: 'text-btn', 'aria-label': '閉じる',
      onclick: () => { safeSet(BANNER_KEY, '1'); el.remove(); },
    }, '✕'),
  );
  return el;
}

// すべてのタスクを 1 本のリストに、期限の近い順のセクションで並べる
function buildList() {
  const td = today();
  const tomorrow = addDays(td, 1);
  const weekEnd = addDays(td, 7);
  const act = activeTasks();
  const overdue = act.filter(isOverdue).sort(cmpTask);
  const todays = act.filter(isDueToday).sort(cmpTask);
  const tmr = act.filter((t) => t.due === tomorrow).sort(cmpTask);
  const week = act.filter((t) => t.due > tomorrow && t.due <= weekEnd).sort(cmpTask);
  const later = act.filter((t) => t.due > weekEnd).sort(cmpTask);
  const someday = act.filter((t) => !t.due)
    .sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || b.createdAt - a.createdAt);
  const doneToday = tasks.filter((t) => t.done && t.doneAt && dayKey(t.doneAt) === td)
    .sort((a, b) => b.doneAt - a.doneAt);

  renderCounts(overdue.length, todays.length, doneToday.length);
  const out = [installBanner()];
  if (overdue.length) {
    out.push(section('期限切れ', overdue, {
      key: 'overdue',
      danger: true,
      action: overdue.length > 1
        ? h('button', { type: 'button', class: 'text-btn', onclick: () => moveTasks(overdue.map((t) => t.id), today()) }, 'すべて今日へ')
        : null,
    }));
  }
  if (todays.length) out.push(section('今日', todays, { key: 'today' }));
  else if (!overdue.length) {
    out.push(act.length || doneToday.length
      ? empty('今日のタスクはすべて完了 🎉', '先の予定ややりたいことに手をつけるのもおすすめです。')
      : empty('まだタスクはありません', '上の欄から追加できます。期限のない「やりたいこと」も気軽にどうぞ。'));
  }
  if (tmr.length) out.push(section(`明日 · ${fmtMD(tomorrow)}`, tmr, { key: 'tomorrow' }));
  if (week.length) out.push(section(`今週 · 〜${fmtMD(weekEnd)}`, week, { key: 'week' }));
  if (later.length) out.push(section('それ以降', later, { key: 'later' }));
  if (someday.length) out.push(section('やりたいこと', someday, { key: 'someday' }));
  if (doneToday.length) out.push(section('今日完了', doneToday, { key: 'done', foldDefault: true }));
  out.push(swipeTip());
  return out;
}

// 記録シートの中身
function buildLog() {
  const s = logStats();
  const out = [
    h('div', { class: 'stats' },
      statTile('期日内に完了', s.onTime ?? '—', s.onTime == null ? '' : '%',
        s.judged ? `直近30日 · ${s.judged}件中` : '期限つきの完了がまだありません'),
      statTile('今週の完了', s.week, '件', '直近7日'),
      statTile('連続', s.streak, '日', '毎日1件以上完了'),
      statTile('期限切れ', s.overdue, '件', s.overdue ? 'タップで一覧へ' : 'ありません',
        s.overdue ? {
          cls: 'danger',
          onclick: () => {
            closeSheet($('#logSheet'));
            window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
          },
        } : {}),
    ),
    doneChart(s.perDay),
  ];
  const list = tasks.filter((t) => t.done).sort((a, b) => b.doneAt - a.doneAt).slice(0, 200);
  if (!list.length) {
    out.push(empty('まだ完了したタスクはありません', 'タスクを完了すると、ここに記録されます。'));
    return out;
  }
  const groups = new Map();
  for (const t of list) {
    const k = dayKey(t.doneAt);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  [...groups].forEach(([day, items], i) => {
    const diff = diffDays(day, today());
    const label = diff === 0 ? '今日' : diff === -1 ? '昨日' : fmtMD(day);
    out.push(section(label, items, {
      action: i === 0 ? h('button', { type: 'button', class: 'text-btn', onclick: clearDone }, '履歴を削除') : null,
    }));
  });
  return out;
}

const enterTimers = new WeakMap();

// 登場アニメーション用のクラスを一定時間だけ付ける
function playEnter(el) {
  if (reduceMotion()) return;
  el.classList.add('view-enter');
  clearTimeout(enterTimers.get(el));
  enterTimers.set(el, setTimeout(() => el.classList.remove('view-enter'), 700));
}

function renderLog() {
  $('#logBody').replaceChildren(...buildLog().filter(Boolean));
}

function render({ enter = false } = {}) {
  const list = $('#list');
  if (enter) playEnter(list);
  const now = new Date();
  $('#todayDate').textContent = `${now.getMonth() + 1}月${now.getDate()}日`;
  $('#todayDow').textContent = `${WEEK[now.getDay()]}曜日`;
  list.replaceChildren(...buildList().filter(Boolean));
  if (!$('#logSheet').hidden) renderLog();
  fx.clear();
  updateHint();
}

/* ---------- バッジ ---------- */

const badgeSupported = () => 'setAppBadge' in navigator && 'Notification' in window;
const badgeEnabled = () => safeGet(BADGE_KEY) !== '0';

function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  const n = badgeEnabled() ? activeTasks().filter((t) => isOverdue(t) || t.due === today()).length : 0;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

function refreshBadgeStatus() {
  const sw = $('#badgeSwitch');
  const el = $('#badgeStatus');
  if (!badgeSupported()) {
    sw.checked = false;
    sw.disabled = true;
    el.textContent = 'ホーム画面に追加したアプリで使えます';
    return;
  }
  sw.disabled = false;
  sw.checked = badgeEnabled() && Notification.permission === 'granted';
  el.textContent = Notification.permission === 'denied'
    ? 'iPhone の「設定」→「通知」→「やること」で許可してください'
    : '期限切れと今日の合計';
}

/* ---------- テーマ ---------- */

function currentTheme() {
  const t = safeGet(THEME_KEY);
  return THEMES[t] ? t : 'ink';
}

function applyTheme(name, { animate = false } = {}) {
  const root = document.documentElement;
  if (animate && !reduceMotion()) {
    root.classList.add('theme-switching');
    setTimeout(() => root.classList.remove('theme-switching'), 400);
  }
  root.dataset.theme = name;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', THEMES[name].bar);
  document.querySelectorAll('#themePicker .theme-opt').forEach((opt) => {
    const input = opt.querySelector('input');
    input.checked = input.value === name;
    opt.classList.toggle('on', input.checked);
  });
}

function refreshExportStatus() {
  const at = Number(safeGet(EXPORT_KEY));
  if (!at) {
    $('#lastExport').textContent = '書き出し：まだありません';
    return;
  }
  const d = new Date(at);
  $('#lastExport').textContent = `最後の書き出し：${fmtMD(ymd(d))} ${d.getHours()}:${pad(d.getMinutes())}`;
}

/* ---------- 編集シート ---------- */

const closeTimers = new WeakMap();

// 開閉はどちらも CSS の transition で動かす。途中の位置からでも自然につながる
const SHEET_CLOSE_MS = 340;

function openSheet(el) {
  clearTimeout(closeTimers.get(el));
  el.classList.remove('closing');
  el.hidden = false;
  void el.offsetWidth; // 閉じた位置を一度描いてから開く
  el.classList.add('open');
  document.body.classList.add('sheet-open');
}
function closeSheet(el) {
  if (el.hidden || el.classList.contains('closing')) return;
  el.classList.remove('open');
  el.classList.add('closing');
  closeTimers.set(el, setTimeout(() => {
    el.hidden = true;
    el.classList.remove('closing');
    const sheet = el.querySelector('.sheet');
    if (sheet) sheet.style.transform = '';
    el.style.removeProperty('--dim');
    if (!document.querySelector('.backdrop.open')) document.body.classList.remove('sheet-open');
  }, reduceMotion() ? 0 : SHEET_CLOSE_MS));
}

// シートを下にスワイプして閉じる。中身が上までスクロールされているときだけ反応する
function enableSheetDrag(backdrop) {
  const sheet = backdrop.querySelector('.sheet');
  let y0 = null;
  let t0 = 0;
  let dy = 0;
  let dragging = false;

  sheet.addEventListener('touchstart', (e) => {
    y0 = null;
    if (e.touches.length !== 1 || sheet.scrollTop > 0) return;
    if (e.target.closest('input, textarea, select')) return;
    y0 = e.touches[0].clientY;
    t0 = Date.now();
    dy = 0;
    dragging = false;
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const d = e.touches[0].clientY - y0;
    if (!dragging) {
      if (d < -6) y0 = null; // 上方向はふつうのスクロールに任せる
      if (d < 6) return;
      dragging = true;
      backdrop.classList.add('dragging');
    }
    e.preventDefault();
    dy = Math.max(0, d);
    sheet.style.transform = `translateY(${dy}px)`;
    backdrop.style.setProperty('--dim', Math.max(0, 1 - dy / sheet.offsetHeight).toFixed(3));
  }, { passive: false });

  const end = () => {
    if (y0 == null) return;
    y0 = null;
    if (!dragging) return;
    dragging = false;
    // 指を離した位置から、開閉と同じ動きでつなげる
    backdrop.classList.remove('dragging');
    sheet.style.transform = '';
    backdrop.style.removeProperty('--dim');
    const fast = dy / Math.max(1, Date.now() - t0) > 0.5;
    if (dy > 120 || (fast && dy > 30)) closeSheet(backdrop);
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
}

/* ---------- 長押しの詳細 ---------- */

// iOS の動きに近い、出だしが速くて最後にゆっくり止まる曲線
const EASE = 'cubic-bezier(.32, .72, 0, 1)';
const ICONS = {
  check: '<path d="m5 12 5 5 9-10"/>',
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  undo: '<path d="M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
};
let peekState = null;

function rowOf(id) {
  return document.querySelector(`#list .task[data-id="${CSS.escape(id)}"] .row`);
}

// 行の位置・大きさに見えるよう、カードを縮めて重ねる変形
function transformFromRow(rowRect, cardRect) {
  const s = rowRect.width / cardRect.width;
  const dx = rowRect.left - cardRect.left;
  const dy = rowRect.top + rowRect.height / 2 - (cardRect.top + (cardRect.height * s) / 2);
  return `translate(${dx}px, ${dy}px) scale(${s})`;
}

function peekAction(label, icon, run, cls = '') {
  const btn = h('button', { type: 'button', class: `peek-act ${cls}` }, h('span', {}, label));
  const ico = h('span', { class: 'peek-ico', 'aria-hidden': 'true' });
  ico.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>`;
  btn.append(ico);
  btn.addEventListener('click', () => {
    if (peekJustOpened()) return;
    closePeek().then(run);
  });
  return btn;
}

// 長押しの指を離したときのタップで、開いた直後のボタンが押されないようにする
function peekJustOpened() {
  return !!peekState && Date.now() - peekState.at < 400;
}

function openPeek(id, sourceRow) {
  const t = findTask(id);
  if (!t || peekState) return;
  const td = today();
  const over = isOverdue(t);
  const overDays = over ? diffDays(td, t.due) : 0;
  const when = $('#peekWhen');
  when.textContent = t.done ? '完了済み'
    : !t.due ? 'やりたいこと'
      : over ? `期限切れ · ${overDays > 0 ? `${overDays}日超過` : '時刻を過ぎています'}`
        : dueLabel(t);
  when.classList.toggle('over', over);
  $('#peekTitle').textContent = t.title;
  $('#peekNote').textContent = t.note || '';
  $('#peekNote').hidden = !t.note;
  const stamp = (ms) => {
    const d = new Date(ms);
    return `${fmtMD(ymd(d))} ${d.getHours()}:${pad(d.getMinutes())}`;
  };
  const info = [
    ['期限', t.due ? `${fmtMD(t.due)}${t.time ? ` ${t.time}` : ''}` : 'なし'],
    ['くり返し', t.repeat && t.repeat !== 'none' ? REPEAT_LABEL[t.repeat] : 'なし'],
    ['重要', t.star ? '★ 重要' : '—'],
    ['作成', t.createdAt ? stamp(t.createdAt) : '—'],
  ];
  if (t.done && t.doneAt) info.push(['完了', stamp(t.doneAt)]);
  $('#peekInfo').replaceChildren(...info.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

  const li = () => rowOf(id)?.parentElement;
  const left = swipeLeftAction(t);
  const actions = t.done
    ? [peekAction('未完了に戻す', 'undo', () => uncompleteTask(id))]
    : [
      peekAction('完了にする', 'check', () => {
        const el = li();
        el?.classList.add('completing');
        return (el ? animateOut(el) : Promise.resolve()).then(() => completeTask(id));
      }),
      peekAction(left.label, 'move', () => {
        const el = li();
        return (el ? animateOut(el) : Promise.resolve()).then(() => moveTasks([id], left.due));
      }),
    ];
  actions.push(
    peekAction('編集する', 'edit', () => openEditor(id)),
    peekAction('削除', 'trash', () => {
      const el = li();
      return (el ? animateOut(el) : Promise.resolve()).then(() => deleteTask(id));
    }, 'danger'),
  );
  $('#peekActions').replaceChildren(...actions);

  const peek = $('#peek');
  peek.hidden = false;
  void peek.offsetWidth;
  peek.classList.add('open');
  peekState = { id, at: Date.now() };
  sourceRow?.parentElement.classList.add('peeking');

  if (reduceMotion() || !sourceRow) return;
  const card = peek.querySelector('.peek-card');
  card.animate(
    [{ transform: transformFromRow(sourceRow.getBoundingClientRect(), card.getBoundingClientRect()), opacity: 0.5 },
      { transform: 'none', opacity: 1 }],
    { duration: 480, easing: EASE },
  );
  $('#peekActions').animate(
    [{ opacity: 0, transform: 'translateY(-10px) scale(.96)' }, { opacity: 1, transform: 'none' }],
    { duration: 420, delay: 90, easing: EASE, fill: 'backwards' },
  );
}

// 閉じ終わったら resolve する（続けて行う操作のアニメーションと重ならないように）
function closePeek() {
  if (!peekState) return Promise.resolve();
  const { id } = peekState;
  peekState = null;
  const peek = $('#peek');
  const card = peek.querySelector('.peek-card');
  const row = rowOf(id);
  peek.classList.remove('open');
  const finish = () => {
    peek.hidden = true;
    row?.parentElement.classList.remove('peeking');
  };
  if (reduceMotion() || !card.animate) {
    finish();
    return Promise.resolve();
  }
  $('#peekActions').animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.96)' }], { duration: 160, easing: 'ease-out', fill: 'forwards' });
  const to = row ? transformFromRow(row.getBoundingClientRect(), card.getBoundingClientRect()) : 'scale(.92)';
  const anim = card.animate([{ transform: 'none', opacity: 1 }, { transform: to, opacity: row ? 0.6 : 0 }], { duration: 340, easing: EASE, fill: 'forwards' });
  const done = Promise.race([anim.finished.catch(() => {}), new Promise((r) => setTimeout(r, 420))]);
  return done.then(() => {
    finish();
    card.getAnimations().forEach((a) => a.cancel());
    $('#peekActions').getAnimations().forEach((a) => a.cancel());
  });
}

$('#peek').addEventListener('click', (e) => {
  if (e.target.closest('[data-close-peek]') && !peekJustOpened()) closePeek();
});

// 期限の日付ボタン（今日から 6 日分。選んだ日がその外なら先頭に出す）
function renderDayPills() {
  const td = today();
  const cur = $('#fDue').value;
  const days = [];
  for (let i = 0; i < 6; i++) days.push(addDays(td, i));
  if (cur && !days.includes(cur)) {
    days.unshift(cur);
    days.pop();
  }
  $('#dayPills').replaceChildren(...days.map((d) => {
    const dt = parseYmd(d);
    const sel = d === cur;
    return h('button', {
      type: 'button',
      class: `day${sel ? ' on' : ''}${d < td ? ' past' : ''}${d === td ? ' is-today' : ''}`,
      'aria-pressed': sel ? 'true' : 'false',
      'aria-label': fmtMD(d),
      onclick: () => {
        $('#fDue').value = d;
        rememberManualDue();
      },
    },
    h('span', { class: 'day-dow' }, d === td ? '今日' : WEEK[dt.getDay()]),
    h('span', { class: 'day-num' }, dt.getDate()));
  }));
}

function syncDue() {
  const due = $('#fDue').value;
  const time = $('#fTime').value;
  renderDayPills();
  $('#timeText').textContent = time || 'なし';
  $('#otherText').textContent = due ? `${parseYmd(due).getMonth() + 1}/${parseYmd(due).getDate()}` : '選ぶ';
  $('#noDueBtn').classList.toggle('on', !due);
  const note = $('#dueNote');
  const past = !!due && due < today();
  note.classList.toggle('over', past);
  note.textContent = !due ? '期限なし（やりたいこと）'
    : past ? `${diffDays(today(), due)}日過ぎています`
      : dueLabel({ due, time: time || null });
}

// 期限を手で選んだ値。タイトルから日付が消えたときはこの値に戻す
let editorBase = { due: '', time: '' };
let titleTouched = false;

function rememberManualDue() {
  editorBase = { due: $('#fDue').value, time: $('#fTime').value };
  syncDue();
}

// タイトルに「11/16」「明日 15時」などがあれば、期限に反映する
function syncTitleDate() {
  titleTouched = true;
  const p = parseQuick($('#fTitle').value);
  const found = p.due !== undefined || p.time !== undefined;
  $('#fDue').value = p.due !== undefined ? p.due : (p.time && !editorBase.due ? today() : editorBase.due);
  $('#fTime').value = p.time !== undefined ? p.time : editorBase.time;
  if (p.star) $('#fStar').checked = true;
  syncDue();
  const due = $('#fDue').value;
  $('#titleHint').textContent = found && due ? `期限を ${dueLabel({ due, time: $('#fTime').value || null })} にします` : '';
}

function syncRepeat() {
  const v = $('#fRepeat').value;
  document.querySelectorAll('#repeatSeg button').forEach((b) => {
    const on = b.dataset.v === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function openEditor(id, preset = {}) {
  editingId = id || null;
  const t = id ? findTask(id) : { title: '', note: '', due: null, time: null, repeat: 'none', star: false, ...preset };
  if (!t) return;
  $('#editorTitle').textContent = id ? 'タスクを編集' : '新しいタスク';
  $('#fTitle').value = t.title;
  $('#fNote').value = t.note || '';
  $('#fDue').value = t.due || '';
  $('#fTime').value = t.time || '';
  $('#fRepeat').value = t.repeat || 'none';
  $('#fStar').checked = !!t.star;
  $('#deleteBtn').hidden = !id;
  editorBase = { due: $('#fDue').value, time: $('#fTime').value };
  titleTouched = false;
  $('#titleHint').textContent = '';
  syncDue();
  syncRepeat();
  openSheet($('#editor'));
  if (!id) $('#fTitle').focus();
}

function saveEditor(e) {
  e.preventDefault();
  // 日付として読み取った部分はタイトルから外す（タイトルを書き換えたときだけ）
  const raw = $('#fTitle').value.trim();
  const title = titleTouched ? parseQuick(raw).title : raw;
  if (!title) {
    $('#fTitle').focus();
    return;
  }
  const data = {
    title,
    note: $('#fNote').value.trim(),
    due: $('#fDue').value || null,
    time: $('#fTime').value || null,
    repeat: $('#fRepeat').value,
    star: $('#fStar').checked,
  };
  if (!data.due && (data.time || data.repeat !== 'none')) data.due = today();
  data.monthDay = data.repeat === 'monthly' && data.due ? parseYmd(data.due).getDate() : undefined;

  if (editingId) {
    Object.assign(findTask(editingId), data);
    commit();
  } else {
    const t = addTask(data);
    commit(addedMessage(t));
    $('#quickInput').value = '';
  }
  closeSheet($('#editor'));
}

function addedMessage(t) {
  return `追加しました（${t.due ? dueLabel(t) : 'やりたいこと'}）`;
}

/* ---------- トースト ---------- */

function toast(msg, snap) {
  const el = $('#toast');
  undoSnapshot = snap || null;
  $('#toastMsg').textContent = msg;
  $('#toastUndo').hidden = !snap;
  el.classList.remove('leaving', 'show');
  el.hidden = false;
  void el.offsetWidth; // 続けて出したときも登場アニメーションをやり直す
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4000);
}

function hideToast() {
  const el = $('#toast');
  undoSnapshot = null;
  clearTimeout(toastTimer);
  el.classList.add('leaving');
  toastTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove('leaving');
  }, reduceMotion() ? 0 : 180);
}

/* ---------- バックアップ ---------- */

async function exportData() {
  const json = JSON.stringify({ app: 'yarukoto', version: 1, exportedAt: new Date().toISOString(), tasks }, null, 2);
  const name = `yarukoto-${today()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  const done = () => {
    safeSet(EXPORT_KEY, String(Date.now()));
    refreshExportStatus();
  };
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      done();
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  done();
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.tasks;
    if (!Array.isArray(list) || !list.every((t) => t && typeof t.id === 'string' && typeof t.title === 'string')) {
      throw new Error('形式が違います');
    }
    if (!confirm(`${list.length} 件のタスクを読み込みます。いまのデータは置き換わります。よろしいですか？`)) return;
    const snap = JSON.stringify(tasks);
    tasks = list;
    closeSheet($('#settings'));
    commit('読み込みました', snap);
  } catch (err) {
    alert(`読み込めませんでした: ${err.message}`);
  }
}

/* ---------- イベント ---------- */

function updateHint() {
  const text = $('#quickInput').value;
  // 期限ボタンは、入力中の文字も反映した「実際に入る期限」を光らせる
  const r = resolveQuick(text.trim() ? text : 'x');
  document.querySelectorAll('#quickChips .chip').forEach((c) => {
    if (c.hasAttribute('data-star')) c.classList.toggle('on', r.star);
    else c.classList.toggle('on', c.dataset.due === 'none' ? !r.due : presetDue(c.dataset.due) === r.due);
  });
  if (!text.trim()) {
    $('#hint').textContent = '';
    return;
  }
  const where = r.due ? dueLabel({ due: r.due, time: r.time }) : 'やりたいこと';
  $('#hint').textContent = `→ ${where}${r.star ? ' · ★' : ''} に追加`;
}

/* ---------- 追加用の入力欄 ---------- */

// キーボードの高さだけ入力欄を持ち上げる（iOS はキーボードで画面が縮まないため）
function syncKeyboardInset() {
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  $('#composer').style.setProperty('--kb', `${Math.round(kb)}px`);
  $('#composer').classList.toggle('kb', kb > 40);
}

function openComposer() {
  const el = $('#composer');
  clearTimeout(closeTimers.get(el));
  el.classList.remove('closing');
  el.hidden = false;
  syncKeyboardInset();
  // iOS ではタップの処理の中で focus しないとキーボードが出ない
  $('#quickInput').focus();
  void el.offsetWidth;
  el.classList.add('open');
  document.body.classList.add('composing');
  updateHint();
}

function closeComposer() {
  const el = $('#composer');
  if (el.hidden || el.classList.contains('closing')) return;
  $('#quickInput').blur();
  el.classList.remove('open');
  el.classList.add('closing');
  document.body.classList.remove('composing');
  closeTimers.set(el, setTimeout(() => {
    el.hidden = true;
    el.classList.remove('closing');
    // 何も入力せずに閉じたら、選んでいた期限も元に戻す
    if (!$('#quickInput').value.trim()) {
      quickDue = undefined;
      quickStar = false;
    }
  }, reduceMotion() ? 0 : SHEET_CLOSE_MS));
}

function quickAdd() {
  const text = $('#quickInput').value;
  if (!text.trim()) return;
  const t = addTask(resolveQuick(text));
  $('#quickInput').value = '';
  commit(addedMessage(t));
}
$('#quickForm').addEventListener('submit', (e) => {
  e.preventDefault();
  quickAdd();
});
$('#quickInput').addEventListener('input', updateHint);
$('#fab').addEventListener('click', openComposer);
$('#composer').addEventListener('click', (e) => {
  if (e.target.closest('[data-close-composer]')) closeComposer();
});
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncKeyboardInset);
  window.visualViewport.addEventListener('scroll', syncKeyboardInset);
}
// ボタンを押してもキーボードが閉じないように、フォーカスを奪わせない
$('#quickChips').addEventListener('pointerdown', (e) => e.preventDefault());
$('#quickChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.hasAttribute('data-detail')) {
    openDetailEditor();
    return;
  }
  if (chip.hasAttribute('data-star')) quickStar = !quickStar;
  else quickDue = presetDue(chip.dataset.due) || null;
  updateHint();
});
function openDetailEditor() {
  const text = $('#quickInput').value;
  const preset = text.trim() ? resolveQuick(text) : { due: quickDue !== undefined ? quickDue : today(), star: quickStar };
  closeComposer();
  openEditor(null, preset);
}

$('#editForm').addEventListener('submit', saveEditor);
$('#fTitle').addEventListener('input', syncTitleDate);
$('#fDue').addEventListener('input', rememberManualDue);
$('#fDue').addEventListener('change', rememberManualDue);
$('#fTime').addEventListener('input', rememberManualDue);
$('#fTime').addEventListener('change', rememberManualDue);
$('#noDueBtn').addEventListener('click', () => {
  $('#fDue').value = '';
  $('#fTime').value = '';
  rememberManualDue();
});
$('#repeatSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('#fRepeat').value = b.dataset.v;
  syncRepeat();
});
$('#deleteBtn').addEventListener('click', () => {
  if (!editingId) return;
  closeSheet($('#editor'));
  deleteTask(editingId);
});

document.querySelectorAll('.backdrop').forEach((bd) => {
  bd.addEventListener('click', (e) => {
    if (e.target === bd || e.target.closest('[data-close]')) closeSheet(bd);
  });
});

$('#logBtn').addEventListener('click', () => {
  openSheet($('#logSheet'));
  renderLog();
  playEnter($('#logBody'));
});
$('#settingsBtn').addEventListener('click', () => {
  refreshBadgeStatus();
  refreshExportStatus();
  applyTheme(currentTheme());
  openSheet($('#settings'));
});
$('#themePicker').addEventListener('change', (e) => {
  const name = e.target.value;
  if (!THEMES[name]) return;
  safeSet(THEME_KEY, name);
  applyTheme(name, { animate: true });
});
$('#badgeSwitch').addEventListener('change', async (e) => {
  if (!e.target.checked) {
    safeSet(BADGE_KEY, '0');
  } else {
    try {
      if (Notification.permission !== 'granted') await Notification.requestPermission();
    } catch { /* 古い環境 */ }
    safeSet(BADGE_KEY, Notification.permission === 'granted' ? '1' : '0');
  }
  refreshBadgeStatus();
  updateBadge();
});
// 1 行 1 タスクで登録する。日付のない行は期限なし（やりたいこと）にする
function bulkAdd(text) {
  // コピー元によって改行コードが違うので、どれでも 1 行として扱う
  const lines = text.split(/\r\n|[\r\n\u2028\u2029]/)
    .map((l) => l.replace(/^\s*(?:[-・*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  if (!lines.length) return 0;
  const snap = JSON.stringify(tasks);
  for (const line of lines) {
    const p = parseQuick(line);
    const due = p.due || (p.time ? today() : null);
    addTask({ title: p.title, due, time: p.time || null, star: !!p.star });
  }
  commit(`${lines.length} 件を追加しました`, snap);
  return lines.length;
}

$('#bulkBtn').addEventListener('click', () => {
  if (!bulkAdd($('#bulkText').value)) {
    toast('追加するテキストを貼り付けてください');
    return;
  }
  $('#bulkText').value = '';
  closeSheet($('#settings'));
  window.scrollTo(0, 0);
});
// 上の入力欄に複数行を貼り付けたときも、1 行ずつ登録する
$('#quickInput').addEventListener('paste', (e) => {
  const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
  if (!/[\r\n\u2028\u2029]/.test(text.trim())) return;
  e.preventDefault();
  bulkAdd(text);
});
$('#appVersion').textContent = `バージョン ${APP_VERSION}`;
document.querySelectorAll('.backdrop').forEach(enableSheetDrag);
$('#exportBtn').addEventListener('click', exportData);
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importData(file);
});

$('#toastUndo').addEventListener('click', () => {
  if (!undoSnapshot) return;
  // 元に戻ったタスクを光らせる
  const before = new Map(tasks.map((t) => [t.id, JSON.stringify(t)]));
  tasks = JSON.parse(undoSnapshot);
  for (const t of tasks) {
    if (before.get(t.id) !== JSON.stringify(t)) mark(t.id, 'is-new');
  }
  hideToast();
  persist();
  render();
});

// 日付の変わり目や時刻の経過で「期限切れ」を更新する
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    render();
    updateBadge();
  }
});
setInterval(() => {
  if (document.visibilityState === 'visible' && $('#editor').hidden) render();
  updateBadge();
}, 60 * 1000);

/* ---------- 起動 ---------- */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}
// iOS Safari で :active（押したときの見た目）を効かせるため
document.addEventListener('touchstart', () => {}, { passive: true });
// 画面の拡大縮小を止める（iOS は viewport の user-scalable=no を無視するため）
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
applyTheme(currentTheme());
render({ enter: true });
updateBadge();
