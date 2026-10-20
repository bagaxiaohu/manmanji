// Public online sources; temporary cache only. Never substitute US without labelling it.
const cache = new Map();
const pending = new Map();
const { definitionText } = require('./speech-text');
const speechConfig = require('../config/speech');

function englishSources(word) {
  const encoded = encodeURIComponent(word);
  return [
    { url: `https://uapis.cn/api/v1/dictionary/audio?word=${encoded}&accent=uk`, accent: '英式', source: 'UAPI / 有道' },
    { url: `https://dict.youdao.com/dictvoice?audio=${encoded}&type=1`, accent: '英式', source: '有道' },
    { url: `https://uapis.cn/api/v1/dictionary/audio?word=${encoded}&accent=us`, accent: '美式补充', source: 'UAPI / 有道' },
    { url: `https://dict.youdao.com/dictvoice?audio=${encoded}&type=2`, accent: '美式补充', source: '有道' }
  ];
}

function spokenMeaning(word) {
  return definitionText(word.meaning);
}

function meaningSources(word) {
  const text = spokenMeaning(word);
  // Dictionary recordings cover short entries, rather than arbitrary sentences.
  const senses = text.replace(/[（(][^）)]*[）)]/g, '').split(/[；;，,、。]/)
    .map(sense => sense.replace(/^[\s：:]+|[\s：:]+$/g, ''))
    .filter(sense => /^[\u4e00-\u9fff]{1,12}$/.test(sense));
  const candidates = [];
  for (const sense of senses) {
    for (const candidate of [sense, sense.endsWith('的') ? sense.slice(0, -1) : sense]) {
      if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return [{ url: 'https://fanyi.baidu.com/gettts?lan=zh&spd=3&source=web&text=' + encodeURIComponent(text),
    accent: '中文释义', source: '百度翻译在线朗读' }].concat(candidates.slice(0, 6).map(sense => ({
    url: 'https://dict.youdao.com/dictvoice?le=zh&type=2&audio=' + encodeURIComponent(sense),
    accent: '中文释义摘读', source: '有道中文词条音频'
  })));
}

function download(source) {
  return new Promise((resolve, reject) => {
    const host = source.url.split('/')[2];
    const fail = error => {
      const message = error.errMsg || error.message || String(error);
      const failure = new Error(host + '：' + message);
      failure.code = /domain list|合法域名|域名列表|not in domain/i.test(message) ? 'DOMAIN' : 'NETWORK';
      reject(failure);
    };
    wx.downloadFile({ url: source.url, timeout: 15000,
      success(result) {
        if (result.statusCode !== 200) {
          const error = new Error(host + '：HTTP ' + result.statusCode);
          error.code = result.statusCode === 429 ? 'RATE_LIMIT' : result.statusCode === 404 ? 'MISSING' : 'HTTP';
          reject(error); return;
        }
        try {
          const bytes = new Uint8Array(wx.getFileSystemManager().readFileSync(result.tempFilePath));
          const mp3 = bytes.length > 512 && ((bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) || (bytes[0] === 255 && (bytes[1] & 224) === 224));
          if (!mp3) throw new Error('返回内容不是有效 MP3');
          resolve(Object.assign({}, source, { path: result.tempFilePath }));
        } catch (error) { fail(error); }
      }, fail });
  });
}

async function getClip(word, kind = 'word') {
  const key = kind === 'word' ? word.word.toLowerCase() : (speechConfig.enabled ? 'male:' : 'zh:') + word.id;
  if (cache.has(key)) {
    try {
      const clip = cache.get(key);
      for (const path of clip.paths || [clip.path]) wx.getFileSystemManager().accessSync(path);
      return clip;
    }
    catch (_) { cache.delete(key); }
  }
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    if (kind === 'meaning' && speechConfig.enabled) {
      const clip = await require('./male-speech').maleMeaning(word);
      cache.set(key, clip); return clip;
    }
    const sources = kind === 'word' ? englishSources(word.word) : meaningSources(word);
    const failures = [];
    for (const source of sources) {
      try { const clip = await download(source); cache.set(key, clip); return clip; }
      catch (error) { failures.push(error); }
    }
    const domainError = failures.find(error => error.code === 'DOMAIN');
    const rateLimit = failures.find(error => error.code === 'RATE_LIMIT');
    const error = new Error(domainError ? '微信拦截了音频下载，请在小程序后台配置 downloadFile 合法域名。' :
      rateLimit ? '音频接口正在限流，请稍后重试。' :
      '音频下载失败：' + (failures[0] ? failures[0].message : '未知原因'));
    error.code = domainError ? 'DOMAIN' : rateLimit ? 'RATE_LIMIT' : 'AUDIO';
    error.details = failures.map(failure => failure.message).join('\n');
    throw error;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}

async function prepare(words, progress, isCancelled = () => false, onFailure = () => {}) {
  let cursor = 0, completed = 0;
  const missing = [];
  await Promise.all([0, 1, 2].map(async () => {
    while (cursor < words.length && !isCancelled()) {
      const word = words[cursor++];
      try { await getClip(word); } catch (error) { missing.push(word.word); onFailure(word, error); }
      progress(++completed, words.length);
    }
  }));
  return missing;
}

function createPlayer(onStatus) {
  let audio = null, generation = 0, completion = null, timer;
  function settle(error) {
    clearTimeout(timer);
    const fn = completion; completion = null;
    if (fn) error ? fn.reject(error) : fn.resolve();
  }
  function stop() {
    generation++;
    settle(new Error('播放已取消'));
    if (audio) { audio.stop(); audio.destroy(); audio = null; }
  }
  return {
    async play(word, kind = 'word') {
      stop(); const token = generation;
      onStatus('正在准备音频…');
      const clip = await getClip(word, kind);
      if (token !== generation) throw new Error('播放已取消');
      // A fresh context starts the same cached MP3 from the beginning on every tap.
      // It also prevents delayed events from a previous card affecting this one.
      await new Promise((resolve, reject) => {
        completion = { resolve, reject };
        const paths = clip.paths || [clip.path];
        function playSegment(index) {
          if (token !== generation) return;
          if (audio) { audio.destroy(); audio = null; }
          const current = wx.createInnerAudioContext();
          audio = current; current.obeyMuteSwitch = false;
          let started = false;
          current.onPlay(() => {
            if (token !== generation || audio !== current) return;
            started = true;
            onStatus(clip.accent + ' · ' + clip.source);
            if (index === 0) settle();
          });
          current.onError(event => {
            if (token !== generation || audio !== current) return;
            if (!started && index === 0) settle(new Error('播放器错误 ' + ((event || {}).errCode || '') + '：' + ((event || {}).errMsg || '无法解码音频')));
            onStatus('播放失败，请检查网络或手机声音设置');
          });
          if (current.onEnded) current.onEnded(() => {
            if (token === generation && audio === current && index + 1 < paths.length) playSegment(index + 1);
          });
          current.src = paths[index];
          if (index === 0) timer = setTimeout(() => settle(new Error('播放超时，请重试')), 10000);
          current.play();
        }
        playSegment(0);
      });
      return clip;
    }, stop,
    destroy() { stop(); }
  };
}

module.exports = { englishSources, spokenMeaning, meaningSources, getClip, prepare, createPlayer };
