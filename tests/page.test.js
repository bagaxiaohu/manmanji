const test = require('node:test');
const assert = require('node:assert/strict');
const { words } = require('../miniprogram/data/words');
const audio = require('../miniprogram/utils/audio');
let spoken, stopped, destroyed, audioFailure;
audio.createPlayer = status => ({
  async play(word) { spoken.push(word.id); if (audioFailure) throw new Error(audioFailure); status('英式 · 测试音源'); },
  stop() { stopped++; }, destroy() { destroyed++; }
});
let definition;
global.Page = value => { definition = value; };
require('../miniprogram/pages/index/index');

function page(saved) {
  spoken = []; stopped = 0; destroyed = 0; audioFailure = '';
  let stored = saved;
  const instance = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) });
  instance.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const path = key.split('.'); let cursor = instance.data;
      for (const part of path.slice(0, -1)) cursor = cursor[part];
      cursor[path.at(-1)] = value;
    }
  };
  const modals = [], navigation = [];
  global.wx = { getStorageSync: () => stored, setStorageSync: (key, data) => { stored = JSON.parse(JSON.stringify(data)); }, showToast() {}, showModal(value) { modals.push(value); }, navigateTo(value) { navigation.push(value.url); } };
  instance.onLoad();
  return { instance, saved: () => stored, modals, navigation };
}
const event = dataset => ({ currentTarget: { dataset } });

test('learning flow saves answers, repeats forgotten card once, and survives reopening', () => {
  const { instance: p, saved } = page();
  p.state.settings.category = 'basic';
  p.state.settings.goal = 5;
  p.start(event({ mode: 'daily' }));
  const id = p.data.card.id;
  p.nextWord();
  assert.equal(p.position, 0, 'cannot answer while meaning is hidden');
  p.chooseRating(event({ rating: 'again' })); p.nextWord();
  assert.equal(p.queue.length, 6);
  for (let i = 0; i < 4; i++) { p.chooseRating(event({ rating: 'good' })); p.nextWord(); }
  assert.equal(p.data.card.id, id);
  p.chooseRating(event({ rating: 'again' })); p.nextWord();
  assert.equal(p.data.finished, true);
  assert.equal(p.data.completedCount, 5);
  assert.equal(p.data.completedAnswers, 6);
  assert.equal(p.queue.length, 6, 'no infinite repeat loop');
  const reopened = page(saved()).instance;
  assert.equal(reopened.data.stats.todayNew, 5);
  assert.equal(reopened.state.records[id].lapses, 2);
});

test('a failed save keeps the current card and in-memory learning state', () => {
  const p = page().instance;
  p.start(event({})); p.chooseRating(event({ rating: 'good' }));
  const before = JSON.stringify(p.state);
  global.wx.setStorageSync = () => { throw new Error('disk full'); };
  p.nextWord();
  assert.equal(p.position, 0);
  assert.equal(JSON.stringify(p.state), before);
  assert.equal(p.answering, false);
});

test('all recall choices reveal meaning without saving or advancing; next confirms the selected rating', () => {
  for (const rating of ['good', 'hard', 'again']) {
    const { instance: p, saved } = page();
    p.start(event({}));
    const id = p.data.card.id;
    assert.equal(p.data.revealed, false);
    p.chooseRating(event({ rating }));
    assert.equal(p.data.revealed, true);
    assert.equal(p.data.pendingRating, rating);
    assert.equal(p.position, 0);
    assert.equal(p.state.records[id], undefined);
    assert.equal(saved(), undefined);
    p.chooseRating(event({ rating: rating === 'good' ? 'hard' : 'good' }));
    assert.equal(p.data.pendingRating, rating, 'a second recall tap cannot change an already revealed card');
    p.nextWord();
    assert.equal(p.state.records[id].rating, rating);
    assert.equal(p.state.records[id].reviews, 1);
    assert.equal(p.position, 1);
    assert.equal(p.data.revealed, false);
    assert.equal(p.data.pendingRating, '');
    p.nextWord();
    assert.equal(p.position, 1, 'duplicate next tap cannot skip an unrevealed card');
    assert.equal(page(saved()).instance.state.records[id].rating, rating);
  }
});

test('correcting known or vague recall saves only a forgotten answer and schedules repetition', () => {
  for (const rating of ['good', 'hard']) {
    const p = page().instance;
    p.start(event({}));
    const id = p.data.card.id;
    p.chooseRating(event({ rating }));
    p.correctAnswer();
    assert.equal(p.position, 1, 'correction immediately advances without another next tap');
    assert.equal(p.data.revealed, false);
    assert.notEqual(p.data.card.id, id);
    assert.equal(p.state.records[id].rating, 'again');
    assert.equal(p.state.records[id].reviews, 1);
    assert.equal(p.state.records[id].lapses, 1);
    assert.equal(p.state.records[id].stage, 0);
    assert.equal(p.state.records[id].due - p.state.records[id].last, 600000);
    assert.equal(p.queue.at(-1), id);
    assert.equal(p.data.corrected, false, 'correction status resets for next card');
    p.correctAnswer();
    assert.equal(p.position, 1, 'duplicate correction cannot skip the next hidden card');
  }
});

