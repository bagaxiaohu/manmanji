const test = require('node:test');
const assert = require('node:assert/strict');
const plans = require('../miniprogram/utils/plans');
const engine = require('../miniprogram/utils/learning');
const { words } = require('../miniprogram/data/words');

test('selected lists include previously learned words and next-plan moves to the next list', () => {
  let state = engine.freshState();
  const list = words.filter(w => w.group === 'Word List 3');
  state = engine.rate(state, list[0].id, 'good');
  state.planSelection = { type: 'list', id: 3 };
  assert.deepEqual(engine.buildQueue(words, state), list.map(w => w.id));
  assert.equal(engine.learningPlan(words, state).listLearned, 1);
  assert.equal(engine.learningPlan(words, plans.nextSelection(state)).listName, 'Word List 4');
});

test('plan history preserves exact word order, refreshes repeat visits, and restores from backup', () => {
  const ids = [words[5].id, words[2].id, words[1].id];
  let state = plans.record(engine.freshState(), ids, 'previous', 'normal', 100);
  state = plans.record(state, ids, 'previous', 'swipe', 200);
  assert.equal(state.planHistory.length, 1);
  state.planSelection = { type: 'history', id: state.planHistory[0].id };
  assert.deepEqual(engine.buildQueue(words, state), ids);
  assert.deepEqual(engine.buildQueue(words, engine.validateState(JSON.parse(JSON.stringify(state)), words)), ids);
});

test('old daily records remain selectable without inventing old batch boundaries', () => {
  const state = engine.rate(engine.freshState(), words[0].id, 'good', new Date(2026, 9, 19, 12).getTime());
  const old = plans.history(state).find(p => p.id === 'day:2026-10-19');
  assert.ok(old.title.includes('学习记录'));
  state.planSelection = { type: 'history', id: old.id };
  assert.deepEqual(engine.buildQueue(words, state), [words[0].id]);
});

test('invalid plan selections and unknown historical words cannot overwrite valid progress', () => {
  const state = engine.freshState();
  state.planSelection = { type: 'list', id: 31 };
  assert.throws(() => engine.validateState(state, words));
  state.planSelection = { type: 'auto' };
  state.planHistory = [{ id: 'bad', title: 'bad', at: 1, ids: ['unknown'] }];
  assert.throws(() => engine.validateState(state, words));
});
