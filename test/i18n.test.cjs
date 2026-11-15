const assert = require("node:assert/strict");
const test = require("node:test");
const { i18n } = require("../src/i18n.cjs");

test("native OpenCode locale keys have complete translations and matching placeholders", () => {
  assert.deepEqual(Object.keys(i18n), ["en", "zh", "zht", "ru"]);
  assert.equal(i18n.zh.title, "远程访问");
  assert.equal(i18n.zht.title, "遠端存取");
  assert.equal(i18n.ru.title, "Удалённый доступ");
  const placeholders = (text) => Array.from(text.matchAll(/\{\{(\w+)\}\}/gu), ([, name]) => name).sort();
  const keys = Object.keys(i18n.en).sort();
  for (const [locale, messages] of Object.entries(i18n)) {
    assert.deepEqual(Object.keys(messages).sort(), keys, locale);
    for (const key of keys) {
      assert.ok(messages[key].trim(), `${locale} ${key}`);
      assert.deepEqual(placeholders(messages[key]), placeholders(i18n.en[key]), `${locale} ${key}`);
    }
  }
});
