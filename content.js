(() => {
  "use strict";
  if (globalThis.__listenProofreaderLoaded) return;
  globalThis.__listenProofreaderLoaded = true;

  const buttonClass = "text-sm border border-blue-500 text-blue-500 rounded hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50";
  const inputClass = "border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950 focus:border-blue-500 focus:ring-blue-500";
  const panelClass = "border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300";
  let root;
  let bar;
  let status;
  let count;
  let shortInput;
  let longInput;
  let fileInput;
  let previousButton;
  let nextButton;
  let csvStatus;
  let note;
  let candidates = [];
  let candidateIndex = -1;
  let anchorRow = null;
  let anchorIndex = -1;
  let useViewport = true;
  let shortLimit = 5;
  let longLimit = 200;
  let collapsed = false;
  let refreshTimer;
  let busy = false;
  let loadGeneration = 0;
  let resizeObserver;
  const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

  function element(tag, text, className = "") {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    el.className = className;
    return el;
  }

  function button(text, handler) {
    const el = element("button", text, buttonClass);
    el.type = "button";
    el.addEventListener("click", handler);
    return el;
  }

  function report(message) {
    if (status) status.textContent = message;
  }

  function savePreferences() {
    try {
      globalThis.chrome?.storage?.local?.set({ lpPreferences: { shortLimit, longLimit, collapsed } })
        ?.catch(() => {});
    } catch { /* An extension reload may invalidate the old content script. */ }
  }

  function visible(el) {
    return Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
  }

  function rows() {
    return root ? [...root.querySelectorAll(".segment-row[data-segment-index]")] : [];
  }

  function rowText(row) {
    const editing = [...row.querySelectorAll("textarea")].find(visible);
    if (editing) return editing.value;
    return row.querySelector('[x-text="seg.text"]')?.textContent || "";
  }

  function lengthOf(row) {
    // Count Unicode code points; ignore whitespace, line breaks and indentation.
    return [...rowText(row).replace(/\s/gu, "")].length;
  }

  function targets(kind, allRows = rows()) {
    return allRows.filter(row => {
      if (kind === "speaker") return row.querySelector("select")?.value === "-1";
      const length = lengthOf(row);
      if (kind === "short") return length < shortLimit;
      if (kind === "long") return length > longLimit;
      return length < shortLimit || length > longLimit;
    });
  }

  function limitsValid() {
    const min = Number(shortInput.value);
    const max = Number(longInput.value);
    if (!shortInput.value || !longInput.value || !Number.isInteger(min) ||
      !Number.isInteger(max) || min < 1 || max < min || max > 100000) {
      report("文字数は1〜100000の整数で、下限≦上限にしてください。");
      return false;
    }
    shortLimit = min;
    longLimit = max;
    return true;
  }

  function refreshCounts() {
    if (!bar?.isConnected) return;
    const all = rows();
    count.textContent = `未分離 ${targets("speaker", all).length} / 短い ${targets("short", all).length} / 長い ${targets("long", all).length}`;
  }

  function updateTop() {
    if (!bar?.isConnected) return;
    // Respect LISTEN's fixed/sticky header; never use the bottom player area.
    let top = 8;
    for (const el of document.querySelectorAll("header, nav")) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (["fixed", "sticky"].includes(style.position) && rect.top <= 1 &&
        rect.bottom > 0 && rect.bottom < innerHeight / 3) top = Math.max(top, rect.bottom + 8);
    }
    bar.style.setProperty("--lp-top", `${top}px`);
    root.style.setProperty("--lp-scroll-margin", `${top + bar.offsetHeight + 12}px`);
  }

  function jump(kind) {
    if (!limitsValid()) return;
    const all = rows();
    const matched = targets(kind, all);
    const names = { speaker: "話者未分離", short: "短い段落", long: "長い段落", length: "文字数の偏った段落" };
    if (!matched.length) {
      refreshCounts();
      report(`${names[kind]}はありません。`);
      return;
    }
    let from = -1;
    if (!useViewport && anchorRow?.isConnected) from = all.indexOf(anchorRow);
    else if (!useViewport) from = all.findIndex(row => Number(row.dataset.segmentIndex) >= anchorIndex) - 1;
    else {
      const top = bar.getBoundingClientRect().bottom + 8;
      from = all.findIndex(row => row.getBoundingClientRect().bottom >= top) - 1;
      if (from < -1) from = all.length - 1;
    }
    const target = matched.find(row => all.indexOf(row) > from) || matched[0];
    const wrapped = all.indexOf(target) <= from;
    root.querySelectorAll(".lp-current").forEach(row => row.classList.remove("lp-current"));
    target.classList.add("lp-current");
    anchorRow = target;
    anchorIndex = Number(target.dataset.segmentIndex);
    useViewport = false;
    updateTop();
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    // Focus without clicking: do not start playback or change editing mode.
    const focusTarget = kind === "speaker" ? target.querySelector("select") : target;
    if (focusTarget === target && !target.hasAttribute("tabindex")) target.tabIndex = -1;
    focusTarget?.focus({ preventScroll: true });
    refreshCounts();
    report(`${names[kind]} ${matched.indexOf(target) + 1}/${matched.length}・段落 ${all.indexOf(target) + 1}・${lengthOf(target)}文字${wrapped ? "（先頭に戻りました）" : ""}`);
  }

  function replaceForm() {
    const before = root?.querySelector('[x-ref="replaceBeforeInput"]');
    const form = before?.closest("form");
    const after = form?.querySelector('[x-model="replacementString"]');
    const search = form?.querySelector('button[type="submit"]');
    return before && after && search ? { before, after, search, form, panel: form.parentElement } : null;
  }

  function ensureNote(form) {
    if (!note || !form.contains(note)) {
      note?.remove();
      note = element("div", undefined, "border border-blue-200 dark:border-neutral-700 rounded bg-blue-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300");
      note.dataset.lpNote = "";
      note.setAttribute("role", "note");
      note.setAttribute("aria-live", "polite");
      const after = form.querySelector('[x-model="replacementString"]');
      after.insertAdjacentElement("afterend", note);
    }
    return note;
  }

  function updateCSVStatus() {
    csvStatus.textContent = candidates.length
      ? `CSV ${candidateIndex + 1}/${candidates.length}${candidateIndex === candidates.length - 1 ? "（最後の候補）" : ""}`
      : "CSV未読込";
    previousButton.disabled = busy || candidateIndex <= 0;
    nextButton.disabled = busy || !candidates.length || candidateIndex >= candidates.length - 1;
  }

  function setInput(input, value) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function showCandidate(index) {
    if (busy || index < 0 || index >= candidates.length) return;
    busy = true;
    updateCSVStatus();
    const startingRoot = root;
    try {
      // Let LISTEN's @click.outside handler finish before opening its panel.
      await pause();
      const fields = replaceForm();
      if (!fields) throw new Error("一括置換フォームが見つかりません。LISTENの画面構造を確認してください。");
      if (!visible(fields.panel)) {
        const toggle = root.querySelector('button[aria-label="一括置換"]');
        if (!toggle) throw new Error("一括置換ボタンが見つかりません。");
        toggle.click();
      }
      for (let i = 0; i < 20 && !visible(fields.panel); i++) await pause(25);
      if (!visible(fields.panel)) throw new Error("一括置換パネルを開けませんでした。");
      const regex = fields.form.querySelector('button[aria-label="正規表現"]');
      if (regex?.classList.contains("bg-blue-500")) {
        regex.click();
        await pause();
        if (regex.classList.contains("bg-blue-500")) throw new Error("正規表現モードを解除できませんでした。");
      }
      const candidate = candidates[index];
      if (!candidate || startingRoot !== root || !fields.form.isConnected) {
        throw new Error("画面またはCSVが切り替わりました。再度候補を選んでください。");
      }
      setInput(fields.before, candidate.before);
      setInput(fields.after, candidate.after);
      ensureNote(fields.form).textContent = `CSV候補 ${index + 1}/${candidates.length}\n備考：${candidate.note || "（なし）"}`;
      // Alpine updates disabled bindings in a microtask after the input event.
      for (let i = 0; i < 20 && fields.search.disabled; i++) await pause(25);
      if (fields.search.disabled) throw new Error("検索ボタンが有効になりませんでした。");
      fields.search.click();
      candidateIndex = index;
      report(`候補 ${index + 1} を入力して検索しました。内容を確認し、既存の「すべて置換」を押してください。`);
    } catch (error) {
      report(error.message);
    } finally {
      busy = false;
      updateCSVStatus();
    }
  }

  async function loadCSV(file) {
    if (!file || busy) return;
    const generation = ++loadGeneration;
    busy = true;
    updateCSVStatus();
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("CSVは5MB以下にしてください。");
      const bytes = await file.arrayBuffer();
      let text;
      let encoding = "UTF-8";
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
        encoding = "Shift_JIS";
      }
      const result = globalThis.ListenProofreaderCSV.candidatesFromCSV(text);
      if (generation !== loadGeneration) return;
      candidates = result.candidates;
      candidateIndex = -1;
      if (note) note.textContent = "新しいCSVを読み込みました。「次の候補」で入力してください。";
      updateCSVStatus();
      report(`${file.name}：${candidates.length}件（${encoding}）${result.skipped ? `・誤字が空欄の${result.skipped}件を除外` : ""}。「次の候補」で最初の候補を入力します。`);
    } catch (error) {
      if (generation === loadGeneration) report(`CSV読込失敗：${error.message} 以前の候補は保持しています。`);
    } finally {
      busy = false;
      updateCSVStatus();
    }
  }

  function mount(editor) {
    root = editor;
    anchorRow = null;
    useViewport = true;
    candidates = [];
    candidateIndex = -1;
    ++loadGeneration;
    note?.remove();
    note = null;
    bar?.remove();
    bar = element("section", undefined, panelClass);
    bar.id = "listen-proofreader";
    bar.setAttribute("aria-label", "文字起こし校正アシスト");
    // Extension elements should not become part of Alpine's reactive templates.
    bar.setAttribute("x-ignore", "");
    const summary = element("div", undefined, "lp-summary");
    const body = element("div", undefined, "lp-body");
    body.id = "lp-body";
    body.hidden = collapsed;
    const fold = button(collapsed ? "校正 ▸" : "校正 ▾", () => {
      collapsed = !collapsed;
      body.hidden = collapsed;
      fold.textContent = collapsed ? "校正 ▸" : "校正 ▾";
      fold.setAttribute("aria-expanded", String(!collapsed));
      savePreferences();
      updateTop();
    });
    fold.setAttribute("aria-controls", body.id);
    fold.setAttribute("aria-expanded", String(!collapsed));
    count = element("span", "", "text-xs text-neutral-500 dark:text-neutral-400");
    summary.append(fold, button("次の未分離", () => jump("speaker")), button("次の文字数異常", () => jump("length")), count);
    const lengthLine = element("div", undefined, "lp-line");
    function threshold(label, value) {
      const wrapper = element("label", label);
      const input = element("input", undefined, inputClass);
      input.type = "number";
      input.min = "1";
      input.max = "100000";
      input.step = "1";
      input.value = value;
      input.addEventListener("change", () => {
        if (limitsValid()) {
          savePreferences();
          refreshCounts();
          report(`${shortLimit}文字未満 / ${longLimit}文字超を検出します。空白と改行は数えません。`);
        }
      });
      wrapper.append(input);
      return { wrapper, input };
    }
    const min = threshold("下限", shortLimit);
    const max = threshold("上限", longLimit);
    shortInput = min.input;
    longInput = max.input;
    lengthLine.append(min.wrapper, max.wrapper, button("次の短い段落", () => jump("short")), button("次の長い段落", () => jump("long")));
    const csvLine = element("div", undefined, "lp-line");
    fileInput = element("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,text/csv";
    fileInput.hidden = true;
    fileInput.addEventListener("change", () => {
      loadCSV(fileInput.files[0]);
      fileInput.value = "";
    });
    const loadButton = button("CSV読込", () => {
      if (!busy) fileInput.click();
    });
    previousButton = button("前の候補", () => showCandidate(candidateIndex - 1));
    nextButton = button("次の候補", () => showCandidate(candidateIndex + 1));
    csvStatus = element("span", "", "text-xs text-neutral-500 dark:text-neutral-400");
    const clear = button("CSV解除", () => {
      if (busy) return;
      ++loadGeneration;
      candidates = [];
      candidateIndex = -1;
      note?.remove();
      note = null;
      updateCSVStatus();
      report("CSV候補を解除しました。");
    });
    csvLine.append(loadButton, previousButton, nextButton, csvStatus, clear, fileInput);
    status = element("p", "下限未満 / 上限超の段落を検出します。空白・改行は除きます。", "lp-status text-neutral-500 dark:text-neutral-400");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const statusLine = element("div", undefined, "lp-line");
    statusLine.append(status);
    body.append(lengthLine, csvLine, statusLine);
    bar.append(summary, body);
    const firstSection = [...root.children].find(el => el.tagName === "SECTION");
    if (firstSection) root.insertBefore(bar, firstSection);
    else root.prepend(bar);
    updateCSVStatus();
    refreshCounts();
    updateTop();
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(updateTop);
    resizeObserver.observe(bar);
  }

  function reconcile() {
    const editor = [...document.querySelectorAll("[x-data]")].find(el =>
      /^transcriptEditor\s*\(/.test(el.getAttribute("x-data") || ""));
    if (editor && (!bar?.isConnected || editor !== root)) mount(editor);
    if (!editor && bar) {
      bar.remove();
      note?.remove();
      root = null;
    }
    refreshCounts();
  }

  function schedule() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(reconcile, 150);
  }

  document.addEventListener("input", event => {
    if (root?.contains(event.target) && !bar?.contains(event.target)) schedule();
  });
  document.addEventListener("change", schedule);
  function trackRow(event) {
    const row = event.target.closest?.(".segment-row[data-segment-index]");
    if (row && root?.contains(row)) {
      anchorRow = row;
      anchorIndex = Number(row.dataset.segmentIndex);
      useViewport = false;
    }
  }
  document.addEventListener("pointerdown", trackRow);
  document.addEventListener("focusin", trackRow);
  document.addEventListener("wheel", () => { useViewport = true; }, { passive: true });
  document.addEventListener("touchmove", () => { useViewport = true; }, { passive: true });
  document.addEventListener("keydown", event => {
    if (["PageDown", "PageUp", "Home", "End"].includes(event.key) &&
      !event.target.matches("input, textarea, [contenteditable]")) useViewport = true;
  });
  window.addEventListener("resize", updateTop);

  async function start() {
    try {
      const saved = await globalThis.chrome?.storage?.local?.get("lpPreferences");
      const prefs = saved?.lpPreferences;
      if (prefs && Number.isInteger(prefs.shortLimit) && Number.isInteger(prefs.longLimit) &&
        prefs.shortLimit >= 1 && prefs.longLimit >= prefs.shortLimit && prefs.longLimit <= 100000) {
        shortLimit = prefs.shortLimit;
        longLimit = prefs.longLimit;
        collapsed = Boolean(prefs.collapsed);
      }
    } catch { /* Defaults also work without extension storage in a local test. */ }
    reconcile();
    new MutationObserver(records => {
      if (records.some(record => !record.target.closest?.("#listen-proofreader, [data-lp-note]"))) schedule();
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }
  start();
})();
