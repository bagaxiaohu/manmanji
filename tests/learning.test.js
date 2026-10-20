const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../miniprogram/utils/learning');
const { words, report } = require('../miniprogram/data/words');
const NOW = new Date(2026, 9, 19, 12).getTime();
const DAY = engine.DAY;
const first = words[0].id;

test('all supplied entries retain complete fields and unique stable IDs', () => {
  assert.equal(words.length, 6026);
  assert.equal(new Set(words.map(w => w.id)).size, 6026);
  assert.equal(new Set(words.map(w => w.word.toLowerCase())).size, report.uniqueHeadwords);
  for (const w of words) {
    assert.ok(w.word && w.phonetic.startsWith('/') && /[\u4e00-\u9fff]/.test(w.meaning));
    assert.ok(w.source && w.paragraph > 0);
  }
  const multi = words.filter(w => (w.phonetic.match(/\//g) || []).length > 2);
  assert.ok(multi.length > 0, 'multiple pronunciations are preserved');
  assert.ok(words.find(w => w.word === 'miss').meaning.includes('未击中'), 'multiline senses preserved');
});

test('non-list learning prioritizes due words, fills the daily goal, and continues past it', () => {
  let state = engine.freshState();
  state.settings.category = 'basic';
  const initial = engine.buildQueue(words, state, 'daily', NOW);
  assert.equal(initial.length, 20);
  for (const id of initial.slice(0, 5)) state = engine.rate(state, id, 'good', NOW - DAY);
  state = engine.rate(state, initial[5], 'good', NOW);
  const queue = engine.buildQueue(words, state, 'daily', NOW);
  assert.deepEqual(queue.slice(0, 5), initial.slice(0, 5));
  assert.equal(queue.length, 24);
  assert.equal(engine.summary(words, state, NOW).todayNew, 1);
  for (const id of queue.slice(5)) state = engine.rate(state, id, 'good', NOW);
  assert.equal(engine.summary(words, state, NOW).todayNew, 20);
  const extra = engine.buildQueue(words, state, 'daily', NOW);
  assert.deepEqual(extra.slice(0, 5), initial.slice(0, 5));
  assert.equal(extra.length, 25);
  assert.ok(extra.slice(5).every(id => !state.records[id]));
  state = engine.rate(state, extra[5], 'good', NOW);
  assert.equal(engine.summary(words, state, NOW).dailyNew, 21);
  assert.equal(engine.buildQueue(words, state, 'daily', NOW).filter(id => !state.records[id]).length, 20);
});

test('forgotten words wait ten minutes; good answers grow spacing; hard answers return tomorrow', () => {
  let state = engine.freshState();
  const before = JSON.stringify(state);
  const again = engine.rate(state, first, 'again', NOW);
  assert.equal(JSON.stringify(state), before, 'rating must not mutate persisted state');
  assert.equal(again.records[first].due, NOW + 600000);
  assert.equal(engine.buildQueue(words, again, 'review', NOW + 599999).length, 0);
  assert.deepEqual(engine.buildQueue(words, again, 'review', NOW + 600000), [first]);
  for (const interval of [1, 3, 7, 14, 30, 60, 60]) {
    state = engine.rate(state, first, 'good', NOW);
    assert.equal(state.records[first].due, NOW + interval * DAY);
  }
  state = engine.rate(state, first, 'hard', NOW);
  assert.equal(state.records[first].due, NOW + DAY);
  state = engine.rate(state, first, 'again', NOW);
  assert.equal(state.records[first].stage, 0);
  assert.equal(state.records[first].lapses, 1);
});

test('repeated answers count one daily word; midnight and missed days update correctly', () => {
  let state = engine.rate(engine.freshState(), first, 'again', NOW - DAY);
  state = engine.rate(state, first, 'good', NOW - DAY + 600000);
  assert.equal(engine.summary(words, state, NOW - DAY).todayCount, 1);
  assert.equal(engine.summary(words, state, NOW - DAY).todayNew, 1);
  assert.equal(engine.summary(words, state, NOW).streak, 1);
  state = engine.rate(state, first, 'good', NOW);
  assert.equal(engine.summary(words, state, NOW).streak, 2);
  assert.equal(engine.summary(words, state, NOW).todayNew, 0);
  assert.equal(engine.summary(words, state, NOW + 3 * DAY).streak, 0);
  assert.equal(engine.buildQueue(words, state, 'daily', NOW + DAY).filter(id => !state.records[id]).length,
    words.filter(w => w.group === 'Word List 1').length - 1);
});

test('Word Lists use whole groups, resume old progress, and advance without a daily ceiling', () => {
  let state = engine.freshState();
  state.settings.goal = 5;
  const list1 = words.filter(w => w.group === 'Word List 1');
  const list2 = words.filter(w => w.group === 'Word List 2');
  assert.deepEqual(engine.buildQueue(words, state, 'daily', NOW), list1.map(w => w.id));
  for (const w of list1.slice(0, 20)) state = engine.rate(state, w.id, 'good', NOW);
  assert.deepEqual(engine.buildQueue(words, state, 'daily', NOW), list1.slice(20).map(w => w.id));
  assert.equal(engine.summary(words, state, NOW).listLearned, 20);
  for (const w of list1.slice(20)) state = engine.rate(state, w.id, 'good', NOW);
  assert.deepEqual(engine.buildQueue(words, state, 'daily', NOW), list2.map(w => w.id));
  assert.equal(engine.summary(words, state, NOW).completedLists, 1);
  assert.equal(engine.summary(words, state, NOW).listName, 'Word List 2');
  assert.equal(engine.validateState(JSON.parse(JSON.stringify(state)), words).settings.goal, 5);
});

test('all books finish Word Lists before non-list batches, and list learning does not consume the non-list goal', () => {
  let state = engine.freshState();
  state.settings.category = 'all';
  assert.ok(engine.buildQueue(words, state, 'daily', NOW).every(id => words.find(w => w.id === id).group === 'Word List 1'));
  for (const w of words.filter(w => w.category === 'core')) state = engine.rate(state, w.id, 'good', NOW);
  const queue = engine.buildQueue(words, state, 'daily', NOW);
  assert.equal(queue.length, 20);
  assert.ok(queue.every(id => words.find(w => w.id === id).category !== 'core'));
  assert.equal(engine.summary(words, state, NOW).dailyNew, 0);
  state.settings.category = 'core';
  assert.deepEqual(engine.buildQueue(words, state, 'daily', NOW), []);
});

test('books and favorites have independent filtering and preserve records on switches', () => {
  const state = engine.freshState();
  const basic = words.find(w => w.category === 'basic');
  state.favorites[basic.id] = true;
  assert.deepEqual(engine.buildQueue(words, state, 'favorites', NOW), [basic.id]);
  state.settings.category = 'basic';
  assert.ok(engine.buildQueue(words, state, 'daily', NOW).every(id => words.find(w => w.id === id).category === 'basic'));
});

test('backup roundtrip works and corrupt backups are rejected', () => {
  const state = engine.rate(engine.freshState(), first, 'good', NOW);
  const copy = () => JSON.parse(JSON.stringify(state));
  assert.deepEqual(engine.validateState(copy(), words), state);
  for (const corrupt of [s => s.version = 2, s => s.settings.goal = 0, s => s.records[first].due = 'tomorrow',
    s => s.favorites.unknown = true, s => s.days[engine.dateKey(NOW)].ids.push('unknown'),
    s => s.records[first].stage = 100]) {
    const bad = copy(); corrupt(bad); assert.throws(() => engine.validateState(bad, words));
  }
});
