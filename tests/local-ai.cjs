const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..');
let connectionListener;
let messageListener;
let settings;
let hasPermission = true;
let requests = [];
let output;
let finishReason = 'stop';
let omitDone = false;
const ctx = {
  URL, TextDecoder, AbortController, AbortSignal, setTimeout, clearTimeout,
  importScripts() {},
  chrome: {
    runtime: {
      id: 'test', getURL: name => `chrome-extension://test/${name}`,
      onConnect: { addListener(fn) { connectionListener = fn; } },
      onMessage: { addListener(fn) { messageListener = fn; } }
    },
    permissions: { contains: async () => hasPermission },
    storage: { local: { get: async () => ({ lpAI: settings }) } }
  },
  fetch: async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'installed' }, { name: 'cloud', remote_host: 'https://ollama.com' }] });
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'local-japanese' }, { id: 'second-model' }] });
    const payload = output || JSON.stringify({ candidates: [{ before: '誤宇', after: '誤字', note: '漢字,確認"必要' }, { before: '不存在', after: '修正', note: '' }] });
    // Split both UTF-8 and NDJSON across arbitrary network boundaries.
    const lines = url.endsWith('/v1/chat/completions')
      ? ': keepalive\r\n\r\ndata: ' + JSON.stringify({ choices: [{ delta: { content: payload.slice(0, 15) }, finish_reason: null }] }) + '\r\n\r\n' +
        'data: ' + JSON.stringify({ choices: [{ delta: { content: payload.slice(15) }, finish_reason: finishReason }] }) + '\r\n\r\n' +
        (omitDone ? '' : 'data: [DONE]')
      : JSON.stringify({ message: { content: payload.slice(0, 15) } }) + '\n' + JSON.stringify({ message: { content: payload.slice(15) }, done: true }) + '\n';
    const bytes = new TextEncoder().encode(lines);
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    } }));
  }
};
vm.createContext(ctx);
for (const file of ['csv.js', 'local-ai.js', 'background.js']) vm.runInContext(fs.readFileSync(path.join(base, file), 'utf8'), ctx);
const ai = ctx.ListenProofreaderAI;
const editor = 'https://listen.style/p/takamichie/20261011-recent-events-october/transcript_editor';
async function generate(text) {
  const messages = [];
  let listener;
  return new Promise(resolve => {
    const port = {
      name: 'lp-ai', sender: { id: 'test', tab: { id: 1 }, url: editor },
      onDisconnect: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } },
      postMessage(message) {
        messages.push(message);
        if (['result', 'error'].includes(message.type)) resolve({ message, messages });
      }
    };
    connectionListener(port);
    listener({ type: 'generate', text });
  });
}
(async () => {
  assert.equal(ai.defaults.enabled, false);
  assert.equal(ai.defaults.provider, 'ollama');
  assert.equal(ai.providerOf().chatPath, '/api/chat');
  assert.equal(ai.providerOf('lmstudio').address, 'http://localhost:1234');
  assert.throws(() => ai.providerOf('unknown'));
  assert.equal(ai.transcriptURL(editor + '?x=1#part'), editor.replace('transcript_editor', 'transcript.txt'));
  assert.throws(() => ai.transcriptURL('https://other.example/p/a/b/transcript_editor'));
  assert.equal(ai.addressOf('http://localhost:11434/'), 'http://localhost:11434');
  for (const value of ['file:///tmp', 'http://user:password@localhost', 'http://localhost/api', 'http://localhost/?key=secret']) assert.throws(() => ai.addressOf(value));
  const longText = '誤宇を確認。\n' + '😀文章。'.repeat(2000);
  const chunks = ai.chunksOf(longText);
  assert.equal(chunks.join(''), longText);
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 3000));
  console.log('PASS defaults, URL mapping, endpoint validation, lossless Unicode chunks');
  const models = await new Promise(resolve => {
    assert.equal(messageListener({ type: 'lp-ai-models', address: ai.defaults.address }, { id: 'test', url: 'chrome-extension://test/options.html' }, resolve), true);
  });
  assert.equal(JSON.stringify(models.models), '["installed"]');
  console.log('PASS installed model listing excludes remote models');
  settings = { ...ai.defaults };
  requests = [];
  assert.match((await generate('誤宇')).message.error, /有効/);
  assert.equal(requests.length, 0);
  settings = { enabled: true, address: ai.defaults.address, model: 'installed' };
  hasPermission = false;
  assert.match((await generate('誤宇')).message.error, /接続を許可/);
  assert.equal(requests.length, 0);
  hasPermission = true;
  const result = await generate('誤宇'.repeat(2000));
  assert.equal(result.message.type, 'result');
  assert.equal(result.message.count, 1);
  assert.equal(requests.length, 2);
  assert.equal(result.messages.filter(message => message.type === 'progress').length, 2);
  const rows = ctx.ListenProofreaderCSV.candidatesFromCSV(result.message.csv).candidates;
  assert.equal(rows[0].before, '誤宇');
  assert.equal(rows[0].note, '漢字,確認"必要');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'installed');
  assert.equal(body.stream, true);
  console.log('PASS disabled/permission guards, streamed generation, filtering, deduplication, CSV round trip');
  output = '{"candidates":[]}';
  const empty = await generate('正常な本文');
  assert.equal(empty.message.count, 0);
  assert.equal(empty.message.csv, null);
  output = '{invalid';
  assert.equal((await generate('本文')).message.type, 'error');
  output = '{"candidates":[{"before":"本文","after":null,"note":""}]}';
  assert.equal((await generate('本文')).message.type, 'error');
  console.log('PASS empty and malformed AI responses');
  requests = [];
  const lmModels = await new Promise(resolve => {
    assert.equal(messageListener({ type: 'lp-ai-models', provider: 'lmstudio', address: 'http://localhost:1234' }, { id: 'test', tab: { id: 5 }, url: 'chrome-extension://test/options.html' }, resolve), true);
  });
  assert.equal(JSON.stringify(lmModels.models), '["local-japanese","second-model"]');
  assert.equal(requests[0].url, 'http://localhost:1234/v1/models');
  assert.equal(messageListener({ type: 'lp-ai-models', address: 'http://localhost:1234' }, { id: 'test', tab: { id: 5 }, url: editor }, () => assert.fail('content script must not access model discovery')), undefined);
  assert.equal(messageListener({ type: 'lp-ai-models', address: 'http://localhost:1234' }, { id: 'other', url: 'chrome-extension://test/options.html' }, () => assert.fail('another extension must not access model discovery')), undefined);
  console.log('PASS tabbed settings accepted; content scripts and other extensions rejected');
  settings = { enabled: true, provider: 'lmstudio', address: 'http://localhost:1234', model: 'local-japanese' };
  output = undefined;
  requests = [];
  const lmResult = await generate('誤宇'.repeat(2000));
  assert.equal(lmResult.message.type, 'result');
  assert.equal(lmResult.message.count, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'http://localhost:1234/v1/chat/completions');
  const lmBody = JSON.parse(requests[0].init.body);
  assert.equal(lmBody.model, 'local-japanese');
  assert.equal(lmBody.response_format.type, 'json_schema');
  assert.equal(lmBody.response_format.json_schema.strict, true);
  assert.equal(lmBody.response_format.json_schema.schema.properties.candidates.type, 'array');
  assert.equal(lmBody.temperature, 0);
  assert.equal(lmBody.options, undefined);
  assert.equal(lmBody.format, undefined);
  assert.equal(ctx.ListenProofreaderCSV.candidatesFromCSV(lmResult.message.csv).candidates[0].note, '漢字,確認"必要');
  console.log('PASS LM Studio models, JSON schema request, fragmented SSE/UTF-8, CSV import');
  finishReason = 'length';
  assert.match((await generate('誤宇')).message.error, /length/);
  finishReason = 'stop';
  omitDone = true;
  assert.match((await generate('誤宇')).message.error, /途中で切れ/);
  omitDone = false;
  output = '{invalid';
  assert.equal((await generate('本文')).message.type, 'error');
  settings.provider = 'unknown';
  assert.match((await generate('本文')).message.error, /接続方式/);
  console.log('PASS LM Studio truncated, interrupted, malformed responses and invalid provider');
})().catch(error => { console.error(error); process.exitCode = 1; });
