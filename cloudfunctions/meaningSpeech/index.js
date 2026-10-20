const cloud = require('wx-server-sdk');
const { randomUUID } = require('crypto');
const { splitSpeech } = require('./speech-text');
const definitions = require('./dictionary.json');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const memo = new Map();
const VOICE = 101004; // 智云，中文通用男声。Fixed on the server, never taken from client input.

exports.main = async event => {
  const context = cloud.getWXContext();
  if (!context.OPENID || context.APPID !== (process.env.APP_ID || 'wxfb74607b17b83b68')) {
    return { ok: false, message: '请从所属小程序调用此服务' };
  }
  if (event.action === 'whoami') return { ok: true, openId: context.OPENID };
  const allowed = String(process.env.ALLOWED_OPENIDS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!allowed.includes(context.OPENID)) return { ok: false, message: '请先把此微信用户加入语音服务允许名单' };
  const text = definitions[event.wordId];
  if (typeof text !== 'string') return { ok: false, message: '此词条不存在' };
  if (!process.env.TTS_SECRET_ID || !process.env.TTS_SECRET_KEY) return { ok: false, message: '尚未配置语音合成服务凭据' };
  if (memo.has(event.wordId)) return memo.get(event.wordId);
  try {
    const { tts } = require('tencentcloud-sdk-nodejs-tts');
    const client = new tts.v20190823.Client({
      credential: { secretId: process.env.TTS_SECRET_ID, secretKey: process.env.TTS_SECRET_KEY },
      region: 'ap-guangzhou', profile: { httpProfile: { endpoint: 'tts.tencentcloudapi.com' } }
    });
    const audio = [];
    for (const chunk of splitSpeech(text)) {
      const result = await client.TextToVoice({ Text: chunk, SessionId: randomUUID(), ModelType: 1,
        VoiceType: VOICE, Codec: 'mp3', SampleRate: 16000, Speed: -0.2, Volume: 0 });
      if (!result.Audio) throw new Error('EmptyAudio');
      audio.push(result.Audio);
    }
    const result = { ok: true, voiceType: VOICE, audio };
    if (memo.size >= 64) memo.delete(memo.keys().next().value);
    memo.set(event.wordId, result);
    return result;
  } catch (_) { return { ok: false, message: '语音合成失败，请检查服务开通状态、音色权限和可用额度' }; }
};