test('unfinished recall is not persisted, and invalid choices cannot reveal the card', () => {
  const { instance: p, saved } = page();
  p.start(event({}));
  p.correctAnswer();
  p.chooseRating(event({ rating: 'invalid' }));
  assert.equal(p.data.revealed, false);
  p.chooseRating(event({ rating: 'again' }));
  p.correctAnswer();
  assert.equal(p.data.corrected, false, 'forgotten recall has no correction action');
  assert.equal(page(saved()).instance.data.stats.todayCount, 0);
});

test('a failed corrected save can be retried without losing the correction or double counting', () => {
  const p = page().instance;
  p.state.settings.category = 'basic';
  p.start(event({}));
  const id = p.data.card.id;
  p.chooseRating(event({ rating: 'good' }));
  const store = global.wx.setStorageSync;
  global.wx.setStorageSync = () => { throw new Error('disk full'); };
  p.correctAnswer();
  assert.equal(p.data.pendingRating, 'again');
  assert.equal(p.data.corrected, true);
  assert.equal(p.state.records[id], undefined);
  assert.equal(p.queue.length, 20);
  global.wx.setStorageSync = store;
  p.nextWord();
  assert.equal(p.state.records[id].reviews, 1);
  assert.equal(p.queue.length, 21);
  assert.equal(p.sessionAnswers, 1);
});

test('finishing a Word List offers the next List and keeps both available on the same day', () => {
  const p = page().instance;
  p.start(event({}));
  assert.equal(p.data.sessionTitle, 'Word List 1');
  const count = p.queue.length;
  assert.ok(count > 20);
  for (let i = 0; i < count; i++) { p.chooseRating(event({ rating: 'good' })); p.nextWord(); }
  assert.equal(p.data.finished, true);
  assert.equal(p.data.canContinue, true);
  assert.equal(p.data.continueLabel, '继续学习 Word List 2');
  p.start(event({ mode: 'daily' }));
  assert.equal(p.data.sessionTitle, 'Word List 2');
  assert.equal(p.data.card.group, 'Word List 2');
});

test('daily target completion still offers another batch through the page', () => {
  const p = page().instance;
  p.state.settings.category = 'supplement';
  p.state.settings.goal = 5;
  p.start(event({}));
  for (let i = 0; i < 5; i++) { p.chooseRating(event({ rating: 'good' })); p.nextWord(); }
  assert.equal(p.data.canContinue, true);
  p.endStudy();
  assert.equal(p.data.actionLabel, '目标已达成，继续学');
  p.start(event({}));
  assert.equal(p.queue.length, 5);
  p.chooseRating(event({ rating: 'good' })); p.nextWord();
  assert.equal(p.data.stats.dailyNew, 6);
});

test('library supports pagination, Chinese search, details, and persistent favorites', () => {
  const { instance: p, saved } = page();
  assert.equal(p.data.list.length, 40);
  p.loadMore(); assert.equal(p.data.list.length, 80);
  p.setData({ search: '焦虑' }); p.filterList();
  assert.ok(p.data.list.some(w => w.word === 'anxiety'));
  const id = p.data.list[0].id;
  p.openDetail(event({ id }));
  assert.equal(p.data.detail.id, id);
  p.toggleFavorite(event({ id }));
  assert.equal(p.data.detailFavorite, true);
  p.setData({ search: '', onlyFavorites: true }); p.filterList();
  assert.deepEqual(p.data.list.map(w => w.id), [id]);
  const restored = page(saved()).instance;
  assert.equal(restored.state.favorites[id], true);
});

test('corrupt local data cannot be overwritten silently', () => {
  const p = page({ version: 999 }).instance;
  assert.equal(p.data.storageError, true);
  p.toggleFavorite(event({ id: words[0].id }));
  assert.equal(Object.keys(p.state.favorites).length, 0);
});

test('normal study auto-pronounces each card, supports replay, and does not reveal answers', async () => {
  const p = page().instance;
  p.start(event({}));
  const first = p.data.card.id;
  assert.deepEqual(spoken, [first]);
  await p.playCard(); assert.deepEqual(spoken, [first, first]);
  assert.equal(p.data.revealed, false);
  assert.equal(p.position, 0);
  assert.deepEqual(p.state.records, {});
  p.chooseRating(event({ rating: 'good' })); p.nextWord();
  assert.equal(spoken.at(-1), p.data.card.id);
  assert.notEqual(p.data.card.id, first);
  p.onHide(); assert.ok(stopped > 0);
  p.endStudy();
  const count = spoken.length; await p.playCard(); assert.equal(spoken.length, count);
  p.onUnload(); assert.equal(destroyed, 1);
});

