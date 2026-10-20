"""Extract supplied DOCX files without changing source documents."""
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from docx import Document

ROOT = Path(__file__).resolve().parents[1]
PATTERN = re.compile(r'^(.+?)\s+((?:/[^/]+/\s*)+)(.+)$')


def main():
    words, sections, seen, sources = [], [], {}, []
    for filename, family in [
        ('考研词汇 Word List 1-30 与偶考词 合并版.docx', 'main'),
        ('简单词与补充词 2270词 文字音标版.docx', 'extra'),
    ]:
        path = ROOT / filename
        group, category, count = '', '', 0
        for index, paragraph in enumerate(Document(path).paragraphs, 1):
            line = ' '.join(paragraph.text.replace('\\n', ' ').split())
            if not line:
                continue
            match = PATTERN.match(line)
            if not match:
                if re.fullmatch(r'Word List (?:[1-9]|[12][0-9]|30)', line):
                    group, category = line, 'core'
                elif line in ('偶考词', '简单词', '补充词'):
                    group = line
                    category = {'偶考词': 'occasional', '简单词': 'basic', '补充词': 'supplement'}[line]
                elif category == 'occasional' and line in ('与人相关', '日常生活', '社会政经', '物体描述', '自然科学', '文体教育', '其他'):
                    group = '偶考词 · ' + line
                else:
                    raise ValueError(f'Unrecognized paragraph {filename}:{index}: {line}')
                if group not in sections:
                    sections.append(group)
                continue
            if not category:
                raise ValueError('Entry without section')
            word, phonetic, meaning = match.groups()
            # Include source occurrence so duplicate headwords retain all original senses.
            key = f'{family}|{group}|{word.lower()}'
            occurrence = seen.get(key, 0)
            seen[key] = occurrence + 1
            ident = hashlib.sha256(f'{key}|{occurrence}'.encode()).hexdigest()[:16]
            words.append(dict(id=ident, word=word.strip(), phonetic=phonetic.strip(),
                              meaning=meaning.strip(), group=group, category=category,
                              source=filename, paragraph=index))
            count += 1
        sources.append(dict(file=filename, count=count, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    assert len(words) == 6026
    assert len({w['id'] for w in words}) == len(words)
    assert all(re.search(r'[\u4e00-\u9fff]', w['meaning']) for w in words)
    counts = Counter(w['category'] for w in words)
    report = dict(total=len(words), uniqueHeadwords=len({w['word'].lower() for w in words}),
                  categories=dict(counts), sources=sources,
                  notes=['保留重复词头及原始释义，进度按词条记录。', '仅整理空白和换行，未校订原文疑似错字。',
                         'PDF 未导入；两份 Word 已包含可直接读取的文字词条。'])
    out = ROOT / 'miniprogram' / 'data'
    out.mkdir(parents=True, exist_ok=True)
    payload = dict(words=words, sections=sections, report=report)
    (out / 'words.js').write_text('module.exports = ' + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    (ROOT / 'data-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
