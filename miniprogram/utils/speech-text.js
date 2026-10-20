// Keep every definition sense. Only remove written part-of-speech labels.
function definitionText(meaning) {
  return String(meaning).replace(/\b(?:v\.-link|vt|vi|adj|adv|prep|conj|pron|num|art|aux|int|abbr|det|modal|n|v)\./gi, '')
    .replace(/\s*&\s*/g, ' ').replace(/[；;]/g, '，').replace(/\s+/g, ' ').trim();
}

function splitSpeech(text, limit = 120) {
  const chars = Array.from(text), chunks = [];
  while (chars.length) {
    let end = Math.min(limit, chars.length);
    if (chars.length > limit) {
      for (let i = end - 1; i >= Math.floor(limit / 2); i--) {
        if (/[，。！？；;,.!?]/.test(chars[i])) { end = i + 1; break; }
      }
    }
    chunks.push(chars.splice(0, end).join(''));
  }
  return chunks;
}

module.exports = { definitionText, splitSpeech };
