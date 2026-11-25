import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatRange,
  replaceText,
  textParts,
  validateRuns,
} from "../src/domain/rich-text";
test("range formatting survives a Chinese insertion and an emoji replacement", () => {
  const draft = formatRange({ text: "甲乙🌙尾" }, 1, 4, { fontWeight: 700 });
  const edited = replaceText(draft, "甲乙方🌙尾");
  assert.deepEqual(
    textParts(edited).map((p) => [p.text, p.style.fontWeight]),
    [
      ["甲", undefined],
      ["乙方🌙", 700],
      ["尾", undefined],
    ],
  );
  const replaced = replaceText(edited, "甲乙方⭐尾");
  validateRuns(replaced);
  assert.equal(textParts(replaced)[1].text, "乙方⭐");
});
test("partial style removal preserves overlapping properties and combines adjacent identical runs", () => {
  const bold = formatRange({ text: "abcde" }, 0, 5, { fontWeight: 700 });
  const underline = formatRange(bold, 1, 4, { textDecoration: "underline" });
  const cleared = formatRange(underline, 1, 4, { textDecoration: undefined });
  assert.deepEqual(cleared, bold);
  assert.throws(() =>
    validateRuns({
      text: "x",
      textRuns: [{ start: 0, end: 2, style: { fontWeight: 500 } }],
    }),
  );
});
