function history(state) {
  const saved = (state.planHistory || []).slice();
  // Older versions kept daily records and only the latest swipe-plan snapshot.
  if (state.brush && !saved.some(p => p.ids.join(',') === state.brush.originalIds.join(','))) {
    saved.push({ id: 'legacy-brush', title: state.brush.title + ' · 上次刷卡计划', ids: state.brush.originalIds, at: 0 });
  }
  for (const date of Object.keys(state.days).sort().reverse()) {
    if (state.days[date].ids.length) saved.push({ id: 'day:' + date, title: date + ' · 学习记录', ids: state.days[date].ids, at: new Date(date + 'T12:00:00').getTime() });
  }
  return saved.sort((a, b) => b.at - a.at);
}

function resolve(words, state) {
  const selection = state.planSelection;
  if (!selection || selection.type === 'auto') return null;
  if (selection.type === 'list') {
    const title = 'Word List ' + selection.id;
    return { title, kind: 'list', words: words.filter(w => w.category === 'core' && w.group === title) };
  }
  const record = history(state).find(p => p.id === selection.id);
  if (!record) return null;
  const byId = Object.fromEntries(words.map(w => [w.id, w]));
  return { title: record.title, kind: 'history', words: record.ids.map(id => byId[id]).filter(Boolean) };
}

function record(state, ids, title, source, now = Date.now()) {
  const unique = [...new Set(ids)];
  const saved = (state.planHistory || []).slice();
  const existing = saved.findIndex(p => p.ids.join(',') === unique.join(',') && p.title === title);
  const plan = { id: existing >= 0 ? saved[existing].id : 'plan:' + now + ':' + saved.length,
    title, ids: unique, source, at: now };
  if (existing >= 0) saved.splice(existing, 1);
  saved.unshift(plan);
  return Object.assign({}, state, { planHistory: saved });
}

function nextSelection(state) {
  const selected = state.planSelection;
  const planSelection = selected && selected.type === 'list' && selected.id < 30 ?
    { type: 'list', id: selected.id + 1 } : { type: 'auto' };
  return Object.assign({}, state, { planSelection });
}

function validate(state, words) {
  const ids = new Set(words.map(w => w.id));
  if (state.planHistory !== undefined && (!Array.isArray(state.planHistory) || state.planHistory.some(p =>
    !p || typeof p.id !== 'string' || typeof p.title !== 'string' || !Number.isFinite(p.at) || !Array.isArray(p.ids) || !p.ids.length || p.ids.some(id => !ids.has(id)) || new Set(p.ids).size !== p.ids.length))) throw new Error('历史计划无效');
  const s = state.planSelection;
  if (s && !(s.type === 'auto' || s.type === 'list' && Number.isInteger(s.id) && s.id >= 1 && s.id <= 30 ||
      s.type === 'history' && history(state).some(p => p.id === s.id))) throw new Error('所选计划无效');
  const request = state.dictationRequest;
  if (request && (typeof request.title !== 'string' || !Array.isArray(request.ids) || !request.ids.length || request.ids.some(id => !ids.has(id)))) throw new Error('听写计划无效');
}

module.exports = { history, resolve, record, nextSelection, validate };
