const test = require('node:test');
const assert = require('node:assert/strict');
const learning = require('../miniprogram/utils/learning');
const model = require('../miniprogram/utils/swipe');
const audio = require('../miniprogram/utils/audio');
let definition, playbackCount, playbackFail;
audio.createPlayer = () => ({ stop() {}, destroy() {}, async play() { playbackCount++; if (playbackFail) throw new Error('network'); } });
audio.prepare = async (words, callback) => { callback(words.length, words.length); return []; };
global.Page = value => { definition = value; };
require('../miniprogram/pages/swipe/index');
const { words } = require('../miniprogram/data/words');
const byId = Object.fromEntries(words.map(w => [w.id, w]));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(saved, options = {}) {
  let stored = saved;
  playbackCount = 0; playbackFail = false;
  const modals = [], redirects = [];
  global.wx = { getStorageSync: () => stored, setStorageSync: (k, v) => { stored = JSON.parse(JSON.stringify(v)); }, showToast() {}, showModal(value) { modals.push(value); }, navigateBack() {}, redirectTo(value) { redirects.push(value.url); } };
  const p = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) });
  p.setData = patch => Object.assign(p.data, patch);
  p.onLoad(options); await tick();
  return { p, saved: () => stored, modals, redirects };
}

test('cards auto-pronounce, backtracking does not count again, and failed saves do not advance', async () => {
  const { p } = await fixture();
  assert.equal(p.data.phase, 'cards');
  assert.equal(playbackCount, 1);
  p.nextCard(); await tick();
  const answers = p.state.days[learning.dateKey()].answers;
  p.previous(); await tick(); p.nextCard(); await tick();
  assert.equal(p.state.days[learning.dateKey()].answers, answers);
  global.wx.setStorageSync = () => { throw new Error('disk full'); };
  const position = p.session.index;
  p.forgetCard();
  assert.equal(p.session.index, position);
});

test('autoplay counts toward three listens; reopening never resets the limit', async () => {
  const state = learning.freshState();
  state.brush = model.startQuiz(model.makeSession(words.slice(0, 2).map(w => w.id), 'test'), () => .1);
  const { p, saved } = await fixture(state);
  p.syncView(true); await tick();
  assert.equal(p.data.plays, 1);
  await p.playQuestion(); await p.playQuestion(); await p.playQuestion();
  assert.equal(p.data.plays, 3);
  assert.equal(playbackCount, 3);
  const reopened = await fixture(saved());
  assert.equal(reopened.p.data.plays, 3);
  await reopened.p.playQuestion();
  assert.equal(playbackCount, 0);
});

test('failed playback does not consume a listen and early next leaves grading until the end', async () => {
  const state = learning.freshState();
  state.brush = model.startQuiz(model.makeSession(words.slice(0, 2).map(w => w.id), 'test'), () => .1);
  const { p } = await fixture(state);
  playbackFail = true; await p.playQuestion();
  assert.equal(p.data.plays, 0);
  playbackFail = false;
  p.nextQuestion(); await tick();
  assert.equal(p.data.phase, 'quiz'); assert.deepEqual(p.session.results, []);
  assert.deepEqual(p.data.results, []);
  assert.equal(p.data.card, null);
  p.nextQuestion(); await tick();
  assert.equal(p.data.phase, 'results');
  assert.ok(p.session.results.every(r => !r.spellingCorrect));
  assert.ok(p.session.questions.every(q => q.word === ''));
});

test('final self-review saves listening results and preserves main learning state', async () => {
  const state = learning.freshState();
  state.brush = model.startQuiz(model.makeSession(words.slice(0, 2).map(w => w.id), 'test'), () => .1);
  while (state.brush.phase === 'quiz') {
    const q = state.brush.questions[state.brush.quizIndex];
    state.brush = model.submitQuestion(state.brush, byId[q.id].word, '解释', byId);
  }
  const { p } = await fixture(state);
  for (const r of p.session.results) p.markMeaning({ currentTarget: { dataset: { id: r.id, correct: 'yes' } } });
  p.finishReview(); assert.equal(p.data.phase, 'done');
  assert.equal(p.data.correct, 2);
  assert.ok(words.slice(0, 2).every(w => p.state.records[w.id].rating === 'good'));
  learning.validateState(p.state, words);
});

test('leaving a quiz saves unfinished input and preserves listen counts without grading', async () => {
  const state = learning.freshState();
  state.brush = model.startQuiz(model.makeSession(words.slice(0, 2).map(w => w.id), 'test'));
  const { p, saved } = await fixture(state);
  p.inputWord({ detail: { value: 'unfinished' } });
  p.inputMeaning({ detail: { value: '还没写完' } });
  await p.playQuestion();
  p.onHide();
  const reopened = await fixture(saved());
  assert.equal(reopened.p.data.draftWord, 'unfinished');
  assert.equal(reopened.p.data.draftMeaning, '还没写完');
  assert.equal(reopened.p.data.plays, 1);
  assert.deepEqual(reopened.p.data.results, []);
});

