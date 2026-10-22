'use strict';

const APP_VERSION = '7';
const STORE_KEY = 'yarukoto.tasks.v1';
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
let lastRatio = null;
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
  if (t.done) {
    if (t.late === true) meta.push(h('span', { class: 'tag late' }, '遅れて完了'));
    if (t.late === false) meta.push(h('span', { class: 'tag ontime' }, '期日内'));
    if (t.due) meta.push(h('span', { class: 'due' }, `期限 ${fmtMD(t.due)}`));
  } else if (t.due) {
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
    const li = taskItem(t);
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

  const out = [installBanner(), todaySummary(overdue, todays)];
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
  $('#todayLabel').textContent = fmtLong(today());
  list.replaceChildren(...buildList().filter(Boolean));
  if (!$('#logSheet').hidden) renderLog();
  fx.clear();
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

// シートを下にスワイプして閉じる。中身が上までスクロールされているときだけ反応する
function enableSheetDrag(backdrop) {
  const sheet = backdrop.querySelector('.sheet');
  let y0 = null;
  let t0 = 0;
  let dy = 0;
  let dragging = false;

  const resetStyles = () => {
    sheet.style.transition = '';
    sheet.style.transform = '';
    backdrop.style.backgroundColor = '';
  };

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
      sheet.classList.add('dragging');
    }
    e.preventDefault();
    dy = Math.max(0, d);
    sheet.style.transform = `translateY(${dy}px)`;
    backdrop.style.backgroundColor = `rgba(0, 0, 0, ${(0.35 * Math.max(0, 1 - dy / sheet.offsetHeight)).toFixed(3)})`;
  }, { passive: false });

  const end = () => {
    if (y0 == null) return;
    y0 = null;
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    const fast = dy / Math.max(1, Date.now() - t0) > 0.5;
    if (dy > 120 || (fast && dy > 30)) {
      // 指を離した位置から下へ流して閉じる
      sheet.style.transition = 'transform .2s ease-in';
      sheet.style.transform = 'translateY(100%)';
      backdrop.style.transition = 'background-color .2s';
      backdrop.style.backgroundColor = 'rgba(0, 0, 0, 0)';
      closeTimers.set(backdrop, setTimeout(() => {
        backdrop.hidden = true;
        backdrop.style.transition = '';
        resetStyles();
      }, 200));
    } else {
      sheet.style.transition = 'transform .25s cubic-bezier(.2, .9, .25, 1)';
      sheet.style.transform = '';
      backdrop.style.backgroundColor = '';
      setTimeout(resetStyles, 260);
    }
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
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
  if ($('#quickInput').value.trim()) return;
  // 何も入力せずに閉じたら、選んでいた期限も元に戻す
  showQuickChips(false);
  quickDue = undefined;
  quickStar = false;
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
  openEditor(null, text.trim() ? resolveQuick(text) : { due: today() });
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

$('#logBtn').addEventListener('click', () => {
  openSheet($('#logSheet'));
  renderLog();
  playEnter($('#logBody'));
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
render({ enter: true });
updateBadge();
