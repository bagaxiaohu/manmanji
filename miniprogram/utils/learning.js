const DAY = 86400000;
const INTERVALS = [1, 3, 7, 14, 30, 60];
const FIXED_NAME = '小小欣宝贝';
const plans = require('./plans');

function dateKey(timestamp = Date.now()) {
  const d = new Date(timestamp);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function freshState() {
  return { version: 1, settings: { name: FIXED_NAME, note: '慢慢来，每一个记住的单词，都算数。', goal: 20, category: 'core' }, records: {}, favorites: {}, days: {} };
}

function selectWords(words, category) {
  return category === 'all' ? words : words.filter(w => w.category === category);
}

function learningPlan(words, state, now = Date.now()) {
  const chosen = plans.resolve(words, state);
  if (chosen) return { kind: chosen.kind, title: chosen.title, listName: chosen.title,
    listTotal: chosen.words.length, listLearned: chosen.words.filter(w => state.records[w.id]).length,
    completedLists: [...new Set(words.filter(w => w.category === 'core').map(w => w.group))].filter(group =>
      words.filter(w => w.group === group).every(w => state.records[w.id])).length,
    manual: true, newWords: chosen.words };
  const selected = selectWords(words, state.settings.category);
  const core = selected.filter(w => w.category === 'core');
  const groups = [...new Set(core.map(w => w.group))];
  const active = groups.find(group => core.some(w => w.group === group && !state.records[w.id]));
  const completedLists = groups.filter(group => core.filter(w => w.group === group).every(w => state.records[w.id])).length;
  if (active || state.settings.category === 'core') {
    const listName = active || groups[groups.length - 1] || '';
    const listWords = core.filter(w => w.group === listName);
    return { kind: 'list', listName, listTotal: listWords.length,
      listLearned: listWords.filter(w => state.records[w.id]).length, completedLists,
      newWords: listWords.filter(w => !state.records[w.id]) };
  }
  const today = state.days[dateKey(now)] || { newIds: [] };
  const nonCoreIds = new Set(words.filter(w => w.category !== 'core').map(w => w.id));
  const todayNew = today.newIds.filter(id => nonCoreIds.has(id)).length;
  // The goal determines a comfortable batch size, never a daily ceiling.
  const batch = todayNew < state.settings.goal ? state.settings.goal - todayNew : state.settings.goal;
  return { kind: 'daily', todayNew, completedLists,
    newWords: selected.filter(w => w.category !== 'core' && !state.records[w.id]).slice(0, batch) };
}

function buildQueue(words, state, mode = 'daily', now = Date.now()) {
  const selected = selectWords(words, state.settings.category);
  if (mode === 'favorites') return words.filter(w => state.favorites[w.id]).map(w => w.id);
  if (mode === 'daily') {
    const chosen = plans.resolve(words, state);
    if (chosen) return chosen.words.map(w => w.id);
  }
  const due = selected.filter(w => state.records[w.id] && state.records[w.id].due <= now)
    .sort((a, b) => state.records[a.id].due - state.records[b.id].due).map(w => w.id);
  if (mode === 'review') return due;
  return due.concat(learningPlan(words, state, now).newWords.map(w => w.id));
}

function rate(state, id, rating, now = Date.now()) {
  if (!['again', 'hard', 'good'].includes(rating)) throw new Error('无效的记忆反馈');
  const next = JSON.parse(JSON.stringify(state));
  const prev = state.records[id];
  let stage = prev ? prev.stage : 0;
  let due;
  if (rating === 'again') { stage = 0; due = now + 10 * 60000; }
  else if (rating === 'hard') { stage = Math.max(0, stage - 1); due = now + DAY; }
  else { due = now + INTERVALS[Math.min(stage, INTERVALS.length - 1)] * DAY; stage = Math.min(stage + 1, INTERVALS.length); }
  next.records[id] = { stage, due, last: now, reviews: (prev ? prev.reviews : 0) + 1,
    lapses: (prev ? prev.lapses : 0) + (rating === 'again' ? 1 : 0), rating };
  const key = dateKey(now);
  const day = next.days[key] || { ids: [], newIds: [], answers: 0 };
  if (!day.ids.includes(id)) day.ids.push(id);
  if (!prev && !day.newIds.includes(id)) day.newIds.push(id);
  day.answers += 1;
  next.days[key] = day;
  return next;
}

function summary(words, state, now = Date.now()) {
  const selected = selectWords(words, state.settings.category);
  const today = state.days[dateKey(now)] || { ids: [], newIds: [], answers: 0 };
  const learned = selected.filter(w => state.records[w.id]).length;
  const mastered = selected.filter(w => state.records[w.id] && state.records[w.id].stage >= 4).length;
  const due = selected.filter(w => state.records[w.id] && state.records[w.id].due <= now).length;
  const waiting = selected.filter(w => state.records[w.id] && state.records[w.id].due > now && state.records[w.id].due < now + DAY).length;
  const plan = learningPlan(words, state, now);
  let streak = 0;
  const cursor = new Date(now);
  if (!state.days[dateKey(cursor.getTime())]) cursor.setDate(cursor.getDate() - 1);
  while (state.days[dateKey(cursor.getTime())]) { streak += 1; cursor.setDate(cursor.getDate() - 1); }
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const count = (state.days[dateKey(d.getTime())] || { ids: [] }).ids.length;
    week.push({ label: i === 0 ? '今天' : `${d.getMonth() + 1}/${d.getDate()}`, count, height: Math.max(6, Math.round(Math.min(count / state.settings.goal, 1) * 120)) });
  }
  return { total: selected.length, learned, mastered, due, waiting, todayNew: today.newIds.length,
    planKind: plan.kind, manualPlan: !!plan.manual, planTitle: plan.title || plan.listName || '', listName: plan.listName || '', listTotal: plan.listTotal || 0,
    listLearned: plan.listLearned || 0, completedLists: plan.completedLists, dailyNew: plan.todayNew || 0,
    hasNew: plan.newWords.length > 0,
    planPercent: plan.kind === 'list' || plan.manual ? (plan.listTotal ? Math.round(plan.listLearned / plan.listTotal * 100) : 0) : Math.min(100, Math.round(plan.todayNew / state.settings.goal * 100)),
    todayCount: today.ids.length, streak, days: Object.keys(state.days).length,
    favoriteCount: Object.keys(state.favorites).length, percent: selected.length ? Math.round(learned / selected.length * 100) : 0,
    goalPercent: Math.min(100, Math.round(today.newIds.length / state.settings.goal * 100)), week };
}

