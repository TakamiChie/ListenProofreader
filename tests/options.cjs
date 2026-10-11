const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..');
async function setup(saved, response = { models: ['japanese-model'] }) {
  const elements = {};
  for (const id of ['enabled', 'provider', 'address', 'model', 'status', 'refresh', 'save', 'server-help', 'settings']) {
    elements[id] = { value: '', listeners: {}, options: [],
      addEventListener(event, fn) { this.listeners[event] = fn; },
      replaceChildren(...options) { this.options = options; },
      add(option) { this.options.push(option); }
    };
  }
  elements.provider.value = 'ollama';
  let stored;
  let requested;
  const ctx = { URL,
    Option: function(text, value) { this.text = text; this.value = value; },
    document: { getElementById: id => elements[id] },
    chrome: {
      permissions: { request: async () => true },
      storage: { local: { get: async () => ({ lpAI: saved }), set: async value => { stored = value.lpAI; } } },
      runtime: { sendMessage: async message => { requested = message; return response; } }
    }
  };
  vm.createContext(ctx);
  for (const file of ['local-ai.js', 'options.js']) vm.runInContext(fs.readFileSync(path.join(base, file), 'utf8'), ctx);
  await new Promise(resolve => setImmediate(resolve));
  return { elements, stored: () => stored, requested: () => requested };
}
(async () => {
  const form = await setup({ enabled: true, address: 'http://localhost:11434', model: 'old-model' });
  const el = form.elements;
  assert.equal(el.provider.value, 'ollama');
  assert.equal(el.model.value, 'old-model');
  el.provider.value = 'lmstudio';
  el.provider.listeners.change();
  assert.equal(el.address.value, 'http://localhost:1234');
  assert.equal(el.model.value, '');
  await el.settings.listeners.submit({ preventDefault() {} });
  assert.equal(form.stored(), undefined);
  assert.match(el.status.textContent, /モデル一覧を取得/);
  await el.refresh.listeners.click();
  assert.equal(form.requested().provider, 'lmstudio');
  el.model.value = 'japanese-model';
  await el.settings.listeners.submit({ preventDefault() {} });
  assert.equal(form.stored().provider, 'lmstudio');
  assert.equal(form.stored().address, 'http://localhost:1234');
  assert.equal(form.stored().model, 'japanese-model');
  console.log('PASS legacy settings, provider defaults, model refresh requirement and LM Studio save');
  const restored = await setup(form.stored());
  assert.equal(restored.elements.provider.value, 'lmstudio');
  assert.equal(restored.elements.model.value, 'japanese-model');
  el.address.value = 'http://192.168.1.5:5555';
  el.address.listeners.input();
  el.provider.value = 'ollama';
  el.provider.listeners.change();
  assert.equal(el.address.value, 'http://192.168.1.5:5555');
  assert.equal(el.model.value, '');
  console.log('PASS LM Studio settings restoration and custom endpoint preservation');
  const noResponse = await setup(undefined, null);
  await noResponse.elements.refresh.listeners.click();
  assert.match(noResponse.elements.status.textContent, /バックグラウンド処理から応答がありません/);
  assert.doesNotMatch(noResponse.elements.status.textContent, /reading 'error'|AIサーバーの起動状態/);
  assert.equal(noResponse.elements.refresh.disabled, false);
  assert.equal(noResponse.elements.save.disabled, false);
  const malformedResponse = await setup(undefined, { models: 'bad' });
  await malformedResponse.elements.refresh.listeners.click();
  assert.match(malformedResponse.elements.status.textContent, /モデル一覧の形式が不正/);
  console.log('PASS absent and malformed background replies show actionable errors');
})().catch(error => { console.error(error); process.exitCode = 1; });
