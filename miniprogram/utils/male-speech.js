const config = require('../config/speech');

async function maleMeaning(word) {
  if (!config.enabled || !config.env) throw new Error('中文男声尚未配置');
  if (!wx.cloud) throw new Error('当前基础库不支持云端语音');
  wx.cloud.init({ env: config.env, traceUser: false });
  const response = await wx.cloud.callFunction({ name: config.functionName, data: { wordId: word.id } });
  const result = response.result;
  if (!result || !result.ok || result.voiceType !== config.voiceType || !Array.isArray(result.audio) || !result.audio.length) {
    throw new Error((result && result.message) || '中文男声合成失败，请检查云函数配置');
  }
  const fs = wx.getFileSystemManager();
  const paths = result.audio.map((base64, index) => {
    if (typeof base64 !== 'string' || base64.length < 100) throw new Error('语音分段不完整');
    const path = `${wx.env.USER_DATA_PATH}/manmanji_male_${word.id}_${index}.mp3`;
    fs.writeFileSync(path, base64, 'base64'); return path;
  });
  return { path: paths[0], paths, accent: '中文男声 · 完整释义', source: '腾讯云·智云' };
}
module.exports = { maleMeaning };