// Reject corrupt/imported data before it can overwrite a working learning record.
function validateState(value, words) {
  if (!value || value.version !== 1 || !value.settings || !value.records || !value.favorites || !value.days) throw new Error('备份格式不正确');
  const s = value.settings;
  if (typeof s.name !== 'string' || s.name.length > 24 || typeof s.note !== 'string' || s.note.length > 150 ||
      !Number.isInteger(s.goal) || s.goal < 5 || s.goal > 100 || !['core', 'occasional', 'basic', 'supplement', 'all'].includes(s.category)) throw new Error('学习设置不正确');
  const ids = new Set(words.map(w => w.id));
  for (const [id, r] of Object.entries(value.records)) {
    if (!ids.has(id) || !r || !Number.isInteger(r.stage) || r.stage < 0 || r.stage > 6 ||
      !Number.isFinite(r.due) || r.due < 0 || !Number.isFinite(r.last) || r.last < 0 ||
      !Number.isInteger(r.reviews) || r.reviews < 1 || !Number.isInteger(r.lapses) || r.lapses < 0 ||
      !['again', 'hard', 'good'].includes(r.rating)) throw new Error('学习记录不正确');
  }
  for (const [id, flag] of Object.entries(value.favorites)) if (!ids.has(id) || flag !== true) throw new Error('收藏记录不正确');
  for (const [key, d] of Object.entries(value.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !d || !Array.isArray(d.ids) || !Array.isArray(d.newIds) ||
        d.ids.some(id => !ids.has(id)) || d.newIds.some(id => !d.ids.includes(id)) ||
        new Set(d.ids).size !== d.ids.length || new Set(d.newIds).size !== d.newIds.length ||
        !Number.isInteger(d.answers) || d.answers < d.ids.length) throw new Error('每日记录不正确');
  }
  const restored = JSON.parse(JSON.stringify(value));
  restored.settings.name = FIXED_NAME;
  if (restored.brush) require('./swipe').validateSession(restored.brush, words);
  if (restored.dictation) require('./swipe').validateSession(restored.dictation, words);
  plans.validate(restored, words);
  return restored;
}

module.exports = { DAY, FIXED_NAME, dateKey, freshState, selectWords, learningPlan, buildQueue, rate, summary, validateState };
