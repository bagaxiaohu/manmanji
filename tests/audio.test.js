const test = require('node:test');
const assert = require('node:assert/strict');
const audio = require('../miniprogram/utils/audio');
const mp3 = new Uint8Array(1024); mp3.set([73, 68, 51]);

function mockDownload(handler) {
  global.wx = { downloadFile: handler,
    getFileSystemManager: () => ({ accessSync() {}, readFileSync: () => mp3.buffer }) };
}

test('English sources prefer UK and label US fallback, with encoded word parameters', async () => {
  const urls = [];
  mockDownload(options => {
    urls.push(options.url);
    if (options.url.includes('accent=uk') || options.url.includes('type=1')) options.success({ statusCode: 404 });
    else options.success({ statusCode: 200, tempFilePath: 'tmp-us.mp3' });
  });
  const clip = await audio.getClip({ id: 'audio-test1', word: 'fallback test' });
  assert.equal(clip.accent, '美式补充');
  assert.equal(urls.length, 3);
  assert.ok(urls[0].includes('fallback%20test'));
  assert.ok(urls[0].includes('accent=uk'));
});

test('meaning audio contains Chinese senses without reading POS labels', async () => {
  let url;
  mockDownload(options => { url = options.url; options.success({ statusCode: 200, tempFilePath: 'zh.mp3' }); });
  await audio.getClip({ id: 'audio-test2', word: 'advance', meaning: 'n. 进步；进展 vt. 促进' }, 'meaning');
  const text = new URL(url).searchParams.get('text');
  assert.ok(text.includes('进步')); assert.ok(!text.includes('advance')); assert.ok(!text.includes('vt.'));
});

test('stopping during a download prevents stale cards from playing later', async () => {
  let completeDownload, played = 0;
  mockDownload(options => { completeDownload = options.success; });
  global.wx.createInnerAudioContext = () => ({
    onPlay() {}, onError() {}, stop() {}, destroy() {}, play() { played++; }
  });
  const player = audio.createPlayer(() => {});
  const pending = player.play({ id: 'audio-test3', word: 'cancelled-audio-test' });
  player.stop();
  completeDownload({ statusCode: 200, tempFilePath: 'late.mp3' });
  await assert.rejects(pending, /取消/);
  assert.equal(played, 0);
  player.destroy();
});

test('domain-list blocks preserve the real reason and identify the configuration needed', async () => {
  mockDownload(options => options.fail({ errMsg: 'downloadFile:fail url not in domain list' }));
  await assert.rejects(audio.getClip({ id: 'domain-test', word: 'domain-diagnostic-test' }), error => {
    assert.equal(error.code, 'DOMAIN');
    assert.ok(error.message.includes('downloadFile'));
    assert.ok(error.details.includes('not in domain list'));
    assert.ok(error.details.includes('uapis.cn'));
    return true;
  });
});

test('preparation exposes source rate limiting instead of treating it as missing recordings', async () => {
  mockDownload(options => options.success({ statusCode: 429 }));
  const failures = [];
  const missing = await audio.prepare([{ id: 'rate-test', word: 'rate-diagnostic-test' }], () => {}, () => false,
    (word, error) => failures.push(error));
  assert.equal(missing.length, 1);
  assert.equal(failures[0].code, 'RATE_LIMIT');
  assert.ok(failures[0].details.includes('HTTP 429'));
});

test('replaying a cached word creates fresh playback contexts and ignores stale audio errors', async () => {
  mockDownload(options => options.success({ statusCode: 200, tempFilePath: 'replay.mp3' }));
  const contexts = [], messages = [];
  global.wx.createInnerAudioContext = () => {
    const context = {
      onPlay(fn) { this.didPlay = fn; }, onError(fn) { this.didError = fn; },
      play() { this.played = true; this.didPlay(); }, stop() { this.stopped = true; }, destroy() { this.destroyed = true; }
    };
    contexts.push(context); return context;
  };
  const player = audio.createPlayer(message => messages.push(message));
  const word = { id: 'replay-test', word: 'replay-audio-test' };
  await player.play(word); await player.play(word); await player.play(word);
  assert.equal(contexts.length, 3);
  assert.ok(contexts.every(c => c.played && c.src === 'replay.mp3'));
  assert.equal(contexts[0].destroyed, true);
  assert.equal(contexts[1].destroyed, true);
  contexts[0].didError();
  assert.ok(!messages.some(message => message.includes('播放失败')));
  player.destroy(); assert.equal(contexts[2].destroyed, true);
});

test('a blocked Chinese TTS falls back to an original Chinese dictionary sense', async () => {
  const urls = [];
  mockDownload(options => {
    urls.push(options.url);
    if (options.url.includes('fanyi.baidu.com')) options.success({ statusCode: 403 });
    else options.success({ statusCode: 200, tempFilePath: 'meaning-fallback.mp3' });
  });
  const clip = await audio.getClip({ id: 'zh-fallback-test', word: 'debate', meaning: 'n. 争论；辩论；讨论' }, 'meaning');
  assert.equal(clip.accent, '中文释义摘读');
  assert.equal(new URL(urls[1]).hostname, 'dict.youdao.com');
  assert.equal(new URL(urls[1]).searchParams.get('audio'), '争论');
  assert.ok(!urls.some(url => url.includes('audio=debate')));
});

test('Chinese dictionary fallback removes POS and parenthetical notes without fabricating meanings', () => {
  const sources = audio.meaningSources({ meaning: 'adj. （课程）高级的，高等的；（学生）程度高的' });
  const clues = sources.slice(1).map(source => new URL(source.url).searchParams.get('audio'));
  assert.deepEqual(clues.slice(0, 2), ['高级的', '高级']);
  assert.ok(!clues.some(clue => clue.includes('课程')));
});

test('configured male speech plays every full-definition segment in order and restarts from segment one', async () => {
  const config = require('../miniprogram/config/speech');
  const before = Object.assign({}, config);
  config.enabled = true; config.env = 'test-environment';
  const contexts = [], files = [], statuses = [];
  const base64 = 'a'.repeat(200);
  global.wx = {
    env: { USER_DATA_PATH: '/test-data' },
    cloud: { init() {}, async callFunction() { return { result: { ok: true, voiceType: 101004, audio: [base64, base64, base64] } }; } },
    getFileSystemManager: () => ({ accessSync() {}, writeFileSync(path) { files.push(path); } }),
    createInnerAudioContext() {
      const context = { onPlay(fn) { this.didPlay = fn; }, onEnded(fn) { this.didEnd = fn; }, onError() {},
        play() { this.didPlay(); }, stop() {}, destroy() {} };
      contexts.push(context); return context;
    }
  };
  const player = audio.createPlayer(status => statuses.push(status));
  try {
    const word = { id: 'full-male-test', word: 'word', meaning: '很长的完整释义' };
    await player.play(word, 'meaning');
    assert.equal(contexts[0].src, files[0]);
    contexts[0].didEnd(); assert.equal(contexts[1].src, files[1]);
    contexts[1].didEnd(); assert.equal(contexts[2].src, files[2]);
    await player.play(word, 'meaning'); assert.equal(contexts[3].src, files[0]);
    assert.ok(statuses.some(status => status.includes('中文男声 · 完整释义')));
    player.destroy();
    contexts[3].didEnd(); assert.equal(contexts.length, 4, 'stopping cancels remaining segments');
  } finally { Object.assign(config, before); }
});
