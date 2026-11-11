// build-readme.mjs - README.md / README.en.md 에서 README.html / README.en.html 을 만들고 일치 여부를 검사한다.
//   node build-readme.mjs            (만들기 + 검사. 하나라도 어긋나면 실패 코드로 끝)
//   node build-readme.mjs --check    (파일을 쓰지 않고 검사만: 디스크의 html 이 md 와 같은지 포함)
// 검사: ① md 한국어↔영어 구조 동일(헤딩·표·코드 블록·접이식·링크 수) ② 목차 링크가 실제 헤딩으로 가는지 ③ md 글자와 html 글자 동일 ④ html 에 변환 안 된 표시(**, 백틱, |---|)가 없는지
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CHECK_ONLY = process.argv.includes('--check');
const PAIRS = [
  { md: 'README.md', html: 'README.html', lang: 'ko' },
  { md: 'README.en.md', html: 'README.en.html', lang: 'en' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// GitHub 방식 제목 -> 앵커: 소문자, 글자·숫자·공백·하이픈만 남기고 공백은 하이픈
const slug = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

// ---------- 인라인 ----------
function inline(s, lang) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0001${codes.length - 1}\u0002`; });
  s = esc(s);
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, u) => `<a href="${u}">${u}</a>`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
    let href = u;
    if (href === 'README.md') href = 'README.html'; else if (href === 'README.en.md') href = 'README.en.html';
    return `<a href="${href}">${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\u0001(\d+)\u0002/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

// ---------- 블록 ----------
function render(md, lang) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const listRe = /^(\s*)(-|\d+\.)\s+(.*)$/;

  function renderList(startIdx) {
    // 들여쓰기 기반 중첩 목록(1단계 중첩까지 사용). 반환: [html, 다음 줄 번호]
    const items = [];
    let k = startIdx;
    while (k < lines.length) {
      const m = listRe.exec(lines[k]);
      if (!m) break;
      items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
      k++;
    }
    const build = (from, to, baseIndent) => {
      let html = ''; let idx = from;
      const ordered = items[from].ordered;
      html += ordered ? '<ol>' : '<ul>';
      while (idx < to) {
        const it = items[idx];
        let j = idx + 1;
        while (j < to && items[j].indent > baseIndent) j++;
        html += '<li>' + inline(it.text, lang);
        if (j > idx + 1) html += build(idx + 1, j, items[idx + 1].indent);
        html += '</li>';
        idx = j;
      }
      html += ordered ? '</ol>' : '</ul>';
      return html;
    };
    return [build(0, items.length, items[0].indent), k];
  }

  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*$/.test(l)) { i++; continue; }
    if (/^```/.test(l)) {                                  // 코드 블록
      const body = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^<\/?details>\s*$/.test(l.trim())) { out.push(l.trim()); i++; continue; }
    if (/^<summary>.*<\/summary>\s*$/.test(l.trim())) { out.push(l.trim()); i++; continue; }
    if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { const n = h[1].length; out.push(`<h${n} id="${slug(h[2])}">${inline(h[2], lang)}</h${n}>`); i++; continue; }
    if (/^>\s?/.test(l)) {                                  // 인용
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote><p>${inline(buf.join(' '), lang)}</p></blockquote>`);
      continue;
    }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {   // 표
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<div class="tw"><table><thead><tr>' + head.map((c) => `<th>${inline(c, lang)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c, lang)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (listRe.test(l)) { const [html, next] = renderList(i); out.push(html); i = next; continue; }
    const buf = [];                                          // 문단
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^<\/?(details|summary)/.test(lines[i].trim()) && !/^---+\s*$/.test(lines[i]) && !listRe.test(lines[i]) && !/^>\s?/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '), lang)}</p>`);
  }
  return out.join('\n');
}

