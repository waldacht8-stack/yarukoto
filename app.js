'use strict';

const STORE_KEY = 'yarukoto.tasks.v1';
const VIEW_KEY = 'yarukoto.view';
const BANNER_KEY = 'yarukoto.installBannerClosed';
const SWIPE_TIP_KEY = 'yarukoto.swipeTipClosed';
const WEEK = '日月火水木金土';
const REPEAT_LABEL = { daily: '毎日', weekdays: '平日', weekly: '毎週', monthly: '毎月' };

const $ = (sel) => document.querySelector(sel);

let tasks = loadTasks();
let view = safeGet(VIEW_KEY) || 'today';
let editingId = null;
let undoSnapshot = null;
let toastTimer = null;
// クイック入力の下のボタンで選んだ期限（undefined ならタブごとの既定）と重要フラグ
let quickDue;
let quickStar = false;
// 次の描画で特定のタスクに付けるアニメーション用クラス（id → クラス）
const fx = new Map();
let lastRatio = null;
let lastRemain = null;
let lastCount = null;

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
function fmtLong(s) {
  const d = parseYmd(s);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
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
  if (t.repeat && t.repeat !== 'none') {
    // 完了履歴を残しつつ、本体は次回の期限へ
    tasks.push({ ...t, id: uid(), repeat: 'none', done: true, doneAt: Date.now() });
    t.due = nextDue(t);
    commit(`完了！ 次回は ${fmtMD(t.due)}`, snap);
  } else {
    t.done = true;
    t.doneAt = Date.now();
    commit('完了しました', snap);
  }
}

