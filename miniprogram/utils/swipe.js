function makeSession(ids, title) {
  const unique = [...new Set(ids)];
  return { version: 1, title, phase: 'cards', originalIds: unique,
    deck: unique.map((id, i) => ({ id, key: i + 1, rating: '' })), index: 0,
    nextKey: unique.length + 1, questions: [], quizIndex: 0, results: [] };
}

function insertRepeat(session, id, target) {
  let at = Math.min(target, session.deck.length);
  while (at < session.deck.length &&
    ((session.deck[at - 1] || {}).id === id || session.deck[at].id === id)) at++;
  if ((session.deck[at - 1] || {}).id === id) {
    session.deck.splice(at++, 0, { id: null, key: session.nextKey++, rating: '' });
  }
  session.deck.splice(at, 0, { id, key: session.nextKey++, rating: '' });
}

function advance(value, rating) {
  const session = JSON.parse(JSON.stringify(value));
  const card = session.deck[session.index];
  let feedback = null;
  if (card.id && (!card.rating || (rating !== 'good' && rating !== card.rating))) {
    const oldCount = card.rating === 'again' ? 2 : card.rating === 'hard' ? 1 : 0;
    const count = rating === 'again' ? 2 : rating === 'hard' ? 1 : 0;
    card.rating = rating;
    feedback = { id: card.id, rating };
    for (let i = oldCount; i < count; i++) insertRepeat(session, card.id, session.index + 4 + i * 3);
  }
  session.index++;
  if (session.index >= session.deck.length) session.phase = 'overview';
  return { session, feedback };
}

function startQuiz(value, random = Math.random) {
  const session = JSON.parse(JSON.stringify(value));
  const ids = session.originalIds.slice();
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const firstKind = random() < .5 ? 0 : 1;
  session.questions = ids.map((id, i) => ({ id, kind: (i + firstKind) % 2 ? 'meaning' : 'sound', plays: 0, word: '', meaning: '' }));
  session.quizIndex = 0; session.results = []; session.phase = 'quiz';
  return session;
}

function normalize(text) {
  return String(text).normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
}

function submitQuestion(value, word, meaning, byId) {
  const session = JSON.parse(JSON.stringify(value));
  const question = session.questions[session.quizIndex];
  question.word = String(word || '').trim(); question.meaning = String(meaning || '').trim();
  session.quizIndex++;
  // Do not calculate or expose any correctness until the whole plan is submitted.
  if (session.quizIndex === session.questions.length) {
    session.results = session.questions.map(q => ({ id: q.id, kind: q.kind, word: q.word, meaning: q.meaning,
      spellingCorrect: normalize(q.word) === normalize(byId[q.id].word),
      meaningCorrect: null }));
    session.phase = 'results';
  }
  return session;
}

function validateSession(session, words) {
  const ids = new Set(words.map(w => w.id));
  if (!session || session.version !== 1 || typeof session.title !== 'string' ||
      !['cards', 'overview', 'quiz', 'results', 'done', 'cardsDone'].includes(session.phase) ||
      !Array.isArray(session.originalIds) || !session.originalIds.length || session.originalIds.some(id => !ids.has(id)) ||
      new Set(session.originalIds).size !== session.originalIds.length || !Array.isArray(session.deck) ||
      !session.deck.length || !Number.isInteger(session.index) || session.index < 0 || session.index > session.deck.length ||
      (session.phase === 'cards' && session.index >= session.deck.length) || !Number.isInteger(session.nextKey) ||
      !Array.isArray(session.questions) || !Array.isArray(session.results) || !Number.isInteger(session.quizIndex)) throw new Error('刷刷刷记录无效');
  const members = new Set(session.originalIds);
  if (session.phase === 'cardsDone' && (session.index !== session.deck.length || session.questions.length || session.results.length)) throw new Error('刷卡完成记录无效');
  const keys = new Set();
  for (const card of session.deck) {
    if (!card || (card.id !== null && !members.has(card.id)) || !Number.isInteger(card.key) || keys.has(card.key) ||
        !['', 'good', 'hard', 'again'].includes(card.rating)) throw new Error('刷卡记录无效');
    keys.add(card.key);
  }
  if (session.questions.some(q => !q || !members.has(q.id) || !['sound', 'meaning'].includes(q.kind) ||
      !Number.isInteger(q.plays) || q.plays < 0 || q.plays > 3 || typeof q.word !== 'string' || typeof q.meaning !== 'string') ||
      session.quizIndex < 0 || session.quizIndex > session.questions.length) throw new Error('听写记录无效');
  if (['quiz', 'results', 'done'].includes(session.phase) && (session.questions.length !== members.size ||
      new Set(session.questions.map(q => q.id)).size !== members.size || (session.phase === 'quiz' && session.quizIndex >= members.size))) throw new Error('听写题目不完整');
  if (['results', 'done'].includes(session.phase) && (session.results.length !== members.size ||
      session.results.some(r => !r || !members.has(r.id) || typeof r.spellingCorrect !== 'boolean' ||
        ![true, false, null].includes(r.meaningCorrect)))) throw new Error('听写结果无效');
  return session;
}

module.exports = { makeSession, advance, startQuiz, submitQuestion, normalize, validateSession };