const CSS = `
:root{--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--soft:#f6f8fa;--accent:#0b5cad;--code:#eff1f3;--quote:#fff8e1;--quote-line:#e0a800}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--soft:#151b23;--accent:#58a6ff;--code:#1c2128;--quote:#2a2410;--quote-line:#9e7c0c}}
:root[data-theme="dark"]{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--soft:#151b23;--accent:#58a6ff;--code:#1c2128;--quote:#2a2410;--quote-line:#9e7c0c}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 -apple-system,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",Roboto,sans-serif}
main{max-width:880px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:1.9rem;line-height:1.3;margin:.2em 0 .6em}
h2{font-size:1.45rem;margin:2.2em 0 .7em;padding-bottom:.3em;border-bottom:1px solid var(--line);scroll-margin-top:12px}
h3{font-size:1.15rem;margin:1.7em 0 .5em;scroll-margin-top:12px}
a{color:var(--accent)}
p,li{overflow-wrap:anywhere}
code{background:var(--code);padding:.12em .38em;border-radius:5px;font:0.88em ui-monospace,SFMono-Regular,Consolas,"D2Coding",monospace;overflow-wrap:anywhere}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;line-height:1.45}
pre code{background:none;padding:0;overflow-wrap:normal;white-space:pre}
.tw{overflow-x:auto;margin:1em 0;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:.93rem}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;min-width:90px}
th{background:var(--soft)}
tr:last-child td{border-bottom:none}
blockquote{margin:1em 0;padding:.6em 1em;background:var(--quote);border-left:4px solid var(--quote-line);border-radius:0 8px 8px 0}
blockquote p{margin:.2em 0}
details{border:1px solid var(--line);border-radius:8px;margin:.7em 0;padding:.1em 1em;background:var(--soft)}
details[open]{background:transparent}
summary{cursor:pointer;padding:.55em 0;font-weight:600}
hr{border:none;border-top:1px solid var(--line);margin:2em 0}
ul,ol{padding-left:1.4em}
@media (max-width:600px){body{font-size:15px}h1{font-size:1.5rem}h2{font-size:1.25rem}th,td{padding:6px 8px;min-width:70px}}
@media print{details{background:none}details>*{display:block}main{max-width:none}}
`;

function page(body, lang, title) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

// ---------- 검사 ----------
// md 글자(독립된 단순 규칙으로 추출) vs html 글자
function plainFromMd(md) {
  const out = [];
  let inFence = false;
  for (let line of md.replace(/\r\n/g, '\n').split('\n')) {
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { out.push(line); continue; }
    if (/^\s*$/.test(line) || /^---+\s*$/.test(line)) continue;
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line) && line.includes('-') && !/[^\s|:\-]/.test(line)) continue;
    if (/^<\/?details>\s*$/.test(line.trim())) continue;
    const codes = [];
    line = line.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0001${codes.length - 1}\u0002`; });
    line = line.replace(/^<summary><b>(.*)<\/b><\/summary>$/, '$1');
    if (/^\s*#{1,6}\s+/.test(line)) line = line.replace(/^\s*#{1,6}\s+/, '');          // 제목은 번호("1. ")를 지우지 않는다
    else line = line.replace(/^\s*>\s?/, '').replace(/^\s*(-|\d+\.)\s+/, '');
    line = line.replace(/<(https?:\/\/[^\s>]+)>/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1$2');
    const isRow = line.includes('|') && /^\s*\|/.test(line);
    if (isRow) line = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')).join(' ');
    line = line.replace(/\u0001(\d+)\u0002/g, (_, i) => (isRow ? codes[Number(i)].replace(/\\\|/g, '|') : codes[Number(i)]));   // 표 안의 \| 는 화면에서 | 로 보인다
    out.push(line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
function plainFromHtml(html) {
  const body = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<head>[\s\S]*?<\/head>/, '');
  const t = body.replace(/<\/?(p|ul|ol|li|td|th|tr|table|thead|tbody|div|h[1-6]|pre|summary|details|blockquote|hr)\b[^>]*>/g, ' ').replace(/<[^>]+>/g, '');   // 블록 태그만 공백으로, 글자 속 태그(code·strong·a)는 그냥 지움
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function structure(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let fence = 0, details = 0, tables = [], heads = [], anchorLinks = 0, bullets = 0, inFence = false, curTable = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) { fence++; inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^<details>/.test(l)) details++;
    const h = /^(#{1,6})\s/.exec(l); if (h) heads.push(h[1].length);
    if (l.includes('|') && /^\s*\|/.test(l)) { curTable++; } else if (curTable) { tables.push(curTable); curTable = 0; }
    if (/^\s*(-|\d+\.)\s+/.test(l)) bullets++;
    anchorLinks += (l.match(/\]\(#/g) || []).length;
  }
  if (curTable) tables.push(curTable);
  return { fence, details, tables: tables.join(','), heads: heads.join(''), anchorLinks, bullets };
}
function anchors(md) {
  const set = new Set(); let inFence = false;
  for (const l of md.replace(/\r\n/g, '\n').split('\n')) { if (/^```/.test(l)) inFence = !inFence; if (inFence) continue; const h = /^#{1,6}\s+(.*)$/.exec(l); if (h) set.add(slug(h[1])); }
  return set;
}

