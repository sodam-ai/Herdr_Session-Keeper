// herdr-mod/session-keeper/model.js 시험: 창의 데이터 로직(항목 만들기·프로젝트별 묶기·검색). 화면(GPUI)은 여기서 그릴 수 없어 이 부분만 Node 로 시험한다.
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const M = await import(pathToFileURL(join(ROOT, 'herdr-mod', 'session-keeper', 'model.js')).href);
const { STATUS, cleanName, ago, matchItem, buildItems, groupLabel, groupDead } = M;
let pass = 0, fail = 0; const out = [];
const ok = (n, c, d = '') => { c ? pass++ : fail++; out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <-- ' + d}`); };
const NOW = 1_800_000_000_000;
const { isResumeId, resumeCommand, idChip } = M;
const U1 = '01a0d0f0-aa8d-7020-90b6-4780f6a4adcb', U2 = '12345678-213b-44a0-8d46-3064d3c085cb';

// ---- resume ID 복사 (명령·칩)
ok('isResumeId: UUID 만 참, 그 밖(빈값·null·짧은 ID·셸 문자)은 거짓', isResumeId(U1) && isResumeId(U1.toUpperCase()) && !isResumeId('') && !isResumeId(null) && !isResumeId(undefined) && !isResumeId('01a0d0f0') && !isResumeId(U1 + "'; calc") && !isResumeId('t12s'));
ok('resumeCommand: Claude = claude --resume <ID>', resumeCommand({ ai: 'Claude Code', fullId: U2 }) === `claude --resume ${U2}`);
ok('resumeCommand: Codex = codex resume <ID>', resumeCommand({ ai: 'Codex', fullId: U1 }) === `codex resume ${U1}`);
ok('resumeCommand: ID 가 없거나 잘못되면 빈 문자열(복사 버튼 없음)', resumeCommand({ ai: 'Codex', fullId: '' }) === '' && resumeCommand({ ai: 'Claude Code', fullId: "x'; Remove-Item *" }) === '' && resumeCommand(null) === '' && resumeCommand({}) === '');
ok('resumeCommand: AI 가 비어 있으면 Claude 로 간주', resumeCommand({ fullId: U2 }) === `claude --resume ${U2}`);
ok('idChip: ID 가 있으면 앞 8자 칩(ok)', idChip({ ai: 'Codex', fullId: U1 }).ok === true && idChip({ ai: 'Codex', fullId: U1 }).label === 'ID 01a0d0f0');
ok('idChip: 열린 창인데 ID 가 없으면 "ID 확인 불가" + 이유(Codex 는 같은 폴더 안내)', idChip({ ai: 'Codex', fullId: '' }).ok === false && idChip({ ai: 'Codex', fullId: '' }).label === 'ID 확인 불가' && /같은 폴더/.test(idChip({ ai: 'Codex', fullId: '' }).why) && !/같은 폴더/.test(idChip({ ai: 'Claude Code', fullId: '' }).why) && idChip({ ai: 'Claude Code', fullId: '' }).why !== '');
ok('idChip: null·이상한 값도 예외 없이 "확인 불가"', idChip(null).ok === false && idChip({}).ok === false && idChip({ fullId: 12345 }).ok === false);

// ---- 작은 도구
ok('cleanName: 날짜 접두어(26y_06m_10d_) 제거', cleanName('프로젝트 / 26y_06m_10d_SoDam-WikiMate') === '프로젝트 / SoDam-WikiMate' && cleanName(null) === '' && cleanName('일반 이름') === '일반 이름');
ok('ago: 방금/분/시간/어제/일', ago(NOW - 30e3, NOW) === '방금' && ago(NOW - 10 * 60e3, NOW) === '10분 전' && ago(NOW - 3 * 3600e3, NOW) === '3시간 전' && ago(NOW - 30 * 3600e3, NOW) === '어제' && ago(NOW - 5 * 86400e3, NOW) === '5일 전', [30e3, 600e3, 10800e3, 108000e3, 432000e3].map((d) => ago(NOW - d, NOW)).join(','));
ok('STATUS: 승인 대기가 가장 먼저(사람이 필요한 순)', STATUS.blocked.order < STATUS.done.order && STATUS.done.order < STATUS.working.order && STATUS.working.order < STATUS.idle.order);
ok('matchItem: 빈 검색어는 전부 일치, 대소문자·ID·AI·모델 검색', matchItem({ title: 'A' }, '') && matchItem({ title: 'Hello World', where: '', ai: 'Codex', model: 'gpt-6', idShort: 'abc12345', fullId: '', text: '' }, 'hello') && matchItem({ title: 't', ai: 'Codex', model: 'gpt-6.1', idShort: 'abc12345', text: '', where: '', fullId: '' }, 'abc123') && !matchItem({ title: 'x', ai: '', model: '', idShort: '', text: '', where: '', fullId: '' }, '없는말'));

// ---- buildItems
const rows = [
  { ai: 'Claude Code', sid: 'c1', short: 'c1c1c1c1', title: '클로드 열린 창', model: 'Opus 5.5', live: true, addr: 't1', where: 'W', cwd: 'C:\\p\\a', folder: 'a', mtimeMs: 5000, lastPrompt: '질문1' },
  { ai: 'Codex', sid: 'x1', short: 'x1x1x1x1', title: '코덱스 열린 창', model: 'gpt-6.1', live: true, addr: 't2', where: 'W2', cwd: 'C:\\p\\b', folder: 'b', mtimeMs: 4000, lastPrompt: '' },
  { ai: 'Claude Code', sid: 'o1', short: 'o1o1o1o1', title: '밖에서 실행', model: '', live: true, addr: '', where: '', cwd: 'C:\\p\\c', folder: 'c', mtimeMs: 3000, lastPrompt: '' },
  { ai: 'Claude Code', sid: 'd1', short: 'd1d1d1d1', title: '꺼진 클로드', model: 'Sonnet 5.5', live: false, addr: '', where: '프로젝트 / 26y_06m_10d_Kakao', cwd: 'C:\\p\\a', folder: 'a', mtimeMs: 2000, lastPrompt: '' },
  { ai: 'Codex', sid: 'd2', short: 'd2d2d2d2', title: '꺼진 코덱스', model: 'gpt-6.1', live: false, addr: '', where: '', cwd: 'C:\\p\\a', folder: 'a', mtimeMs: 1000, lastPrompt: '' },
];
const agentList = [
  { address: 't1', status: 'idle', app: 'claude-code', program: { name: 'Claude Code' }, title: '창 제목1', space_name: '프로젝트', tab_name: '26y_06m_10d_Kakao' },
  { address: 't2', status: 'blocked', app: 'codex', program: { name: 'Codex' }, title: '창 제목2', space_name: '~', tab_name: '1' },
  { address: 't3', status: 'working', app: 'claude-code', program: { name: 'Claude Code' }, title: '기록 없는 새 창', space_name: 'S', tab_name: 'T' },
  { address: 't4', status: 'done', app: 'pi', program: { name: 'Pi' }, title: '다른 AI', space_name: 'S', tab_name: 'U' },
];
const bi = buildItems(rows, agentList);
const by = Object.fromEntries([...bi.live, ...bi.dead].map((x) => [x.key, x]));
ok('열린 Claude 창: 세션 행(주소 일치)의 제목·모델·ID 를 붙임, 위치는 날짜 접두어 제거', by['live-t1'].title === '클로드 열린 창' && by['live-t1'].model === 'Opus 5.5' && by['live-t1'].fullId === 'c1' && by['live-t1'].where === '프로젝트 / Kato'.replace('Kato', 'Kakao'), JSON.stringify(by['live-t1']));
ok('열린 Codex 창: 행의 ai(Codex)·모델·ID 를 사용', by['live-t2'].ai === 'Codex' && by['live-t2'].model === 'gpt-6.1' && by['live-t2'].fullId === 'x1' && by['live-t2'].idKind === 'ID');
ok('기록 없는 새 창: 창 주소를 ID 대신 표시, 제목은 창 제목', by['live-t3'].idKind === '창' && by['live-t3'].idShort === 't3' && by['live-t3'].fullId === '' && by['live-t3'].title === '기록 없는 새 창');
ok('Claude·Codex 가 아닌 AI 창도 목록에 포함(AI 이름은 프로그램 이름)', by['live-t4'].ai === 'Pi' && by['live-t4'].fullId === '');
ok('Herdr 밖에서 실행 중인 세션은 별도 항목, 창 이동 불가(addr 비어 있음)', by['out-o1']?.where === 'Herdr 밖에서 실행 중' && by['out-o1'].addr === '' && by['out-o1'].live === true);
ok('열린 창에 이미 연결된 세션이 "밖" 항목으로 중복되지 않음', !by['out-c1'] && !by['out-x1']);
ok('정렬: 승인 대기(blocked) → 끝남 → 작업 중 → 대기', bi.live.map((x) => x.status).join() === 'blocked,done,working,idle,idle', bi.live.map((x) => x.status).join());
ok('꺼진 세션: AI·모델·폴더 경로를 가지고, 위치는 창 기록(없으면 폴더 이름)', by['dead-d1'].ai === 'Claude Code' && by['dead-d1'].where === '프로젝트 / Kakao' && by['dead-d2'].ai === 'Codex' && by['dead-d2'].where === 'a' && by['dead-d2'].cwd === 'C:\\p\\a');
ok('입력 배열을 바꾸지 않는다(불변)', rows[0].title === '클로드 열린 창' && rows.length === 5 && agentList.length === 4);
const e = buildItems([], []);
ok('빈 입력도 오류 없이 빈 목록', e.live.length === 0 && e.dead.length === 0);

// ---- 프로젝트별 묶기
ok('groupLabel: 폴더 이름, 홈 폴더, 폴더 정보 없음, 날짜 접두어 제거', groupLabel('C:\\Users\\PC\\proj-a', 'C:\\Users\\PC') === 'proj-a' && groupLabel('C:\\Users\\PC\\', 'c:\\users\\pc') === '홈 폴더' && groupLabel('', 'C:\\x') === '(폴더 정보 없음)' && groupLabel('D:\\w\\26y_10m_27d_Kakao', '') === 'Kakao' && groupLabel('C:\\', '') === 'C:');
const mk = (n, cwd, at) => ({ key: `d${n}`, live: false, title: `세션${n}`, where: '', ai: 'Claude Code', model: '', idShort: `id${n}`, fullId: `full${n}`, text: '', cwd, sortAt: at });
const items = [mk(1, 'C:\\p\\A', 100), mk(2, 'C:\\p\\A\\', 300), mk(3, 'C:\\p\\B', 250), mk(4, 'C:\\p\\B', 240), mk(5, 'C:\\p\\B', 230), mk(6, 'C:\\p\\B', 220), mk(7, 'C:\\p\\C', 50), mk(8, 'C:\\p\\C', 40), mk(9, 'C:\\p\\D', 10), mk(10, '', 5), mk(11, 'C:\\p\\E', 4), mk(12, 'C:\\p\\E', 3), mk(13, 'C:\\p\\E', 2), mk(14, 'C:\\p\\E', 1)];
const g = groupDead(items);
ok('같은 폴더(대소문자·끝 슬래시 차이 무시)는 한 그룹', g.find((x) => x.label === 'A')?.count === 2, JSON.stringify(g.map((x) => [x.label, x.count])));
ok('그룹은 가장 최근에 쓴 순서, 그룹 안은 최근 순', g[0].label === 'A' && g[0].items[0].key === 'd2' && g[1].label === 'B' && g[1].items.map((x) => x.key).join() === 'd3,d4,d5,d6', g.map((x) => x.label).join());
ok('기본 펼침: 최근 2개 그룹 + 3개 이하인 그룹은 펼침, 나머지(4개 이상)는 접음', g[0].open && g[1].open && g.find((x) => x.label === 'C').open && g.find((x) => x.label === 'D').open && !g.find((x) => x.label === 'E').open, g.map((x) => x.label + ':' + x.open).join(' '));
ok('폴더 정보 없는 세션도 한 그룹으로 묶임', g.some((x) => x.label === '(폴더 정보 없음)' && x.count === 1));
const gOv = groupDead(items, { openOverrides: { 'c:\\p\\e': true, 'c:\\p\\a': false } });
ok('사용자가 누른 상태가 기본값보다 우선(펼침/접힘)', gOv.find((x) => x.label === 'E').open === true && gOv.find((x) => x.label === 'A').open === false);
const gSearch = groupDead(items, { filter: '  세션13  ' });
ok('검색 중에는 일치하는 그룹만, 전부 펼침(접힌 그룹 안의 세션도 찾을 수 있음)', gSearch.length === 1 && gSearch[0].label === 'E' && gSearch[0].open && gSearch[0].items.map((x) => x.key).join() === 'd13', JSON.stringify(gSearch.map((x) => [x.label, x.open, x.count])));
ok('검색 결과가 없으면 빈 배열', groupDead(items, { filter: '없는검색어' }).length === 0 && groupDead([]).length === 0);
ok('홈 폴더 이름 표시(home 옵션)', groupDead([mk(1, 'C:\\Users\\PC', 1)], { home: 'C:\\Users\\PC\\' })[0].label === '홈 폴더');
const before = JSON.stringify(items);
groupDead(items, { filter: 'x', openOverrides: { a: true } });
ok('groupDead 는 입력을 바꾸지 않는다(불변)', JSON.stringify(items) === before);
ok('모든 항목이 정확히 한 그룹에 속한다(누락·중복 없음)', g.reduce((s, x) => s + x.count, 0) === items.length && new Set(g.flatMap((x) => x.items.map((i) => i.key))).size === items.length);

// ---- 복구 대기 / 꺼진 세션 정리 (2026-11-04 추가)
const { niceTitle, pendingState, canAutoRecover, groupPending, dedupeDead, filterAi, lastBanner, MAX_ATTEMPTS } = M;
const kp = (addr, space, tab, extra = {}) => ({ pending: true, addr, work: `${space} / ${tab}`, space, tab, attempts: 0, orphan: true, seenMs: NOW - 3600e3, ...extra });
const prow = (sid, o = {}) => ({ ai: 'Claude Code', sid, short: sid.slice(0, 8), title: `제목-${sid}`, model: '', live: false, addr: '', where: '', cwd: 'C:\\Users\\PC', folder: 'PC', mtimeMs: NOW - 5 * 3600e3, lastPrompt: '', ...o });
const pb = buildItems([
  prow('p1', { keeper: kp('t1', '!_Group-A', 'Tab-10') }), prow('p2', { keeper: kp('t2', '!_Group-A', 'Tab-2') }),
  prow('p3', { keeper: kp('t3', '프로젝트', '26y_06m_10d_SoDam-WikiMate', { attempts: 3 }) }), prow('p4', { missing: true, title: '(대화 기록을 찾지 못했습니다)', keeper: kp('t4', '프로젝트', 'X') }),
  prow('p5', { ai: 'Codex', keeper: kp('t5', '프로젝트', 'Codex창') }),
  prow('d1', { keeper: { ...kp('t9', 'S', 'T'), pending: false } }), prow('d2'), prow('d3', { live: true, addr: 't7', where: 'W', keeper: { ...kp('t7', 'S', 'T'), pending: false } }),
], [], { home: 'C:\\Users\\PC' });
ok('buildItems: keeper.pending 인 꺼진 세션은 pending, 나머지 꺼진 세션은 dead', pb.pending.map((x) => x.fullId).sort().join() === 'p1,p2,p3,p4,p5' && pb.dead.map((x) => x.fullId).sort().join() === 'd1,d2', `${pb.pending.map((x) => x.fullId)} / ${pb.dead.map((x) => x.fullId)}`);
ok('buildItems: 실행 중(live)인 세션은 keeper 정보가 있어도 pending 에 안 들어간다', !pb.pending.some((x) => x.fullId === 'd3'));
ok('buildItems: 복구 대기 항목의 위치는 키퍼가 기억하는 작업 이름(Codex 도 동일)', pb.pending.find((x) => x.fullId === 'p5').where === '프로젝트 / Codex창' && pb.pending.find((x) => x.fullId === 'p3').where === '프로젝트 / SoDam-WikiMate');
ok('buildItems: 기존 모양 호환 — 3번째 인자 없이도 동작, pending 은 빈 배열', buildItems([], []).pending.length === 0 && buildItems(rows, agentList).pending.length === 0);

ok('niceTitle: 정상 제목은 그대로', niceTitle('README 정리', 'C:\\p\\a') === 'README 정리');
ok('niceTitle: "! powershell…"·시스템 태그·제목 없음은 폴더 이름으로 대신함', niceTitle('! powershell -NoProfile -Execu', 'C:\\Users\\PC', 'C:\\Users\\PC') === '홈 폴더 폴더의 작업 (이름 없음)' && niceTitle('<command-name>/x', 'C:\\w\\Kakao') === 'Kakao 폴더의 작업 (이름 없음)' && niceTitle('(제목 없음)', '') === '(폴더 정보 없음) 폴더의 작업 (이름 없음)' && niceTitle('', 'C:\\w\\A') === 'A 폴더의 작업 (이름 없음)');
ok('pendingState: 닫히기 직전이 아닌 옛 항목(auto:false)은 "직접 복구", 대상(auto:true)/표시 없음은 "복구 대기"',
  pendingState({ keeper: { auto: false, attempts: 0 } }).word === '직접 복구' && pendingState({ keeper: { auto: true, attempts: 0 } }).word === '복구 대기' && pendingState({ keeper: { attempts: 0 } }).word === '복구 대기'
  && pendingState({ missing: true, keeper: { auto: false } }).word === '복구 불가' && pendingState({ keeper: { auto: false, attempts: 3 } }).word === '자동 복구 실패');
ok('pendingState: 복구 불가 > 자동 복구 실패 > 복구 대기', pendingState(pb.pending.find((x) => x.fullId === 'p4')).word === '복구 불가' && pendingState(pb.pending.find((x) => x.fullId === 'p3')).word === '자동 복구 실패' && pendingState(pb.pending.find((x) => x.fullId === 'p1')).word === '복구 대기' && pendingState(pb.pending[0]).tone !== undefined);
ok('canAutoRecover: 기록 있고 시도 한도 미만이고 창 주소가 있을 때만', canAutoRecover(pb.pending.find((x) => x.fullId === 'p1')) && !canAutoRecover(pb.pending.find((x) => x.fullId === 'p3')) && !canAutoRecover(pb.pending.find((x) => x.fullId === 'p4')) && !canAutoRecover({ keeper: { attempts: 0, addr: '' } }) && MAX_ATTEMPTS === 3);
const gp = groupPending(pb.pending);
ok('groupPending: 공간 이름으로 묶고, 안에서는 탭 이름 숫자 순서(Tab-2 가 Tab-10 보다 먼저)', gp.length === 2 && gp.find((g) => g.label === '!_Group-A').items.map((x) => x.fullId).join() === 'p2,p1' && gp.find((g) => g.label === '프로젝트').count === 3, JSON.stringify(gp.map((g) => [g.label, g.items.map((x) => x.fullId)])));
const { natCmp } = M;
ok('natCmp: 숫자는 크기순(2 < 10), 대소문자 무시, 같으면 0, 짧은 쪽이 먼저', ['Tab-10', 'Tab-2', 'Tab-Master', 'Tab-1', 'tab-3'].sort(natCmp).join() === 'Tab-1,Tab-2,tab-3,Tab-10,Tab-Master' && natCmp('a', 'A') === 0 && natCmp('탭', '탭 2') < 0 && natCmp('', '') === 0 && natCmp(null, 'a') < 0, ['Tab-10', 'Tab-2', 'Tab-Master', 'Tab-1', 'tab-3'].sort(natCmp).join());
{ // 실행 환경이 localeCompare 의 옵션을 무시해도 정렬이 같아야 한다(Herdr 모드 실행 환경이 그랬음)
  const lc = String.prototype.localeCompare; String.prototype.localeCompare = function (o) { return this < o ? -1 : this > o ? 1 : 0; };
  try { const g2 = groupPending(pb.pending); ok('groupPending: localeCompare 가 숫자 옵션을 무시해도 Tab-2 → Tab-10', g2.find((g) => g.label === '!_Group-A').items.map((x) => x.fullId).join() === 'p2,p1'); } finally { String.prototype.localeCompare = lc; }
}
ok('groupPending: 공간 이름이 "~"(홈)이면 "홈 (~)"로 표시', groupPending([prow('h', { keeper: kp('t8', '~', '1') })])[0].label === '홈 (~)');
ok('groupPending: 빈 입력·공간 정보 없음 처리', groupPending([]).length === 0 && groupPending([prow('z', { keeper: { pending: true, space: '', tab: '', attempts: 0 } })])[0].label === '(공간 정보 없음)');

const dd = (n, title, at, cwd = 'C:\\w', ai = 'Claude Code') => ({ key: `k${n}`, live: false, title, ai, cwd, sortAt: at, where: '', model: '', idShort: `i${n}`, fullId: `f${n}`, text: '' });
const dded = dedupeDead([dd(1, '건축시각화 프로젝트 test의 sample 단계 제작을 재개하려고', 100), dd(2, '건축시각화 프로젝트 test의 sample 단계 제작을 재개하려고  ', 300), dd(3, '건축시각화 프로젝트 test의 sample 단계 제작을 재개하려고', 200), dd(4, '다른 제목', 50), dd(5, '건축시각화 프로젝트 test의 sample 단계 제작을 재개하려고', 90, 'C:\\other'), dd(6, '건축시각화 프로젝트 test의 sample 단계 제작을 재개하려고', 80, 'C:\\w', 'Codex')]);
ok('dedupeDead: 같은 AI·폴더·제목은 가장 최근 것 하나로 접고 개수를 센다(폴더·AI 가 다르면 별개)', dded.length === 4 && dded.find((x) => x.key === 'k2')?.dups === 2 && !dded.some((x) => x.key === 'k1' || x.key === 'k3') && dded.find((x) => x.key === 'k4').dups === 0, JSON.stringify(dded.map((x) => [x.key, x.dups])));
const gdd = groupDead([dd(1, '같은 제목', 100), dd(2, '같은 제목', 300), dd(3, '같은 제목', 200)]);
ok('groupDead: 비슷한 세션은 접히지만 그룹 개수는 전체(3개)로 센다', gdd[0].items.length === 1 && gdd[0].count === 3 && gdd[0].items[0].key === 'k2' && gdd[0].items[0].dups === 2, JSON.stringify(gdd.map((g) => [g.items.length, g.count])));
const many = [dd(1, 'A', 900, 'C:\\a'), dd(2, 'B', 800, 'C:\\b'), ...Array.from({ length: 6 }, (_, i) => dd(10 + i, '같은 제목', 100 + i, 'C:\\c'))];
ok('groupDead: 비슷한 세션이 접혀 보이는 줄이 1개면(총 6개여도) 기본 펼침', groupDead(many).find((g) => g.label === 'c').open === true && groupDead(many).find((g) => g.label === 'c').count === 6);
const gds = groupDead([dd(1, '같은 제목', 100), dd(2, '같은 제목', 300), dd(3, '같은 제목', 200)], { filter: '같은' });
ok('groupDead: 검색 중에는 비슷한 세션도 전부 보여 준다', gds[0].items.length === 3 && gds[0].count === 3);
ok('filterAi: 전체/Claude/Codex', filterAi(pb.pending, 'all').length === 5 && filterAi(pb.pending, 'claude').length === 4 && filterAi(pb.pending, 'codex').length === 1 && filterAi([], 'codex').length === 0);

ok('lastBanner: 기록 없음 안내', lastBanner(null).level === 'none' && /아직 자동 복구 기록이 없습니다/.test(lastBanner(null).text));
const lb = lastBanner({ at: '2026-11-03 17:33', verdict: '정상 - 전부 복구됨(또는 이미 실행 중)', level: 'ok', tally: '대상 24개 = 성공 24 / 실패 0 / 건너뜀 0 (그중 이미 실행 중 0) / 시간 안에 못 끝낸 것 0' });
ok('lastBanner: 시각(월-일 시:분)·판정·집계를 쉬운 말로', lb.level === 'ok' && lb.attention === false && lb.text === '마지막 복구 11-03 17:33 · 정상 — 전부 복구됨(또는 이미 실행 중)' && lb.detail === '24개 중 24개 복구', JSON.stringify(lb));
ok('lastBanner: 시각이 없어도 깨지지 않음, 주의·확인 필요만 attention', lastBanner({ verdict: '주의 - x', level: 'warn' }).text === '마지막 복구 주의 — x' && lastBanner({ verdict: '주의 - x', level: 'warn' }).attention && lastBanner({ verdict: '확인 필요 - y', level: 'bad' }).attention && !lastBanner({ verdict: '복구할 것 없음', level: 'none' }).attention && !lastBanner(null).attention);
ok('lastBanner: "N 개" 띄어쓰기 정리', lastBanner({ verdict: '주의 - 확인이 필요한 창 2 개', level: 'warn' }).text.endsWith('확인이 필요한 창 2개'));
const { plainTally, liveSummary, filterLive, groupLive, planWord, planSummary, STATUS_KEYS } = M;
ok('plainTally: 실패·건너뜀·이미 실행 중·시간 모자람을 쉬운 말로, 0 은 생략', plainTally('대상 12개 = 성공 10 / 실패 1 / 건너뜀 1 (그중 이미 실행 중 0) / 시간 안에 못 끝낸 것 0') === '12개 중 10개 복구 · 1개 실패 · 1개 건너뜀' && plainTally('대상 5개 = 성공 2 / 실패 0 / 건너뜀 2 (그중 이미 실행 중 2) / 시간 안에 못 끝낸 것 1') === '5개 중 2개 복구 · 2개 건너뜀(2개는 이미 실행 중) · 1개는 시간이 모자라 못 끝냄');
ok('plainTally: 모르는 모양이면 원문 그대로, 빈 입력은 빈 글자', plainTally('다른 문구') === '다른 문구' && plainTally(null) === '' && plainTally(undefined) === '');

// ---- 열려 있는 창: 상태 요약·거르기·공간별 묶기 (2026-11-04 2차)
const lv = (key, space, tab, status, title = key) => ({ key, live: true, space, tab, where: `${space} / ${tab}`, status, title, ai: 'Claude Code' });
const L = [lv('a', '관제', 'Tab-10', 'done'), lv('b', '관제', 'Tab-2', 'blocked'), lv('c', '프로젝트', 'WikiMate', 'blocked'), lv('d', '프로젝트', 'Kakao', 'blocked'), lv('e', '프로젝트', 'SeoMedic', 'working'), lv('f', '~', '1', 'idle'), lv('g', '관제', 'Tab-Master', 'weird')];
ok('liveSummary: 상태별 개수(알 수 없는 상태는 대기로)', JSON.stringify(liveSummary(L)) === '{"blocked":3,"working":1,"done":1,"idle":2}' && STATUS_KEYS.join() === 'blocked,working,done,idle', JSON.stringify(liveSummary(L)));
ok('filterLive: 상태로 거르기(all 은 전부, 알 수 없는 상태는 idle)', filterLive(L, 'blocked').length === 3 && filterLive(L, 'idle').length === 2 && filterLive(L, 'all').length === 7 && filterLive(L, '').length === 7 && filterLive([], 'done').length === 0);
const gl = groupLive(L);
ok('groupLive: 승인 대기가 많은 공간이 먼저(프로젝트 2 > 관제 1), 개수 일치', gl.map((g) => g.label).join() === '프로젝트,관제,홈 (~)' && gl[0].blocked === 2 && gl[0].count === 3 && gl.reduce((n, g) => n + g.count, 0) === L.length, gl.map((g) => g.label + g.blocked).join());
ok('groupLive: 공간 안은 승인 대기 → 끝남/작업 중 → 대기, 같은 상태면 탭 이름 숫자 순서', gl[1].items.map((x) => x.key).join() === 'b,a,g' && gl[0].items.map((x) => x.key).join() === 'd,c,e', gl.map((g) => g.items.map((x) => x.key).join('')).join('|'));
ok('groupLive: 입력을 바꾸지 않고 빈 입력도 안전', groupLive([]).length === 0 && L[0].key === 'a' && L.length === 7);
const pbl = buildItems([], [{ address: 't1', status: 'blocked', app: 'claude-code', title: 'T', space_name: '26y_06m_10d_프로젝트', tab_name: '26y_06m_10d_Kakao' }]);
ok('buildItems: 열린 창에 space/tab(날짜 접두어 제거)이 붙는다', pbl.live[0].space === '프로젝트' && pbl.live[0].tab === 'Kakao');
ok('planWord / planSummary: 미리보기를 쉬운 말로', planWord({ action: 'TYPE' }) === '빈 창에 이어서 입력' && planWord({ action: 'CREATE' }) === '새 탭으로 열기' && planWord({ action: 'SKIP', reason: '시도 3회 초과' }) === '건너뜀 — 시도 3회 초과' && planWord(null) === '' && planSummary([{ action: 'TYPE' }, { action: 'CREATE' }, { action: 'CREATE' }, { action: 'SKIP' }]) === '빈 창에 입력 1 · 새 탭 2 · 건너뜀 1' && planSummary([]) === '복구할 작업 없음');

// ---- Herdr 앱 업데이트 한 줄
const { appUpdateLine } = M;
ok('appUpdateLine: 새 버전 대기(ready)면 버전 두 개와 [업데이트] 버튼', (() => { const l = appUpdateLine({ kind: 'ready', auto: true, installed: '0.1.14', staged: '0.1.15' }); return l && l.apply && l.text.includes('0.1.15') && l.text.includes('0.1.14'); })());
ok('appUpdateLine: 파일은 새것·창은 옛것(restart)이면 껐다 켜라는 안내', (() => { const l = appUpdateLine({ kind: 'restart', auto: true, installed: '0.1.15' }); return l && l.apply && /껐다 켜/.test(l.text); })());
ok('appUpdateLine: 최신이고 자동 켜짐이면 아무것도 보이지 않는다(null)', appUpdateLine({ kind: 'none', auto: true }) === null);
ok('appUpdateLine: 자동이 꺼져 있으면 다시 켤 수 있게 줄을 보인다(버튼 없음)', (() => { const l = appUpdateLine({ kind: 'none', auto: false }); return l && !l.apply && !l.auto; })());
ok('appUpdateLine: null·이상한 입력도 예외 없이 null', appUpdateLine(null) === null && appUpdateLine('x') === null && appUpdateLine({}) === null);

console.log(out.join('\n')); console.log(`\n합계: PASS ${pass} / FAIL ${fail}`); process.exit(fail ? 1 : 0);
