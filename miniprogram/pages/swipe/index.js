const { words } = require('../../data/words');
const learning = require('../../utils/learning');
const swipe = require('../../utils/swipe');
const audio = require('../../utils/audio');
const plans = require('../../utils/plans');
const KEY = 'manmanji.learning.v1';
const byId = Object.fromEntries(words.map(w => [w.id, w]));

Page({
  data: { phase: 'loading', title: '刷刷刷', audioStatus: '', preparing: false, prepared: 0, planTotal: 0,
    missing: [], failureReason: '', failureDetails: '', domainBlocked: false, card: null, isGap: false, index: 0, total: 0, overview: [],
    draftWord: '', draftMeaning: '', plays: 0, questionKind: '', quizIndex: 0, quizTotal: 0,
    results: [], checked: 0, correct: 0, playing: false, questionAudioError: '', maleSpeechEnabled: require('../../config/speech').enabled },
  onLoad(options = {}) {
    this.cancelled = false;
    this.sessionKey = options.mode === 'dictation' ? 'dictation' : 'brush';
    this.setData({ dictationMode: this.sessionKey === 'dictation' });
    if (this.sessionKey === 'dictation' && wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: '听写' });
    this.player = audio.createPlayer(message => { if (!this.cancelled) this.setData({ audioStatus: message }); });
    try {
      const saved = wx.getStorageSync(KEY);
      this.state = saved ? learning.validateState(saved, words) : learning.freshState();
      if (this.sessionKey === 'dictation') { this.initializeDictation(options.request === '1'); return; }
      if (this.state.brush) {
        swipe.validateSession(this.state.brush, words);
        this.session = this.state.brush;
        const chosen = plans.resolve(words, this.state);
        if (chosen && chosen.words.map(w => w.id).join(',') !== this.session.originalIds.join(',')) {
          wx.showModal({ title: '切换到所选计划？', content: '当前还有上次的刷卡记录，可以继续上次，也可以开始新选的计划。', confirmText: '开始所选', cancelText: '继续上次', success: r => {
            if (r.confirm) this.beginPlan(); else { this.syncView(false); if (this.session.phase === 'cards') this.preparePlan(); }
          } }); return;
        }
        this.syncView(false);
        if (this.session.phase === 'cards') this.preparePlan();
      } else this.beginPlan();
    } catch (_) {
      this.setData({ phase: 'error' });
      wx.showModal({ title: '无法读取刷刷刷进度', content: '请回首页检查学习备份，原数据尚未覆盖。', showCancel: false });
    }
  },
  onHide() {
    if (this.session && this.session.phase === 'quiz') {
      const next = JSON.parse(JSON.stringify(this.session));
      const q = next.questions[next.quizIndex];
      q.word = this.data.draftWord; q.meaning = this.data.draftMeaning;
      this.save(next);
    }
    if (this.player) this.player.stop();
    this.playToken = (this.playToken || 0) + 1; this.setData({ playing: false });
  },
  onUnload() { this.cancelled = true; if (this.player) this.player.destroy(); },
  save(session, state = this.state) {
    if (this.sessionKey === 'brush' && session.phase === 'overview' && !session.historyRecorded) {
      state = plans.record(state, session.originalIds, session.title, 'swipe');
      session = Object.assign({}, session, { historyRecorded: true });
    }
    const next = Object.assign({}, state, { [this.sessionKey]: session });
    try { wx.setStorageSync(KEY, next); }
    catch (_) { wx.showToast({ title: '保存失败，当前卡片未前进，请重试', icon: 'none' }); return false; }
    this.state = next; this.session = session; return true;
  },
  beginPlan() {
    const ids = learning.buildQueue(words, this.state);
    if (!ids.length) {
      this.setData({ phase: 'empty' }); return;
    }
    const plan = learning.learningPlan(words, this.state);
    const session = swipe.makeSession(ids, plan.title || (plan.kind === 'list' ? plan.listName : '当前学习计划'));
    if (this.save(session)) { this.syncView(false); this.preparePlan(); }
  },
  initializeDictation(useRequest) {
    const request = useRequest ? this.state.dictationRequest : null;
    const plan = learning.learningPlan(words, this.state);
    let ids = request ? request.ids : learning.buildQueue(words, this.state);
    let title = request ? request.title : plan.title || (plan.kind === 'list' ? plan.listName : '当前学习计划');
    if (!ids.length) {
      const latest = plans.history(this.state)[0];
      if (latest) { ids = latest.ids; title = latest.title; }
    }
    const existing = this.state.dictation;
    const resume = () => { this.session = existing; this.syncView(false); };
    const create = () => {
      if (!ids.length) { this.setData({ phase: 'empty' }); return; }
      const state = Object.assign({}, this.state); delete state.dictationRequest;
      if (this.save(swipe.startQuiz(swipe.makeSession(ids, title)), state)) this.syncView();
    };
    if (existing && ['quiz', 'results'].includes(existing.phase)) {
      if (existing.originalIds.join(',') === ids.join(',')) { resume(); return; }
      wx.showModal({ title: '还有一组听写未完成', content: '可以继续上次听写，或开始当前所选计划。开始新组会替换未完成的听写记录。', confirmText: '开始所选', cancelText: '继续上次', success: r => r.confirm ? create() : resume() });
    } else create();
  },
  async preparePlan() {
    if (this.data.preparing) return;
    this.setData({ preparing: true, missing: [], missingLabel: '', prepared: 0, failureReason: '', failureDetails: '', domainBlocked: false });
    const missing = await audio.prepare(this.session.originalIds.map(id => byId[id]), (done, total) => {
      if (!this.cancelled) this.setData({ prepared: done, planTotal: total });
    }, () => this.cancelled, (word, error) => {
      if (!this.cancelled && (!this.data.failureReason || error.code === 'DOMAIN')) {
        this.setData({ failureReason: error.message, failureDetails: error.details || error.message, domainBlocked: error.code === 'DOMAIN' });
      }
    });
    if (this.cancelled) return;
    this.setData({ preparing: false, missing, missingLabel: missing.join('、') });
    if (!missing.length) this.syncView(true);
  },
  syncView(autoplay = true) {
    const s = this.session;
    this.player.stop();
    this.playToken = (this.playToken || 0) + 1;
    this.setData({ phase: s.phase, title: s.title, playing: false, audioStatus: '', questionAudioError: '',
      index: Math.min(s.index + 1, s.deck.length), total: s.deck.length,
      planTotal: s.originalIds.length, quizIndex: s.quizIndex + 1, quizTotal: s.questions.length });
    if (s.phase === 'cards') {
      const entry = s.deck[s.index];
      this.setData({ card: entry.id ? byId[entry.id] : null, isGap: !entry.id,
        recall: { good: '已看过', hard: '有点模糊', again: '忘记了' }[entry.rating] || '' });
      if (autoplay && entry.id) this.playCard();
    } else if (s.phase === 'overview') {
      this.setData({ overview: s.originalIds.map(id => byId[id]) });
    } else if (s.phase === 'quiz') {
      const q = s.questions[s.quizIndex];
      this.setData({ card: null, overview: [], results: [], questionKind: q.kind, plays: q.plays,
        draftWord: q.word, draftMeaning: q.meaning });
      if (autoplay && q.plays === 0) this.playQuestion();
    } else if (s.phase === 'results' || s.phase === 'done') this.renderResults();
  },
  touchStart(event) {
    if (this.data.preparing || this.data.missing.length || this.session.phase !== 'cards') return;
    const t = event.touches[0]; this.touch = { x: t.clientX, y: t.clientY };
  },
  touchEnd(event) {
    if (!this.touch) return;
    const start = this.touch; this.touch = null;
    const t = event.changedTouches[0], dx = t.clientX - start.x, dy = t.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 50) return;
    if (Math.abs(dx) > Math.abs(dy)) dx < 0 ? this.move('good') : this.previous();
    else this.move(dy < 0 ? 'again' : 'hard');
  },
  touchCancel() { this.touch = null; },
  move(rating) {
    if (this.busy || this.data.preparing || this.data.missing.length || this.session.phase !== 'cards') return;
    this.busy = true;
    try {
      const next = swipe.advance(this.session, rating);
      const state = next.feedback ? learning.rate(this.state, next.feedback.id, next.feedback.rating) : this.state;
      if (this.save(next.session, state)) {
        this.syncView();
        if (this.session.phase === 'overview') wx.showModal({ title: '这一组刷完啦，要听写吗？', content: '听写范围就是刚刷过的 ' + this.session.originalIds.length + ' 个词。', confirmText: '进入听写', cancelText: '暂不听写', success: r => { if (r.confirm) this.startDictation(); } });
      }
    } finally { this.busy = false; }
  },
  nextCard() { this.move('good'); },
  forgetCard() { this.move('again'); },
  vagueCard() { this.move('hard'); },
  previous() {
    if (this.session.phase !== 'cards' || this.data.preparing || this.data.missing.length) return;
    if (!this.session.index) { wx.showToast({ title: '已经是第一张啦', icon: 'none' }); return; }
    const s = JSON.parse(JSON.stringify(this.session)); s.index--;
    if (this.save(s)) this.syncView();
  },
  async playCard() {
    if (!this.data.card) return;
    try { await this.player.play(this.data.card); }
    catch (error) { if (!this.cancelled && error.message !== '播放已取消') this.setData({ audioStatus: '发音未播放，请点音标重试' }); }
  },
  playOverview(event) {
    const word = byId[event.currentTarget.dataset.id];
    this.player.play(word).catch(() => { if (!this.cancelled) this.setData({ audioStatus: '播放失败，请重试' }); });
  },
  startDictation() {
    if (this.session.phase !== 'overview') return;
    const state = Object.assign({}, this.state, { dictationRequest: { ids: this.session.originalIds, title: this.session.title } });
    const completed = Object.assign({}, this.session, { phase: 'cardsDone' });
    if (this.save(completed, state)) { this.player.stop(); wx.redirectTo({ url: '/pages/swipe/index?mode=dictation&request=1' }); }
  },
  skipDictation() {
    if (this.session.phase !== 'overview') return;
    const next = JSON.parse(JSON.stringify(this.session)); next.phase = 'cardsDone';
    if (this.save(next)) this.syncView(false);
  },
  async playQuestion() {
    if (this.session.phase !== 'quiz' || this.data.playing) return;
    const index = this.session.quizIndex;
    const q = this.session.questions[index];
    if (q.plays >= 3) { wx.showToast({ title: '这个词已经播放三遍啦', icon: 'none' }); return; }
    const token = (this.playToken || 0) + 1; this.playToken = token;
    // Reserve one play persistently before starting, including automatic playback.
    const next = JSON.parse(JSON.stringify(this.session)); next.questions[index].plays++;
    if (!this.save(next)) return;
    this.setData({ plays: next.questions[index].plays, playing: true, questionAudioError: '' });
    try { await this.player.play(byId[q.id], q.kind === 'sound' ? 'word' : 'meaning'); }
    catch (error) {
      if (!this.cancelled && this.session.phase === 'quiz') {
        const rollback = JSON.parse(JSON.stringify(this.session));
        rollback.questions[index].plays = Math.max(0, rollback.questions[index].plays - 1);
        if (this.save(rollback) && this.session.quizIndex === index) this.setData({ plays: rollback.questions[index].plays });
        if (error.message !== '播放已取消' && this.session.quizIndex === index) this.setData({
          audioStatus: '未能播放，本次不计次数，请重试',
          questionAudioError: error.message + (error.details ? '\n' + error.details : '')
        });
      }
    } finally { if (!this.cancelled && token === this.playToken) this.setData({ playing: false }); }
  },
  inputWord(event) { this.setData({ draftWord: event.detail.value }); },
  inputMeaning(event) { this.setData({ draftMeaning: event.detail.value }); },
  nextQuestion() {
    if (this.busy || this.session.phase !== 'quiz') return;
    this.busy = true;
    try {
      const next = swipe.submitQuestion(this.session, this.data.draftWord, this.data.draftMeaning, byId);
      if (this.save(next)) this.syncView();
    } finally { this.busy = false; }
  },
  renderResults() {
    const results = this.session.results.map(r => Object.assign({}, r, {
      expectedWord: byId[r.id].word, expectedMeaning: byId[r.id].meaning,
      complete: r.meaningCorrect !== null, correct: r.spellingCorrect && r.meaningCorrect === true
    }));
    this.setData({ results, checked: results.filter(r => r.complete).length, correct: results.filter(r => r.correct).length });
  },
  markMeaning(event) {
    if (this.session.phase !== 'results') return;
    const { id, correct } = event.currentTarget.dataset;
    const next = JSON.parse(JSON.stringify(this.session));
    next.results.find(r => r.id === id).meaningCorrect = correct === 'yes';
    if (this.save(next)) this.renderResults();
  },
  finishReview() {
    if (this.session.phase !== 'results') return;
    let state = this.state;
    for (const r of this.session.results) {
      // Objective spelling errors still need review. An unassessed meaning is
      // neither correct nor wrong; keep that word's existing card progress.
      if (!r.spellingCorrect || r.meaningCorrect === false) state = learning.rate(state, r.id, 'again');
      else if (r.meaningCorrect === true) state = learning.rate(state, r.id, 'good');
    }
    const next = JSON.parse(JSON.stringify(this.session)); next.phase = 'done';
    if (this.save(next, state)) this.syncView(false);
  },
  newPlan() {
    if (this.session && !['done', 'cardsDone'].includes(this.session.phase)) return;
    const next = plans.nextSelection(this.state);
    try { wx.setStorageSync(KEY, next); } catch (_) { wx.showToast({ title: '保存失败，请重试', icon: 'none' }); return; }
    this.state = next;
    if (this.sessionKey === 'dictation') this.initializeDictation(false); else this.beginPlan();
  },
  leave() { this.player.stop(); wx.navigateBack(); },
  noop() {}
});