function uncompleteTask(id) {
  const t = findTask(id);
  if (!t) return;
  t.done = false;
  t.doneAt = null;
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
  if ((m = tok.match(/^(\d{1,2})[/／](\d{1,2})$/))) {
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

function parseQuick(text) {
  const rest = [];
  const out = {};
  for (const tok of text.trim().split(/\s+/)) {
    const r = tok && parseToken(tok);
    if (r) Object.assign(out, r);
    else if (tok) rest.push(tok);
  }
  // 日付の言葉だけを入力した場合はそのままタイトルにする
  if (!rest.length) return { title: text.trim() };
  return { title: rest.join(' '), ...out };
}

function defaultDueForView() {
  if (view === 'someday') return null;
  if (view === 'upcoming') return addDays(today(), 1);
  return today();
}

function resolveQuick(text) {
  const p = parseQuick(text);
  let due = p.due !== undefined ? p.due : quickDue !== undefined ? quickDue : defaultDueForView();
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
      { duration: 240, easing: 'ease-in', fill: 'forwards' },
    ).finished.catch(() => {}),
    // 描画が止まっている（バックグラウンドなど）ときもアニメーション待ちで固まらないようにする
    sleep(400),
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

function enableSwipe(li, row, { onRight, onLeft }) {
  const THRESHOLD = 80;
  let x0 = null;
  let y0 = 0;
  let dx = 0;
  let dragging = false;

  const reset = () => {
    x0 = null;
    li.classList.remove('swiping', 'sw-armed', 'sw-right', 'sw-left');
    row.style.transform = '';
  };
  // スワイプ直後のタップで編集画面が開かないようにする
  const swallowClick = () => {
    const stopClick = (e) => { e.stopPropagation(); e.preventDefault(); };
    row.addEventListener('click', stopClick, { capture: true, once: true });
    setTimeout(() => row.removeEventListener('click', stopClick, { capture: true }), 80);
  };

  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    x0 = e.clientX;
    y0 = e.clientY;
    dx = 0;
    dragging = false;
  });
  row.addEventListener('pointermove', (e) => {
    if (x0 == null) return;
    const mx = e.clientX - x0;
    const my = e.clientY - y0;
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

function taskItem(t) {
  const over = isOverdue(t);
  const meta = [];
  if (t.due) {
    const cls = over ? 'due over' : t.due === today() ? 'due today' : 'due';
    meta.push(h('span', { class: cls }, dueLabel(t)));
  }
  if (t.repeat && t.repeat !== 'none') meta.push(h('span', {}, `↻ ${REPEAT_LABEL[t.repeat]}`));
  if (t.note) meta.push(h('span', { class: 'note' }, t.note.split('\n')[0]));

  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const left = swipeLeftAction(t);
  const li = h('li', { class: `task${over ? ' is-over' : ''}${t.done ? ' is-done' : ''}${fx.get(t.id) || ''}` });
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
    check,
    h('div', { class: 'body', onclick: () => openEditor(t.id) },
      h('div', { class: 'title' }, t.title),
      meta.length ? h('div', { class: 'meta' }, meta) : null,
      over ? h('div', { class: 'quick-actions' },
        h('button', { type: 'button', class: 'pill', onclick: stop(() => moveOut(today())) }, '今日やる'),
        h('button', { type: 'button', class: 'pill', onclick: stop(() => moveOut(addDays(today(), 1))) }, '明日に'),
        h('button', { type: 'button', class: 'pill', onclick: stop(() => openEditor(t.id)) }, '日付を選ぶ'),
      ) : null,
    ),
    t.done ? null : h('button', {
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
  });
  return li;
}

function section(title, items, { danger = false, action = null, id = null, count = true } = {}) {
  return h('section', { class: `section${danger ? ' danger' : ''}`, id },
    h('div', { class: 'section-head' },
      h('h2', {}, title, count ? h('span', { class: 'section-count' }, items.length) : null),
      action),
    h('ul', { class: 'tasks' }, items.map((t, i) => {
      const li = taskItem(t);
      li.style.setProperty('--i', i);
      return li;
    })),
  );
}

// 今日の進み具合（リング＋残り件数）
function todaySummary(overdue, todays) {
  const td = today();
  const doneToday = tasks.filter((t) => t.done && t.doneAt && ymd(new Date(t.doneAt)) === td).length;
  const remain = overdue.length + todays.length;
  const total = remain + doneToday;
  if (!total) return null;
  const ratio = doneToday / total;
  const from = lastRatio ?? 0;
  const r = 24;
  const c = 2 * Math.PI * r;
  const ring = h('div', { class: 'ring' });
  ring.innerHTML = `<svg viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="${r}" class="ring-bg"/>`
    + `<circle cx="30" cy="30" r="${r}" class="ring-fg" stroke-dasharray="${c.toFixed(1)}" style="stroke-dashoffset:${(c * (1 - from)).toFixed(1)}"/></svg>`
    + `<span><b>${Math.round(from * 100)}</b><small>%</small></span>`;
  // 前回の値から今回の値までリングと数字を動かす
  const fg = ring.querySelector('.ring-fg');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fg.style.strokeDashoffset = (c * (1 - ratio)).toFixed(1);
  }));
  countUp(ring.querySelector('b'), Math.round(from * 100), Math.round(ratio * 100));
  const celebrate = lastRemain > 0 && remain === 0;
  lastRatio = ratio;
  lastRemain = remain;
  if (celebrate) setTimeout(() => burst(ring, { count: 14, dist: 44 }), 450);

  return h('div', { class: `summary${celebrate ? ' celebrate' : ''}${remain ? '' : ' all-done'}` },
    ring,
    h('div', { class: 'summary-text' },
      h('div', { class: 'summary-main' }, remain ? `あと ${remain} 件` : '今日の分はすべて完了！'),
      h('div', { class: 'summary-sub' },
        overdue.length ? h('span', { class: 'over' }, `期限切れ ${overdue.length}`) : null,
        h('span', {}, `今日 ${todays.length}`),
        h('span', {}, `完了 ${doneToday}`),
      ),
    ),
  );
}