let failed = 0;
const fail = (m) => { failed++; console.error('실패: ' + m); };
const ok = (m) => console.log('통과: ' + m);

const mds = {};
for (const p of PAIRS) { const f = join(ROOT, p.md); if (!existsSync(f)) { fail(`${p.md} 없음`); continue; } mds[p.md] = readFileSync(f, 'utf8').replace(/^﻿/, ''); }
if (failed) process.exit(1);

// ① 한국어 ↔ 영어 구조
const sk = structure(mds['README.md']), se = structure(mds['README.en.md']);
for (const k of Object.keys(sk)) (sk[k] === se[k]) ? ok(`ko/en 구조 동일: ${k} = ${sk[k]}`) : fail(`ko/en 구조 다름: ${k} ko=${sk[k]} en=${se[k]}`);

for (const p of PAIRS) {
  const md = mds[p.md];
  // ② 앵커
  const an = anchors(md); const bad = [];
  for (const m of md.matchAll(/\]\(#([^)]+)\)/g)) if (!an.has(m[1])) bad.push(m[1]);
  bad.length ? fail(`${p.md}: 끊어진 목차/내부 링크 ${bad.length}개: ${[...new Set(bad)].slice(0, 5).join(', ')}`) : ok(`${p.md}: 내부 링크 ${(md.match(/\]\(#/g) || []).length}개 모두 헤딩에 연결됨`);
  // html 만들기
  const title = (/^#\s+(.*)$/m.exec(md) || [, p.md])[1];
  const html = page(render(md, p.lang), p.lang, title);
  const hf = join(ROOT, p.html);
  if (CHECK_ONLY) {
    const disk = existsSync(hf) ? readFileSync(hf, 'utf8') : '';
    disk === html ? ok(`${p.html}: 디스크 파일이 md 에서 만든 결과와 같음`) : fail(`${p.html}: 디스크 파일이 md 와 다름(node build-readme.mjs 로 다시 만드세요)`);
  } else { writeFileSync(hf, html, 'utf8'); ok(`${p.html} 작성 (${html.length} 글자)`); }
  // ③ 글자 동일
  const a = plainFromMd(md), b = plainFromHtml(html);
  if (a === b) ok(`${p.md} ↔ ${p.html}: 글자 동일 (${a.length}자)`);
  else { let k = 0; while (k < a.length && a[k] === b[k]) k++; fail(`${p.md} ↔ ${p.html}: 글자 다름 @${k}\n  md  : …${a.slice(Math.max(0, k - 40), k + 60)}\n  html: …${b.slice(Math.max(0, k - 40), k + 60)}`); }
  // ④ 변환 안 된 표시
  const body = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<pre>[\s\S]*?<\/pre>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '');
  const leftovers = [];
  if (/\*\*/.test(body)) leftovers.push('**');
  if (/`/.test(body)) leftovers.push('백틱');
  if (/\|\s*-{3,}/.test(body)) leftovers.push('표 구분선');
  if (/&lt;\/?(details|summary)/.test(body)) leftovers.push('details 태그가 글자로 보임');
  leftovers.length ? fail(`${p.html}: 변환 안 된 표시 ${leftovers.join(', ')}`) : ok(`${p.html}: 변환 안 된 마크다운 표시 없음`);
  const det = (html.match(/<details>/g) || []).length, detEnd = (html.match(/<\/details>/g) || []).length;
  det === detEnd && det === structure(md).details ? ok(`${p.html}: 접이식(details) ${det}개 짝 맞음`) : fail(`${p.html}: details 짝 불일치 ${det}/${detEnd}`);
}
console.log(failed ? `\n검사 실패 ${failed}건` : '\n모든 검사 통과');
process.exit(failed ? 1 : 0);
