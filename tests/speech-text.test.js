const test = require('node:test');
const assert = require('node:assert/strict');
const { definitionText, splitSpeech } = require('../miniprogram/utils/speech-text');
test('full speech preserves definitions past 180 characters and proper nouns', () => {
  const meaning = 'vt. & vi. ' + '第一层释义；'.repeat(60) + '最后的释义；DNA 相关解释';
  const text = definitionText(meaning);
  assert.ok(text.length > 180);
  assert.ok(text.endsWith('最后的释义，DNA 相关解释'));
  assert.ok(!text.includes('vt.'));
});
test('speech chunks join back into the complete original text without dropping senses', () => {
  const text = definitionText('n. ' + '语义很长，不能只读一半。'.repeat(50));
  const chunks = splitSpeech(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 120));
  assert.equal(chunks.join(''), text);
});
