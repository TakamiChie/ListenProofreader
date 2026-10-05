/* RFC 4180: quoted commas, escaped quotes, CRLF and multiline notes. */
(() => {
  "use strict";

  function parseCSV(source) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    let closed = false;
    const text = source.replace(/^\uFEFF/, "");
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          quoted = false;
          closed = true;
        } else {
          field += ch;
        }
      } else if (ch === "," || ch === "\n" || ch === "\r") {
        row.push(field);
        field = "";
        closed = false;
        if (ch !== ",") {
          rows.push(row);
          row = [];
          if (ch === "\r" && text[i + 1] === "\n") i++;
        }
      } else if (ch === '"') {
        if (field !== "" || closed) throw new Error("引用符の位置が不正です。");
        quoted = true;
      } else {
        if (closed) throw new Error("閉じ引用符の後に余分な文字があります。");
        field += ch;
      }
    }
    if (quoted) throw new Error("閉じていない引用符があります。");
    if (field !== "" || row.length || closed) rows.push([...row, field]);
    return rows;
  }

  function candidatesFromCSV(source) {
    const rows = parseCSV(source).filter(row => row.some(value => value.trim() !== ""));
    const isHeader = rows[0] &&
      /^(誤字|置換前|修正前|before)$/i.test(rows[0][0].trim()) &&
      /^(修正案|置換後|修正後|after)$/i.test((rows[0][1] || "").trim());
    if (isHeader) rows.shift();
    const candidates = [];
    let skipped = 0;
    rows.forEach((row, index) => {
      if (row.length < 2 || row.length > 3) {
        throw new Error(`${index + (isHeader ? 2 : 1)}行目の列数が不正です。2〜3列にしてください。`);
      }
      const before = row[0].trim();
      if (!before) {
        skipped++;
        return;
      }
      candidates.push({ before, after: row[1], note: row[2] || "" });
    });
    if (!candidates.length) throw new Error("有効な置換候補がありません。");
    return { candidates, skipped };
  }

  globalThis.ListenProofreaderCSV = { parseCSV, candidatesFromCSV };
})();
