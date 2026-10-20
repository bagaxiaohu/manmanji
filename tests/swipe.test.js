const test = require('node:test');
const assert = require('node:assert/strict');
const swipe = require('../miniprogram/utils/swipe');
const { words } = require('../miniprogram/data/words');
const byId = Object.fromEntries(words.map(w => [w.id, w]));
const ids = words.slice(0, 9).map(w => w.id);

test('up adds two separated repetitions; down adds one; original plan stays unique', () => {
  const initial = swipe.makeSession(ids, 'test');
  const { session } = swipe.advance(initial, 'again');
  assert.equal(initial.deck.length, 9, 'transaction must not mutate the saved session');
  assert.equal(session.deck.filter(c => c.id === ids[0]).length, 3);
  assert.equal(session.originalIds.length, 9);
  for (let i = 1; i < session.deck.length; i++) assert.notEqual(session.deck[i].id, session.deck[i - 1].id);
  const vague = swipe.advance(session, 'hard').session;
  assert.equal(vague.deck.filter(c => c.id === ids[1]).length, 2);
  swipe.validateSession(vague, words);
});

test('a lone word gets gap cards rather than adjacent duplicate word cards', () => {
  const s = swipe.advance(swipe.makeSession([ids[0]], 'single'), 'again').session;
  assert.deepEqual(s.deck.map(c => c.id), [ids[0], null, ids[0], null, ids[0]]);
});

test('revisiting a graded occurrence does not create extra reviews or repeats', () => {
  const first = swipe.advance(swipe.makeSession(ids, 'test'), 'again').session;
  first.index = 0;
  const repeated = swipe.advance(first, 'again');
  assert.equal(repeated.feedback, null);
  assert.equal(repeated.session.deck.length, first.deck.length);
  first.index = 0;
  assert.equal(swipe.advance(first, 'good').feedback, null);
});

test('both dictation kinds exist and correctness is calculated only after full submission', () => {
  let s = swipe.startQuiz(swipe.makeSession(ids, 'test'), () => .3);
  assert.deepEqual(new Set(s.questions.map(q => q.kind)), new Set(['sound', 'meaning']));
  const first = s.questions[0];
  s = swipe.submitQuestion(s, 'WRONG', '', byId);
  assert.equal(s.phase, 'quiz');
  assert.deepEqual(s.results, []);
  for (let i = 1; i < ids.length; i++) {
    const q = s.questions[s.quizIndex];
    s = swipe.submitQuestion(s, '  ' + byId[q.id].word.toUpperCase() + ' ', '含义由用户核对', byId);
  }
  assert.equal(s.phase, 'results');
  assert.equal(s.results.length, ids.length);
  assert.equal(s.results.find(r => r.id === first.id).spellingCorrect, false);
  assert.ok(s.results.filter(r => r.id !== first.id).every(r => r.spellingCorrect));
  assert.ok(s.results.every(r => r.meaningCorrect === null), 'both question types require meaning self-review');
  swipe.validateSession(s, words);
});

test('audio replay counts survive snapshots and invalid counts are rejected', () => {
  const s = swipe.startQuiz(swipe.makeSession(ids, 'test'));
  s.questions[0].plays = 3;
  assert.equal(swipe.validateSession(JSON.parse(JSON.stringify(s)), words).questions[0].plays, 3);
  s.questions[0].plays = 4;
  assert.throws(() => swipe.validateSession(s, words));
});
