"use strict";
const ai = globalThis.ListenProofreaderAI;
const enabled = document.getElementById("enabled");
const provider = document.getElementById("provider");
const address = document.getElementById("address");
const model = document.getElementById("model");
const status = document.getElementById("status");
const refresh = document.getElementById("refresh");
const save = document.getElementById("save");
let listedAddress = "";
let listedProvider = "";
let previousProvider = ai.defaults.provider;
let installed = [];
let savedModel = "";

function fillModels(names, selected) {
  model.replaceChildren(new Option(names.length ? "モデルを選択してください" : "インストール済みモデルがありません", ""));
  for (const name of names) model.add(new Option(name, name));
  model.value = names.includes(selected) ? selected : "";
}
function updateProviderHelp() {
  const info = ai.providerOf(provider.value);
  address.placeholder = info.address;
  document.getElementById("server-help").textContent = provider.value === "lmstudio"
    ? "LM StudioのDeveloper画面でサーバーを起動してください。標準アドレスは http://localhost:1234 です（/v1 は入力不要）。全ダウンロード済みモデルを表示するにはJust-In-Timeロードを有効にしてください。認証必須のサーバーには未対応です。モデル取得時に接続許可を求めます。"
    : "起動済みのOllamaサーバーを指定してください。モデル一覧の取得時に、このアドレスへの接続許可を求めます。";
}
function resetModels() {
  listedAddress = ""; listedProvider = ""; installed = []; fillModels([], "");
}
provider.addEventListener("change", () => {
  if (!address.value || address.value.replace(/\/$/, "") === ai.providerOf(previousProvider).address) {
    address.value = ai.providerOf(provider.value).address;
  }
  previousProvider = provider.value;
  savedModel = "";
  resetModels();
  updateProviderHelp();
});
address.addEventListener("input", () => {
  resetModels();
});
refresh.addEventListener("click", async () => {
  refresh.disabled = save.disabled = true;
  status.textContent = "モデル一覧を取得しています…";
  try {
    const origin = ai.addressOf(address.value);
    const selectedProvider = provider.value;
    const selection = model.value || savedModel;
    if (!await chrome.permissions.request({ origins: [origin + "/*"] })) throw new Error("接続が許可されませんでした。");
    const result = await chrome.runtime.sendMessage({ type: "lp-ai-models", address: origin, provider: selectedProvider });
    if (!result || typeof result !== "object") {
      throw new Error("拡張機能のバックグラウンド処理から応答がありません。chrome://extensions/ で拡張機能を再読み込みし、設定画面を閉じて開き直してください。");
    }
    if (result.error) throw new Error(result.error);
    if (!Array.isArray(result.models) || !result.models.every(name => typeof name === "string")) {
      throw new Error("拡張機能から受信したモデル一覧の形式が不正です。拡張機能と設定画面を再読み込みしてください。");
    }
    if (ai.addressOf(address.value) !== origin || provider.value !== selectedProvider) throw new Error("接続設定が変更されました。再取得してください。");
    listedAddress = origin;
    listedProvider = selectedProvider;
    installed = [...new Set(result.models)];
    fillModels(installed, selection);
    status.textContent = installed.length ? `${installed.length}個のモデルを取得しました。` : "モデルがありません。モデルのインストールとサーバーのモデル公開設定を確認してください。";
  } catch (error) {
    resetModels();
    status.textContent = `モデル取得失敗：${error.message}`;
  } finally { refresh.disabled = save.disabled = false; }
});
document.getElementById("settings").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const origin = ai.addressOf(address.value);
    ai.providerOf(provider.value);
    if (enabled.checked && (listedAddress !== origin || listedProvider !== provider.value || !installed.includes(model.value))) {
      throw new Error("モデル一覧を取得し、インストール済みモデルを選択してください。");
    }
    await chrome.storage.local.set({ lpAI: { enabled: enabled.checked, provider: provider.value, address: origin, model: model.value } });
    savedModel = model.value;
    status.textContent = "設定を保存しました。開いている校正バーにも反映されます。";
  } catch (error) { status.textContent = error.message; }
});
(async () => {
  try {
    const saved = await chrome.storage.local.get("lpAI");
    const settings = { ...ai.defaults, ...saved.lpAI };
    enabled.checked = settings.enabled === true;
    ai.providerOf(settings.provider);
    provider.value = settings.provider;
    previousProvider = settings.provider;
    updateProviderHelp();
    address.value = settings.address;
    savedModel = settings.model;
    if (savedModel) {
      model.add(new Option(`${savedModel}（保存済み・一覧を再取得してください）`, savedModel));
      model.value = savedModel;
    }
  } catch (error) { status.textContent = error.message; }
})();