// 予定タブ上部の 2 週間カレンダー
function weekStrip() {
  const td = today();
  const counts = new Map();
  for (const t of activeTasks()) {
    if (!t.due) continue;
    const key = t.due < td ? td : t.due;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(td, i);
    const dow = parseYmd(d).getDay();
    const n = counts.get(d) || 0;
    const cls = ['day', i === 0 && 'is-today', n && 'has', dow === 0 && 'sun', dow === 6 && 'sat'].filter(Boolean).join(' ');
    days.push(h('button', {
      type: 'button',
      class: cls,
      'aria-label': `${fmtMD(d)} ${n}件`,
      onclick: () => {
        if (i === 0) return setView('today');
        const s = document.getElementById(`d-${d}`);
        if (s) s.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
      },
    },
    h('span', { class: 'dow' }, i === 0 ? '今日' : WEEK[dow]),
    h('span', { class: 'dn' }, parseYmd(d).getDate()),
    h('span', { class: 'dots' }, n > 3 ? `${n}` : '•'.repeat(n))));
  }
  return h('div', { class: 'week' }, days);
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

const VIEWS = {
  today: {
    title: '今日',
    placeholder: '今日やること（例: 資料送る 15時）',
    build() {
      const overdue = activeTasks().filter(isOverdue).sort(cmpTask);
      const todays = activeTasks().filter(isDueToday).sort(cmpTask);
      const out = [installBanner(), todaySummary(overdue, todays)];
      if (overdue.length) {
        out.push(section('期限切れ', overdue, {
          danger: true,
          action: overdue.length > 1
            ? h('button', { type: 'button', class: 'text-btn', onclick: () => moveTasks(overdue.map((t) => t.id), today()) }, 'すべて今日へ')
            : null,
        }));
      }
      if (todays.length) out.push(section('今日', todays));
      if (!overdue.length && !todays.length) {
        const some = activeTasks().filter((t) => !t.due).length;
        out.push(empty('今日のタスクはすべて完了 🎉', some ? `「やりたい」に ${some} 件あります。余裕があれば手をつけてみましょう。` : '上の欄から追加できます。'));
      }
      out.push(swipeTip());
      return out;
    },
  },
  upcoming: {
    title: '予定',
    placeholder: '予定を追加（例: 歯医者 11/5 15時）',
    build() {
      const td = today();
      const list = activeTasks().filter((t) => t.due && t.due > td).sort(cmpTask);
      if (!list.length) return [weekStrip(), empty('先の予定はありません', '期限のあるタスクがここに日付順で並びます。')];
      const groups = new Map();
      for (const t of list) {
        if (!groups.has(t.due)) groups.set(t.due, []);
        groups.get(t.due).push(t);
      }
      return [weekStrip(), ...[...groups].map(([due, items]) => {
        const diff = diffDays(due, td);
        const prefix = diff === 1 ? '明日 · ' : diff === 2 ? '明後日 · ' : diff < 7 ? '' : `${diff}日後 · `;
        return section(prefix + fmtMD(due), items, { id: `d-${due}` });
      })];
    },
  },
  someday: {
    title: 'やりたいこと',
    placeholder: 'あれしたい、これしたい…',
    build() {
      const list = activeTasks().filter((t) => !t.due)
        .sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || b.createdAt - a.createdAt);
      if (!list.length) return [empty('思いついたことを気軽にメモ', '期限のないアイデアや「いつかやりたい」はここへ。日付を決めたら予定に移ります。')];
      return [section(`${list.length} 件`, list, { count: false })];
    },
  },
  done: {
    title: '完了',
    placeholder: '今日やること',
    build() {
      const list = tasks.filter((t) => t.done).sort((a, b) => b.doneAt - a.doneAt).slice(0, 300);
      if (!list.length) return [empty('まだ完了したタスクはありません', '')];
      const todayDone = list.filter((t) => ymd(new Date(t.doneAt)) === today()).length;
      return [section(`今日 ${todayDone} 件完了`, list, {
        count: false,
        action: h('button', { type: 'button', class: 'text-btn', onclick: clearDone }, '履歴を削除'),
      })];
    },
  },
};

function updateCounts() {
  const overdue = activeTasks().filter(isOverdue).length;
  const todays = activeTasks().filter(isDueToday).length;
  const ct = $('#countToday');
  const n = overdue + todays;
  ct.textContent = n || '';
  ct.classList.toggle('danger', overdue > 0);
  if (lastCount !== null && n !== lastCount) {
    ct.classList.remove('bump');
    void ct.offsetWidth; // アニメーションを最初からやり直す
    ct.classList.add('bump');
  }
  lastCount = n;
  $('#countUpcoming').textContent = '';
  $('#countSomeday').textContent = '';
}

let enterTimer = null;

