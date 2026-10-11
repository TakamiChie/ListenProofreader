(() => {
  "use strict";
  const defaults = { enabled: false, provider: "ollama", address: "http://localhost:11434", model: "" };
  const providers = {
    ollama: { label: "Ollama", address: "http://localhost:11434", modelsPath: "/api/tags", chatPath: "/api/chat" },
    lmstudio: { label: "LM Studio", address: "http://localhost:1234", modelsPath: "/v1/models", chatPath: "/v1/chat/completions" }
  };
  function providerOf(value = "ollama") {
    if (!Object.hasOwn(providers, value)) throw new Error("AIの接続方式が不正です。");
    return providers[value];
  }
  function addressOf(value) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || !/^\/*$/.test(url.pathname)) {
      throw new Error("AIのアドレスは http(s)://ホスト:ポート の形式にしてください。");
    }
    return url.origin;
  }
  function transcriptURL(value) {
    const url = new URL(value);
    if (url.origin !== "https://listen.style" || !/^\/p\/[^/]+\/[^/]+\/transcript_editor\/?$/.test(url.pathname)) {
      throw new Error("文字起こしエディタのURLではありません。");
    }
    url.pathname = url.pathname.replace(/transcript_editor\/?$/, "transcript.txt");
    url.search = "";
    url.hash = "";
    return url.href;
  }
  function chunksOf(text, size = 3000) {
    const chars = Array.from(text);
    const chunks = [];
    let start = 0;
    while (start < chars.length) {
      let end = Math.min(start + size, chars.length);
      if (end < chars.length) {
        for (let i = end - 1; i > start + size / 2; i--) {
          if (/[\n。！？]/u.test(chars[i])) { end = i + 1; break; }
        }
      }
      chunks.push(chars.slice(start, end).join(""));
      start = end;
    }
    return chunks;
  }
  function parseResult(source, transcript) {
    const data = JSON.parse(source);
    if (!Array.isArray(data.candidates)) throw new Error("AIの応答に候補一覧がありません。");
    return data.candidates.filter(row => {
      if (!row || typeof row.before !== "string" || typeof row.after !== "string" || typeof row.note !== "string") {
        throw new Error("AIの候補の形式が不正です。");
      }
      row.before = row.before.trim();
      return row.before && row.before !== row.after && transcript.includes(row.before);
    });
  }
  function toCSV(rows) {
    const quote = value => `"${value.replace(/"/g, '""')}"`;
    return "誤字,修正案,備考\r\n" + rows.map(row => [row.before, row.after, row.note].map(quote).join(",")).join("\r\n");
  }
  globalThis.ListenProofreaderAI = { defaults, providers, providerOf, addressOf, transcriptURL, chunksOf, parseResult, toCSV };
})();