test('failed normal-study audio shows a retry reason without changing card progress', async () => {
  const p = page().instance;
  p.start(event({}));
  audioFailure = 'downloadFile 域名未配置';
  await p.playCard();
  assert.ok(p.data.audioStatus.includes('点击音标重试'));
  assert.ok(p.data.audioStatus.includes('域名未配置'));
  assert.equal(p.position, 0);
  assert.deepEqual(p.state.records, {});
});

test('home can select a whole Word List or restore automatic progression', () => {
  const p = page().instance;
  p.openPlanPicker(); assert.equal(p.data.planLists.length, 30);
  p.choosePlan(event({ type: 'list', id: '12' }));
  assert.equal(p.data.planBadge, 'Word List 12');
  p.start(event({})); assert.ok(p.queue.every(id => words.find(w => w.id === id).group === 'Word List 12'));
  p.endStudy(); p.choosePlan(event({ type: 'auto' }));
  assert.equal(p.state.planSelection.type, 'auto');
  assert.equal(p.data.planBadge, 'Word List 1');
});

test('normal completion records history and offers dictation of the completed batch', () => {
  const { instance: p, modals, navigation } = page();
  p.state.settings.category = 'basic'; p.state.settings.goal = 5;
  p.start(event({})); const studied = p.sessionIds.slice();
  for (let i = 0; i < 5; i++) { p.chooseRating(event({ rating: 'good' })); p.nextWord(); }
  assert.deepEqual(p.state.planHistory[0].ids, studied);
  const prompt = modals.find(m => m.title.includes('要听写'));
  assert.ok(prompt); prompt.success({ confirm: true });
  assert.deepEqual(p.state.dictationRequest.ids, studied);
  assert.ok(navigation.at(-1).includes('mode=dictation&request=1'));
  p.choosePlan(event({ type: 'history', id: p.state.planHistory[0].id }));
  p.endStudy(); p.start(event({}));
  assert.deepEqual(p.queue, studied);
});

test('learned-word count opens the current book learned list with pagination, search, details, and favorites', () => {
  const engine = require('../miniprogram/utils/learning');
  let state = engine.freshState();
  const learned = words.filter(w => w.category === 'core').slice(0, 44);
  for (const word of [...learned, words.find(w => w.category === 'basic')]) state = engine.rate(state, word.id, 'good');
  const p = page(state).instance;
  p.setData({ search: 'old search', onlyFavorites: true });
  p.openLearnedWords();
  assert.equal(p.data.tab, 'library');
  assert.equal(p.data.onlyLearned, true);
  assert.equal(p.data.totalMatches, p.data.stats.learned);
  assert.equal(p.data.totalMatches, 44);
  assert.equal(p.data.list.length, 40);
  p.loadMore(); assert.equal(p.data.list.length, 44);
  assert.ok(p.data.list.every(w => learned.some(expected => expected.id === w.id)));
  p.setData({ search: learned[0].word }); p.filterList();
  assert.ok(p.data.list.some(w => w.id === learned[0].id));
  p.openDetail(event({ id: learned[0].id }));
  assert.equal(p.data.detail.meaning, learned[0].meaning);
  p.toggleFavorite(event({ id: learned[0].id })); p.toggleFavoritesFilter();
  assert.deepEqual(p.data.list.map(w => w.id), [learned[0].id]);
  p.showFullLibrary();
  assert.equal(p.data.onlyLearned, false);
  assert.equal(p.data.totalMatches, 6026);
});

test('learned list handles an empty book and the library tab restores the full library', () => {
  const p = page().instance;
  p.openLearnedWords();
  assert.equal(p.data.totalMatches, 0);
  assert.deepEqual(p.data.list, []);
  p.switchTab(event({ tab: 'library' }));
  assert.equal(p.data.onlyLearned, false);
  assert.equal(p.data.totalMatches, 6026);
});

test('learned words are ordered by latest study time, including later review and filtered views', () => {
  const engine = require('../miniprogram/utils/learning');
  const entries = words.filter(w => w.category === 'core').slice(0, 3);
  let state = engine.freshState();
  for (let i = 0; i < 3; i++) state = engine.rate(state, entries[i].id, 'good', 1000 + i * 1000);
  const p = page(state).instance;
  p.openLearnedWords();
  assert.deepEqual(p.data.list.map(w => w.id), entries.slice().reverse().map(w => w.id));
  p.state = engine.rate(p.state, entries[0].id, 'hard', 9000);
  p.filterList();
  assert.equal(p.data.list[0].id, entries[0].id);
  p.toggleFavorite(event({ id: entries[0].id }));
  p.toggleFavorite(event({ id: entries[2].id }));
  p.toggleFavoritesFilter();
  assert.deepEqual(p.data.list.map(w => w.id), [entries[0].id, entries[2].id]);
  p.showFullLibrary();
  assert.deepEqual(p.data.list.slice(0, 3).map(w => w.id), entries.map(w => w.id), 'full library keeps book order');
});
