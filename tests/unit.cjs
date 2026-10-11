const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..');
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS', name);
}
class FakeInput {
  constructor(value = '') { this._value = value; this.events = []; }
  get value() { return this._value; }
  set value(value) { this._value = value; }
  dispatchEvent(event) { this.events.push(event.type); }
}
class FakeTextArea extends FakeInput {}
const ctx = {
  setTimeout, clearTimeout, Event, TextDecoder, URL,
  HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeTextArea,
  getComputedStyle: () => ({ visibility: 'visible' }),
  document: { addEventListener() {}, querySelectorAll: () => [] },
  window: { addEventListener() {} },
  innerHeight: 900
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(base, 'csv.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(base, 'local-ai.js'), 'utf8'), ctx);
let content = fs.readFileSync(path.join(base, 'content.js'), 'utf8');
content = content.replace(/  start\(\);\s*\}\)\(\);\s*$/, `  globalThis.testAPI = {
    rowText, lengthOf, targets, jump, setInput, showCandidate, loadCSV, limitsValid,
    generateAI, updateAIButton,
    configureAI(settings) { aiSettings = settings; aiButton = null; },
    configure(options) {
      root = options.root; bar = options.bar; status = options.status;
      count = options.count; shortInput = options.shortInput; longInput = options.longInput;
      previousButton = options.previousButton; nextButton = options.nextButton;
      csvStatus = options.csvStatus; candidates = options.candidates || [];
      candidateIndex = -1; useViewport = true; shortLimit = 5; longLimit = 200;
    },
    getState: () => ({ candidates, candidateIndex, busy }),
    setNote(value) { note = value; }
  };
})();`);
vm.runInContext(content, ctx);
const csv = ctx.ListenProofreaderCSV;
const api = ctx.testAPI;
check('RFC4180 quoted comma, double quote, BOM, CRLF, multiline', () => {
  const result = csv.candidatesFromCSV('\uFEFF誤字,修正案,備考\r\n"a,b","c""d","line1\nline2"\r\n');
  assert.equal(result.candidates[0].before, 'a,b');
  assert.equal(result.candidates[0].after, 'c"d');
  assert.equal(result.candidates[0].note, 'line1\nline2');
});
check('headerless CSV, empty replacement, skipped blank typo', () => {
  const result = csv.candidatesFromCSV(' x ,,delete\n,y,skip\n\n');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].before, 'x');
  assert.equal(result.candidates[0].after, '');
  assert.equal(result.skipped, 1);
});
check('reject malformed CSV', () => {
  for (const source of ['a,b,c,d', 'a', '"a,b', 'a"b,c', '"a"b,c', '\n,,\n']) {
    assert.throws(() => csv.candidatesFromCSV(source));
  }
});
function row(text, speaker, index, textarea) {
  const classes = new Set();
  return {
    isConnected: true, dataset: { segmentIndex: String(index) },
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    querySelector: selector => selector === 'select' ? { value: speaker, focus() {} } : { textContent: text },
    querySelectorAll: () => textarea ? [textarea] : [],
    getBoundingClientRect: () => ({ bottom: 500 + index * 100 }),
    scrollIntoView() { this.scrolled = true; }, focus() {}, hasAttribute: () => false,
    classes
  };
}
const rows = [row('あ'.repeat(210), '0', 0), row('あ', '-1', 1), row('あ'.repeat(5), '0', 2), row('あ'.repeat(200), '-1', 3), row('', '0', 4)];
const status = { textContent: '' };
const bar = { isConnected: false, getBoundingClientRect: () => ({ bottom: 100 }) };
const root = {
  querySelectorAll: selector => selector === '.lp-current' ? rows.filter(row => row.classes.has('lp-current')) : rows,
  querySelector: () => null
};
const previousButton = {};
const nextButton = {};
const shortInput = { value: '5' };
const longInput = { value: '200' };
const csvStatus = {};
function configure(overrides = {}) {
  api.configure({ root, bar, status, count: {}, shortInput, longInput, previousButton, nextButton, csvStatus, ...overrides });
}
configure();
check('strict short/long boundaries, empty paragraphs, unassigned speakers', () => {
  assert.equal(api.targets('speaker').length, 2);
  assert.equal(api.targets('short').length, 2);
  assert.equal(api.targets('long').length, 1);
  assert.equal(api.targets('length').length, 3);
});
check('Unicode code points and whitespace', () => {
  assert.equal(api.lengthOf(row('あ \n 😀', '0', 0)), 2);
});
check('active textarea overrides old paragraph', () => {
  const textarea = new FakeTextArea('新しい本文');
  textarea.getClientRects = () => [{}];
  assert.equal(api.rowText(row('古い本文', '0', 0, textarea)), '新しい本文');
});
check('speaker traversal and wraparound', () => {
  api.jump('speaker'); assert.ok(rows[1].scrolled);
  api.jump('speaker'); assert.ok(rows[3].scrolled);
  api.jump('speaker'); assert.match(status.textContent, /先頭に戻りました/);
  assert.ok(rows[1].classes.has('lp-current'));
});
check('short and long navigation', () => {
  api.jump('short'); assert.ok(rows[4].classes.has('lp-current'));
  api.jump('long'); assert.ok(rows[0].classes.has('lp-current'));
});
check('reject invalid thresholds', () => {
  shortInput.value = '201'; assert.equal(api.limitsValid(), false);
  shortInput.value = ''; assert.equal(api.limitsValid(), false);
  shortInput.value = '5'; assert.equal(api.limitsValid(), true);
});
check('native setter dispatches reactive input and change events', () => {
  const input = new FakeInput();
  api.setInput(input, '修正案');
  assert.equal(input.value, '修正案');
  assert.deepEqual(input.events, ['input', 'change']);
});
(async () => {
  configure();
  api.configureAI({ enabled: false });
  api.updateAIButton();
  await api.generateAI();
  check('disabled AI creates no button or request', () => assert.equal(api.getState().busy, false));
  const source = fs.readFileSync(path.join(__dirname, 'sjis.csv'));
  await api.loadCSV({ name: 'sjis.csv', size: source.length, arrayBuffer: async () => source });
  check('Shift_JIS file decoding', () => {
    assert.equal(api.getState().candidates[0].before, '間違い');
    assert.match(status.textContent, /Shift_JIS/);
  });
  await api.loadCSV({ name: 'bad.csv', size: 7, arrayBuffer: async () => Buffer.from('a,b,c,d') });
  check('invalid CSV preserves previous candidates', () => {
    assert.equal(api.getState().candidates[0].before, '間違い');
    assert.match(status.textContent, /CSV読込失敗/);
  });
  await api.loadCSV({ name: 'big.csv', size: 6 * 1024 * 1024 });
  check('size limit checked before reading', () => assert.match(status.textContent, /5MB/));
  const before = new FakeInput();
  const after = new FakeInput();
  const regex = { classList: { contains: () => regex.active }, active: true, click() { this.active = false; } };
  const search = { disabled: false, count: 0, click() { this.count++; } };
  let panelOpen = true;
  let toggleCount = 0;
  const panel = { getClientRects: () => panelOpen ? [{}] : [] };
  const toggle = { click() { toggleCount++; panelOpen = !panelOpen; } };
  const form = {
    isConnected: true, parentElement: panel, contains: () => true,
    querySelector: selector => ({ '[x-model="replacementString"]': after, 'button[type="submit"]': search, 'button[aria-label="正規表現"]': regex })[selector]
  };
  before.closest = () => form;
  const replaceRoot = { querySelector: selector => ({
    '[x-ref="replaceBeforeInput"]': before,
    'button[aria-label="一括置換"]': toggle
  })[selector] };
  async function clickCandidate(index) {
    let stopped = false;
    const pending = api.showCandidate(index, { stopPropagation() { stopped = true; } });
    // Model a document-level @click.outside handler deferred by Alpine.
    const outside = stopped ? Promise.resolve() : new Promise(resolve => {
      setTimeout(() => { panelOpen = false; resolve(); }, 10);
    });
    await Promise.all([pending, outside]);
    assert.equal(stopped, true);
  }
  const candidates = [{ before: 'a.b', after: 'new', note: '<img onerror=alert(1)>' }, { before: 'delete', after: '', note: '' }];
  configure({ root: replaceRoot, candidates });
  const note = { textContent: '' };
  api.setNote(note);
  await clickCandidate(0);
  check('candidate inputs, literal search, search click, safe text note', () => {
    assert.equal(before.value, 'a.b'); assert.equal(after.value, 'new');
    assert.equal(search.count, 1); assert.equal(regex.active, false);
    assert.match(note.textContent, /<img onerror=alert\(1\)>/);
    assert.equal(api.getState().candidateIndex, 0);
    assert.equal(panelOpen, true);
    assert.equal(toggleCount, 0);
  });
  await clickCandidate(1);
  check('deletion and disable next at last candidate', () => {
    assert.equal(after.value, ''); assert.equal(nextButton.disabled, true);
    assert.equal(panelOpen, true);
    assert.equal(toggleCount, 0);
    assert.equal(search.count, 2);
  });
  await clickCandidate(0);
  check('previous candidate and busy reset', () => {
    assert.equal(before.value, 'a.b'); assert.equal(api.getState().busy, false);
    assert.equal(panelOpen, true);
    assert.equal(toggleCount, 0);
    assert.equal(search.count, 3);
  });
  panelOpen = false;
  await clickCandidate(1);
  check('closed replacement panel opens before candidate search', () => {
    assert.equal(panelOpen, true);
    assert.equal(toggleCount, 1);
    assert.equal(before.value, 'delete');
    assert.equal(search.count, 4);
    assert.equal(api.getState().candidateIndex, 1);
  });
  configure();
  await api.showCandidate(0);
  check('empty queue safely ignored', () => assert.equal(api.getState().candidateIndex, -1));
  configure({ candidates });
  await api.showCandidate(0);
  check('missing native form reports failure without advancing', () => {
    assert.match(status.textContent, /フォームが見つかりません/);
    assert.equal(api.getState().candidateIndex, -1);
  });
  const editorURL = 'https://listen.style/p/takamichie/20261011-recent-events-october/transcript_editor';
  ctx.location = { href: editorURL };
  let requestedURL;
  ctx.fetch = async url => {
    requestedURL = url;
    return { ok: true, headers: { get: () => 'text/plain; charset=utf-8' }, text: async () => '誤宇' };
  };
  ctx.AbortController = AbortController;
  ctx.setInterval = setInterval;
  ctx.clearInterval = clearInterval;
  let reply = { type: 'result', count: 1, csv: '誤字,修正案,備考\n誤宇,誤字,確認' };
  ctx.chrome = { runtime: { connect() {
    let onMessage;
    return {
      onMessage: { addListener(fn) { onMessage = fn; } },
      onDisconnect: { addListener() {} }, disconnect() {},
      postMessage(message) { if (message.type === 'generate') queueMicrotask(() => onMessage(reply)); }
    };
  } } };
  configure({ candidates });
  api.configureAI({ enabled: true, model: 'installed' });
  await api.generateAI();
  check('AI CSV enters existing candidate queue', () => {
    assert.equal(requestedURL, editorURL.replace('transcript_editor', 'transcript.txt'));
    assert.equal(api.getState().candidates[0].before, '誤宇');
    assert.equal(api.getState().candidateIndex, -1);
    assert.equal(api.getState().busy, false);
  });
  reply = { type: 'error', error: '接続失敗' };
  await api.generateAI();
  check('AI failure preserves candidates', () => {
    assert.equal(api.getState().candidates[0].before, '誤宇');
    assert.match(status.textContent, /AI生成失敗/);
  });
  reply = { type: 'result', count: 0, csv: null };
  await api.generateAI();
  check('empty AI result preserves candidates', () => {
    assert.equal(api.getState().candidates[0].before, '誤宇');
    assert.match(status.textContent, /候補はありません/);
  });
  console.log(`Completed: ${passed} test groups.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
