const library = require('../../data/words');
const engine = require('../../utils/learning');
const audio = require('../../utils/audio');
const plans = require('../../utils/plans');
const KEY = 'manmanji.learning.v1';
const CATEGORIES = [
  { id: 'core', name: 'Word List 1–30', hint: '从这里开始，按原书顺序学习', short: '主词表' },
  { id: 'occasional', name: '偶考词', hint: '完成主词表后，再来补充', short: '偶考词' },
  { id: 'basic', name: '简单词', hint: '查漏补缺，巩固基础', short: '简单词' },
  { id: 'supplement', name: '补充词', hint: '拓展词汇，慢慢积累', short: '补充词' },
  { id: 'all', name: '全部词条', hint: '包含原书中的重复词头', short: '全部' }
].map(c => Object.assign({}, c, { count: engine.selectWords(library.words, c.id).length }));
const BY_ID = Object.fromEntries(library.words.map(w => [w.id, w]));

Page({
  data: { tab: 'home', studying: false, revealed: false, finished: false, pendingRating: '', corrected: false,
    categories: CATEGORIES,
    filterRows: [['all'], ['core', 'occasional'], ['basic', 'supplement']].map(ids => ({
      id: ids.join('-'), options: ids.map(id => CATEGORIES.find(category => category.id === id))
    })),
    settings: engine.freshState().settings, stats: {},
    search: '', onlyFavorites: false, onlyLearned: false, learnedBookName: '', filterCategory: 'all', list: [], totalMatches: 0,
    detail: null, showSettings: false, backupMode: '', backupText: '', storageError: false, audioStatus: '',
    showPlanPicker: false, planLists: [], planHistory: [] },

  onLoad() {
    this.disposed = false;
    this.audioPlayer = audio.createPlayer(message => {
      if (!this.disposed && this.data.studying && !this.data.finished) this.setData({ audioStatus: message });
    });
    this.state = engine.freshState();
    try {
      const saved = wx.getStorageSync(KEY);
      if (saved) this.state = engine.validateState(saved, library.words);
    } catch (error) {
      this.setData({ storageError: true });
      wx.showModal({ title: '暂时无法读取学习记录', content: '为避免覆盖原有进度，已暂停保存。请先关闭并重新打开；如仍有问题，可在设置里恢复备份。', showCancel: false });
    }
    this.refresh();
    this.filterList();
  },
  onShow() {
    if (!this.state) return;
    try {
      const saved = wx.getStorageSync(KEY);
      if (saved) this.state = engine.validateState(saved, library.words);
    } catch (_) { this.setData({ storageError: true }); }
    this.refresh();
    if (this.data.tab === 'library') this.filterList();
  },
  startSwipe() { wx.navigateTo({ url: '/pages/swipe/index' }); },
  startDictation() { wx.navigateTo({ url: '/pages/swipe/index?mode=dictation' }); },
  openPlanPicker() {
    this.setData({ showPlanPicker: true, planLists: Array.from({ length: 30 }, (_, i) => {
      const number = i + 1, entries = library.words.filter(w => w.group === 'Word List ' + number);
      return { number, total: entries.length, learned: entries.filter(w => this.state.records[w.id]).length };
    }), planHistory: plans.history(this.state).map(p => ({ id: p.id, title: p.title, count: p.ids.length })) });
  },
  closePlanPicker() { this.setData({ showPlanPicker: false }); },
  choosePlan(event) {
    const { type, id } = event.currentTarget.dataset;
    let next = Object.assign({}, this.state, { planSelection: type === 'list' ? { type, id: Number(id) } : type === 'history' ? { type, id } : { type: 'auto' } });
    if (type === 'history') {
      const selected = plans.history(this.state).find(p => p.id === id);
      if (!selected) return;
      next = plans.record(next, selected.ids, selected.title, 'history');
      next.planSelection = { type, id: next.planHistory[0].id };
    }
    if (type === 'list') next.settings = Object.assign({}, next.settings, { category: 'core' });
    try { plans.validate(next, library.words); } catch (_) { return; }
    if (this.commit(next)) this.closePlanPicker();
  },
  openCompletedDictation() {
    if (!this.sessionIds || !this.sessionIds.length) return;
    const next = Object.assign({}, this.state, { dictationRequest: { ids: this.sessionIds, title: this.sessionHistoryTitle || this.data.sessionTitle } });
    if (this.commit(next)) wx.navigateTo({ url: '/pages/swipe/index?mode=dictation&request=1' });
  },
  continueStudy(event) {
    if (this.commit(plans.nextSelection(this.state))) this.start(event);
  },
  onHide() { this.stopAudio(); },
  onUnload() {
    this.disposed = true;
    clearTimeout(this.searchTimer);
    if (this.audioPlayer) this.audioPlayer.destroy();
  },
  stopAudio() {
    this.cardAudioToken = (this.cardAudioToken || 0) + 1;
    if (this.audioPlayer) this.audioPlayer.stop();
  },
  commit(next, restoring = false) {
    if (this.data.storageError && !restoring) {
      wx.showToast({ title: '请先恢复备份或重新打开', icon: 'none' }); return false;
    }
    try { wx.setStorageSync(KEY, next); }
    catch (error) { wx.showToast({ title: '保存失败，请检查手机存储后重试', icon: 'none' }); return false; }
    this.state = next;
    this.setData({ storageError: false });
    this.refresh();
    return true;
  },
  refresh() {
    const category = CATEGORIES.find(c => c.id === this.state.settings.category);
    const stats = engine.summary(library.words, this.state);
    this.setData({ settings: this.state.settings, stats, categoryName: category.name,
      dateLabel: engine.dateKey().replace(/-/g, '.'),
      planBadge: stats.planTitle || category.name,
      actionLabel: stats.manualPlan ? '学习 ' + stats.planTitle : stats.planKind === 'list' && stats.hasNew ? '继续学习 ' + stats.listName :
        stats.hasNew ? (stats.dailyNew >= this.state.settings.goal ? '目标已达成，继续学' : '开始今日学习') :
          stats.due ? '开始到期复习' : '词书已学完，查看复习' });
  },
  switchTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (this.data.onlyLearned && tab === 'library') { this.showFullLibrary(); return; }
    this.setData({ tab });
    this.refresh();
    if (this.data.tab === 'library') this.filterList();
  },
  openLearnedWords() {
    const category = CATEGORIES.find(c => c.id === this.state.settings.category);
    clearTimeout(this.searchTimer);
    this.setData({ tab: 'library', onlyLearned: true, learnedBookName: category.name,
      filterCategory: category.id, onlyFavorites: false, search: '' });
    this.filterList();
  },
  showFullLibrary() {
    clearTimeout(this.searchTimer);
    this.setData({ tab: 'library', onlyLearned: false, filterCategory: 'all', onlyFavorites: false, search: '' });
    this.filterList();
  },
  start(event) {
    const mode = event.currentTarget.dataset.mode || 'daily';
    const plan = engine.learningPlan(library.words, this.state);
    this.queue = engine.buildQueue(library.words, this.state, mode);
    if (!this.queue.length) {
      wx.showModal({ title: mode === 'favorites' ? '还没有收藏的单词' : '现在没有待学任务',
        content: mode === 'favorites' ? '在词库或单词卡片上点星星，把想多看几遍的词收进来。' : mode === 'review' ? '当前没有到期的复习词，可以稍后回来，或从首页继续学新词。' : '所选词书的新词已学完，当前也没有到期复习。可以稍后回来，或在设置中切换词书。', showCancel: false });
      return;
    }
    this.position = 0; this.repeated = {}; this.sessionAnswers = 0; this.sessionUnique = new Set();
    this.sessionIds = [...new Set(this.queue)];
    this.sessionMode = mode;
    this.sessionHistoryTitle = mode === 'daily' ? plan.title || plan.listName || CATEGORIES.find(c => c.id === this.state.settings.category).name + ' · ' + engine.dateKey() : { review: '到期复习', favorites: '收藏复习' }[mode];
    this.setData({ studying: true, finished: false, sessionTitle: mode === 'daily' && (plan.kind === 'list' || plan.manual) ? plan.listName : { daily: '今日学习', review: '到期复习', favorites: '收藏复习' }[mode] });
    this.showCard();
  },
  showCard() {
    const word = BY_ID[this.queue[this.position]];
    this.setData({ card: word, revealed: false, pendingRating: '', corrected: false, favorite: !!this.state.favorites[word.id], audioStatus: '',
      position: this.position + 1, queueLength: this.queue.length, sessionPercent: Math.round(this.position / this.queue.length * 100) });
    this.playCard();
  },
  async playCard() {
    if (!this.data.studying || this.data.finished || !this.data.card || this.disposed) return;
    const token = (this.cardAudioToken || 0) + 1; this.cardAudioToken = token;
    try { await this.audioPlayer.play(this.data.card); }
    catch (error) {
      if (!this.disposed && token === this.cardAudioToken && this.data.studying && !this.data.finished && error.message !== '播放已取消') {
        this.setData({ audioStatus: '发音未播放，点击音标重试：' + error.message });
      }
    }
  },
  chooseRating(event) {
    if (!this.data.studying || this.data.finished || this.data.revealed) return;
    const rating = event.currentTarget.dataset.rating;
    if (!['good', 'hard', 'again'].includes(rating)) return;
    this.setData({ revealed: true, pendingRating: rating, corrected: false });
  },
  correctAnswer() {
    if (!this.data.studying || this.data.finished || !this.data.revealed ||
        !['good', 'hard'].includes(this.data.pendingRating)) return;
    this.setData({ pendingRating: 'again', corrected: true });
    this.nextWord();
  },
  toggleFavorite(event) {
    const id = event.currentTarget.dataset.id || this.data.card.id;
    const next = JSON.parse(JSON.stringify(this.state));
    if (next.favorites[id]) delete next.favorites[id]; else next.favorites[id] = true;
    if (!this.commit(next)) return;
    this.setData({ favorite: this.data.card ? !!next.favorites[this.data.card.id] : false });
    if (this.data.detail) this.setData({ detailFavorite: !!next.favorites[this.data.detail.id] });
    this.filterList();
  },
  nextWord() {
    if (!this.data.revealed || !this.data.pendingRating || this.answering || !this.data.studying || this.data.finished) return;
    this.answering = true;
    try {
      const rating = this.data.pendingRating;
      const id = this.data.card.id;
      const willRepeat = rating === 'again' && !this.repeated[id];
      const willFinish = this.position + 1 >= this.queue.length && !willRepeat;
      let nextState = engine.rate(this.state, id, rating);
      if (willFinish) nextState = plans.record(nextState, this.sessionIds, this.sessionHistoryTitle, 'normal');
      if (!this.commit(nextState)) return;
      this.sessionAnswers += 1; this.sessionUnique.add(id);
      // A forgotten word returns once in this session, then remains due in ten minutes.
      if (rating === 'again' && !this.repeated[id]) { this.queue.push(id); this.repeated[id] = true; }
      this.position += 1;
      if (this.position >= this.queue.length) {
        this.stopAudio();
        const nextState = plans.nextSelection(this.state);
        const nextPlan = engine.learningPlan(library.words, nextState);
        this.setData({ finished: true, completedCount: this.sessionUnique.size, completedAnswers: this.sessionAnswers,
          canContinue: this.sessionMode === 'daily' && engine.buildQueue(library.words, nextState).length > 0,
          continueLabel: nextPlan.kind === 'list' && nextPlan.newWords.length ? '继续学习 ' + nextPlan.listName : '继续学下一组' });
        wx.showModal({ title: '这一组学完啦，要听写吗？', content: '听写范围就是刚学过的这 ' + this.sessionIds.length + ' 个词。', confirmText: '开始听写', cancelText: '暂不听写', success: result => { if (result.confirm) this.openCompletedDictation(); } });
      } else this.showCard();
    } finally { this.answering = false; }
  },
  leaveStudy() {
    if (this.data.finished) { this.endStudy(); return; }
    wx.showModal({ title: '先休息一下？', content: '已点击“下一词”的记录都已保存。当前词还未确认，下次会根据进度安排学习。', confirmText: '休息一下', cancelText: '继续学习', success: result => { if (result.confirm) this.endStudy(); } });
  },
  endStudy() { this.stopAudio(); this.setData({ studying: false, finished: false, audioStatus: '' }); this.refresh(); },
  searchInput(event) {
    this.setData({ search: event.detail.value });
    clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.filterList(), 150);
  },
  chooseFilter(event) { this.setData({ filterCategory: event.currentTarget.dataset.id }); this.filterList(); },
  toggleFavoritesFilter() { this.setData({ onlyFavorites: !this.data.onlyFavorites }); this.filterList(); },
  filterList() {
    const query = this.data.search.trim().toLowerCase();
    this.matches = engine.selectWords(library.words, this.data.filterCategory).filter(w =>
      (!this.data.onlyLearned || this.state.records[w.id]) &&
      (!this.data.onlyFavorites || this.state.favorites[w.id]) &&
      (!query || w.word.toLowerCase().includes(query) || w.meaning.includes(query)));
    if (this.data.onlyLearned) this.matches.sort((a, b) => this.state.records[b.id].last - this.state.records[a.id].last);
    this.limit = 40;
    this.renderList();
  },
  renderList() {
    this.setData({ list: this.matches.slice(0, this.limit).map(w => ({ id: w.id, word: w.word,
      phonetic: w.phonetic, meaning: w.meaning, group: w.group, favorite: !!this.state.favorites[w.id], learned: !!this.state.records[w.id] })), totalMatches: this.matches.length });
  },
  loadMore() { this.limit += 40; this.renderList(); },
  onReachBottom() { if (this.data.tab === 'library' && !this.data.studying) this.loadMore(); },
  openDetail(event) {
    const word = BY_ID[event.currentTarget.dataset.id];
    this.setData({ detail: word, detailFavorite: !!this.state.favorites[word.id] });
  },
  closeDetail() { this.setData({ detail: null }); },
  openSettings() { this.setData({ showSettings: true, draft: Object.assign({}, this.state.settings) }); },
  closeSettings() { this.setData({ showSettings: false }); },
  editSetting(event) {
    const field = event.currentTarget.dataset.field;
    if (['goal', 'note'].includes(field)) this.setData({ [`draft.${field}`]: event.detail.value });
  },
  chooseCategory(event) { this.setData({ 'draft.category': event.currentTarget.dataset.id }); },
  saveSettings() {
    const draft = Object.assign({}, this.data.draft);
    draft.goal = Number(draft.goal);
    if (!Number.isInteger(draft.goal) || draft.goal < 5 || draft.goal > 100) { wx.showToast({ title: '每日目标请填 5–100 的整数', icon: 'none' }); return; }
    draft.name = engine.FIXED_NAME; draft.note = draft.note.trim() || engine.freshState().settings.note;
    const next = Object.assign({}, this.state, { settings: draft });
    if (draft.category !== this.state.settings.category) next.planSelection = { type: 'auto' };
    if (this.commit(next)) { this.closeSettings(); wx.showToast({ title: '已经保存', icon: 'success' }); }
  },
  exportBackup() {
    if (this.data.storageError) { wx.showToast({ title: '原记录未读出，暂不能导出', icon: 'none' }); return; }
    wx.setClipboardData({ data: JSON.stringify(this.state), success: () => wx.showModal({ title: '备份已复制', content: '请粘贴到自己的文件或聊天收藏中保存。恢复时，把完整文字粘贴回来。备份包含昵称、寄语和学习进度。', showCancel: false }) });
  },
  openImport() { this.setData({ backupMode: 'import', backupText: '' }); },
  closeImport() { this.setData({ backupMode: '', backupText: '' }); },
  inputBackup(event) { this.setData({ backupText: event.detail.value }); },
  restoreBackup() {
    let next;
    try { next = engine.validateState(JSON.parse(this.data.backupText), library.words); }
    catch (error) { wx.showToast({ title: '备份无效，请检查是否复制完整', icon: 'none' }); return; }
    wx.showModal({ title: '恢复这份备份？', content: '将用备份替换当前手机上的学习记录。建议先导出当前记录。', confirmText: '恢复备份', success: result => {
      if (result.confirm && this.commit(next, true)) { this.closeImport(); this.filterList(); wx.showToast({ title: '已恢复', icon: 'success' }); }
    } });
  },
  noop() {}
});