function render({ enter = false } = {}) {
  if (!VIEWS[view]) view = 'today';
  const list = $('#list');
  if (enter && !reduceMotion()) {
    list.classList.add('view-enter');
    clearTimeout(enterTimer);
    enterTimer = setTimeout(() => list.classList.remove('view-enter'), 700);
  }
  $('#todayLabel').textContent = fmtLong(today());
  $('#viewTitle').textContent = VIEWS[view].title;
  $('#quickInput').placeholder = VIEWS[view].placeholder;
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  list.replaceChildren(...VIEWS[view].build().filter(Boolean));
  fx.clear();
  updateCounts();
  updateHint();
}

/* ---------- バッジ ---------- */

function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  const n = activeTasks().filter((t) => isOverdue(t) || t.due === today()).length;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

function refreshBadgeStatus() {
  const el = $('#badgeStatus');
  const btn = $('#badgeBtn');
  if (!('setAppBadge' in navigator) || !('Notification' in window)) {
    el.textContent = 'この環境では使えません（ホーム画面に追加したアプリで開いてください）';
    btn.disabled = true;
    return;
  }
  btn.disabled = Notification.permission === 'granted';
  el.textContent = {
    granted: '有効です',
    denied: '許可されていません。iPhone の「設定」→「通知」→「やること」から許可してください。',
    default: '',
  }[Notification.permission];
}

/* ---------- 編集シート ---------- */

const closeTimers = new WeakMap();

function openSheet(el) {
  clearTimeout(closeTimers.get(el));
  el.classList.remove('closing');
  el.hidden = false;
}
function closeSheet(el) {
  if (el.hidden) return;
  if (reduceMotion()) {
    el.hidden = true;
    return;
  }
  el.classList.add('closing');
  closeTimers.set(el, setTimeout(() => {
    el.hidden = true;
    el.classList.remove('closing');
  }, 200));
}

function syncChips() {
  const v = $('#fDue').value;
  document.querySelectorAll('#dueChips .chip').forEach((c) => {
    const key = c.dataset.due;
    c.classList.toggle('on', key === 'none' ? !v : presetDue(key) === v && !!v);
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
  syncChips();
  openSheet($('#editor'));
  if (!id) $('#fTitle').focus();
}

function saveEditor(e) {
  e.preventDefault();
  const title = $('#fTitle').value.trim();
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
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
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

function showQuickChips(show) {
  $('#quickChips').hidden = !show;
}

function setView(next) {
  view = next;
  quickDue = undefined;
  quickStar = false;
  safeSet(VIEW_KEY, view);
  render({ enter: true });
  window.scrollTo(0, 0);
}

$('#quickForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#quickInput').value;
  if (!text.trim()) return;
  const t = addTask(resolveQuick(text));
  $('#quickInput').value = '';
  commit(addedMessage(t));
});
$('#quickInput').addEventListener('input', updateHint);
$('#quickInput').addEventListener('focus', () => showQuickChips(true));
$('#quickInput').addEventListener('blur', () => {
  if (!$('#quickInput').value.trim()) showQuickChips(false);
});
// ボタンを押してもキーボードが閉じないように、フォーカスを奪わせない
$('#quickChips').addEventListener('pointerdown', (e) => e.preventDefault());
$('#quickChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.hasAttribute('data-star')) quickStar = !quickStar;
  else quickDue = presetDue(chip.dataset.due) || null;
  updateHint();
});
$('#detailBtn').addEventListener('click', () => {
  const text = $('#quickInput').value;
  openEditor(null, text.trim() ? resolveQuick(text) : { due: defaultDueForView() });
});

document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => setView(b.dataset.view));
});

$('#editForm').addEventListener('submit', saveEditor);
$('#fDue').addEventListener('input', syncChips);
$('#dueChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $('#fDue').value = presetDue(chip.dataset.due);
  if (!$('#fDue').value) $('#fTime').value = '';
  syncChips();
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

$('#settingsBtn').addEventListener('click', () => {
  refreshBadgeStatus();
  openSheet($('#settings'));
});
$('#badgeBtn').addEventListener('click', async () => {
  try {
    await Notification.requestPermission();
  } catch { /* 古い環境 */ }
  refreshBadgeStatus();
  updateBadge();
});
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
render({ enter: true });
updateBadge();