test('Chinese-clue questions retain the full written meaning for end-of-plan self-review', async () => {
  const state = learning.freshState();
  state.brush = model.startQuiz(model.makeSession([words[0].id], 'meaning test'), () => .9);
  assert.equal(state.brush.questions[0].kind, 'meaning');
  const { p, saved } = await fixture(state);
  p.inputWord({ detail: { value: words[0].word } });
  p.inputMeaning({ detail: { value: '进步；进展；促进；预先的' } });
  p.nextQuestion();
  assert.equal(p.session.results[0].meaning, '进步；进展；促进；预先的');
  assert.equal(p.session.results[0].meaningCorrect, null);
  const reopened = await fixture(saved());
  assert.equal(reopened.p.data.results[0].meaning, '进步；进展；促进；预先的');
  reopened.p.markMeaning({ currentTarget: { dataset: { id: words[0].id, correct: 'no' } } });
  reopened.p.finishReview();
  assert.equal(reopened.p.state.records[words[0].id].rating, 'again');
});

test('card gestures navigate, schedule repeats, and discard cancelled touch sequences', async () => {
  const { p } = await fixture();
  const gesture = (dx, dy) => {
    p.touchStart({ touches: [{ clientX: 200, clientY: 450 }] });
    p.touchEnd({ changedTouches: [{ clientX: 200 + dx, clientY: 450 + dy }] });
  };
  gesture(-100, 0); assert.equal(p.session.index, 1);
  gesture(100, 0); assert.equal(p.session.index, 0);
  const before = p.session.deck.length;
  gesture(0, -100); assert.equal(p.session.deck.length, before + 2);
  gesture(0, 100); assert.equal(p.session.deck.length, before + 3);
  const index = p.session.index;
  p.touchStart({ touches: [{ clientX: 200, clientY: 450 }] }); p.touchCancel();
  p.touchEnd({ changedTouches: [{ clientX: 0, clientY: 450 }] });
  assert.equal(p.session.index, index);
});

test('partial self-review can finish without assuming unassessed meanings are correct or wrong', async () => {
  const selected = words.slice(0, 3);
  let state = learning.freshState();
  for (const word of selected) state = learning.rate(state, word.id, 'good');
  const untouched = JSON.parse(JSON.stringify(state.records[selected[0].id]));
  state.brush = model.startQuiz(model.makeSession(selected.map(w => w.id), 'partial review'));
  while (state.brush.phase === 'quiz') {
    const q = state.brush.questions[state.brush.quizIndex];
    state.brush = model.submitQuestion(state.brush, q.id === selected[1].id ? 'wrong' : byId[q.id].word, '释义', byId);
  }
  const { p, saved } = await fixture(state);
  p.markMeaning({ currentTarget: { dataset: { id: selected[2].id, correct: 'yes' } } });
  p.finishReview();
  assert.equal(p.data.phase, 'done');
  assert.equal(p.data.checked, 1);
  assert.deepEqual(p.state.records[selected[0].id], untouched);
  assert.equal(p.state.records[selected[1].id].rating, 'again');
  assert.equal(p.state.records[selected[2].id].reviews, 2);
  assert.equal((await fixture(saved())).p.data.phase, 'done');
});

test('a completed card plan can skip dictation, persist completion, and continue to the next list', async () => {
  const { p, saved } = await fixture();
  while (p.session.phase === 'cards') p.nextCard();
  assert.equal(p.data.phase, 'overview');
  const before = JSON.stringify(p.state.records);
  p.skipDictation();
  assert.equal(p.data.phase, 'cardsDone');
  assert.deepEqual(p.session.questions, []);
  assert.equal(JSON.stringify(p.state.records), before, 'skipping does not add dictation grades');
  learning.validateState(p.state, words);
  const reopened = await fixture(saved());
  assert.equal(reopened.p.data.phase, 'cardsDone');
  reopened.p.newPlan();
  assert.equal(reopened.p.session.title, 'Word List 2');
});

test('standalone dictation uses the selected list and preserves an unfinished swipe session', async () => {
  const state = learning.freshState();
  state.brush = model.makeSession(words.slice(0, 2).map(w => w.id), 'unfinished brush');
  state.planSelection = { type: 'list', id: 5 };
  const original = JSON.stringify(state.brush);
  const { p, saved } = await fixture(state, { mode: 'dictation' });
  assert.equal(p.data.phase, 'quiz'); assert.equal(p.data.dictationMode, true);
  assert.equal(p.session.title, 'Word List 5');
  assert.ok(p.session.questions.every(q => byId[q.id].group === 'Word List 5'));
  assert.equal(JSON.stringify(saved().brush), original);
  assert.ok(saved().dictation);
});

test('completed-plan dictation uses its exact snapshot after automatic planning advances', async () => {
  const state = learning.freshState();
  const ids = words.slice(0, 3).map(w => w.id);
  state.dictationRequest = { ids, title: '刚完成的三词' };
  const { p, saved } = await fixture(state, { mode: 'dictation', request: '1' });
  assert.deepEqual(new Set(p.session.questions.map(q => q.id)), new Set(ids));
  assert.equal(p.session.title, '刚完成的三词');
  assert.equal(saved().dictationRequest, undefined);
});

test('swipe completion records history, prompts, and hands off to a separate dictation entry', async () => {
  const { p, saved, modals, redirects } = await fixture();
  const ids = p.session.originalIds.slice();
  while (p.session.phase === 'cards') p.nextCard();
  assert.deepEqual(saved().planHistory[0].ids, ids);
  const prompt = modals.find(m => m.title.includes('要听写'));
  assert.ok(prompt); prompt.success({ confirm: true });
  assert.equal(saved().brush.phase, 'cardsDone');
  assert.deepEqual(saved().dictationRequest.ids, ids);
  assert.ok(redirects[0].includes('mode=dictation&request=1'));
  learning.validateState(saved(), words);
});
