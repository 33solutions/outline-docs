#!/usr/bin/env bun
/**
 * Самопроверка скилла без обращения к Outline: разбор ссылок и правила проверки текстов.
 * Запуск: bun scripts/selftest.ts — код возврата 1, если хоть один случай не прошёл.
 */

import { documentRef, clip } from "./outline.ts";
import { scanText, guard } from "./guard.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}: ожидалось ${e}, получено ${a}`);
}

// ── разбор ссылок на документы ────────────────────────────────────────
check("ссылка: внутренний адрес", documentRef("https://outline.example.com/doc/podkljuchenie-abc123"), "podkljuchenie-abc123");
check("ссылка: с якорем", documentRef("https://outline.example.com/doc/instrukcija-x9y8#shag-2"), "instrukcija-x9y8");
check("ссылка: с параметрами", documentRef("https://outline.example.com/doc/abc-123?ref=search"), "abc-123");
check("ссылка: публичная", documentRef("https://outline.example.com/s/2b1a9c40-0000-4000-8000-000000000000"), "2b1a9c40-0000-4000-8000-000000000000");
check("ссылка: голый идентификатор", documentRef("  abc-123  "), "abc-123");
check(
  "ссылка: uuid",
  documentRef("2b1a9c40-0000-4000-8000-000000000000"),
  "2b1a9c40-0000-4000-8000-000000000000",
);

// ── обрезка для таблиц ────────────────────────────────────────────────
check("обрезка: короткое не трогаем", clip("Инструкция", 40), "Инструкция");
check("обрезка: длинное с многоточием", clip("а".repeat(50), 10), "а".repeat(9) + "…");
check("обрезка: переносы схлопываются", clip("первая\n\nвторая", 40), "первая вторая");

// ── проверка текста: публиковать нельзя ───────────────────────────────
const mustBlock: [string, string][] = [
  ["пароль в инструкции", "Для входа используйте логин admin и пароль: Qwerty12345"],
  ["токен", "Вставьте токен ghp_AbCdEfGh1234567890XyZwVuTsRq в поле «Ключ»"],
  ["строка подключения", "База: mongodb://admin:P@ssw0rd123@db.example.com:27017/prod"],
  ["ключ API в hex", "Ключ доступа: 0a1b2c3d4e5f60718293a4b5c6d7e8f901234567"],
  ["внутренний адрес", "Сервер обмена доступен по адресу 10.0.0.5"],
  ["карта", "Оплата с карты 4111 1111 1111 1111"],
  ["самооговор", "Раздел появился после того, как мы забыли включить регламентное задание"],
  ["обещание", "Гарантирую, что обмен точно заработает сразу"],
  ["реквизит в конце фразы", "Технический пользователь: svc_exchange, пароль Zx9!kLm2025"],
];
for (const [name, text] of mustBlock) {
  if (scanText(text, { audience: "client" }).some((f) => f.severity === "block")) passed++;
  else failures.push(`должно было остановить публикацию — ${name}`);
}

// ── проверка текста: публиковать можно ────────────────────────────────
const mustPass: [string, string][] = [
  ["ссылка на менеджера", "Реквизиты подключения выдаются вашим менеджером"],
  ["плейсхолдер", "Вставьте ключ доступа: <выдаётся администратором>"],
  ["обычная инструкция", "Откройте **Настройки → Интеграции** и нажмите **Добавить**."],
  ["условие вместо обещания", "При включённом автоматическом обмене заказ появляется в течение 15 минут."],
  ["публичный адрес", "Документация: https://www.getoutline.com/developers"],
  ["таблица ошибок", "| `Ошибка авторизации` | реквизиты устарели | запросите новые у менеджера |"],
  ["указание, где взять токен", "Токен берётся в Outline: Настройки → API → New token"],
  ["ссылка на раздел", "Ключ доступа: раздел Настройки вашего личного кабинета"],
];
for (const [name, text] of mustPass) {
  const blocked = scanText(text, { audience: "client" }).filter((f) => f.severity === "block");
  if (blocked.length === 0) passed++;
  else failures.push(`ложное срабатывание — ${name}: ${blocked.map((f) => f.title).join(", ")}`);
}

// ── планка зависит от аудитории ───────────────────────────────────────
const internalText = "Документ лежит на сервере 10.0.0.5, каталог C:\\Users\\andrey\\docs";
check(
  "внутренний адрес: для клиента — запрет",
  scanText(internalText, { audience: "client" }).some((f) => f.severity === "block"),
  true,
);
check(
  "внутренний адрес: внутри компании — предупреждение",
  scanText(internalText, { audience: "internal" }).some((f) => f.severity === "block"),
  false,
);

// ── секреты не попадают в отчёт ───────────────────────────────────────
const secret = "ghp_AbCdEfGh1234567890XyZwVuTsRq";
const report = guard({ текст: `Токен ${secret}` }, { audience: "client" }).report;
check("секрет в отчёте замаскирован", report.includes(secret), false);
check("отчёт останавливает публикацию", guard({ текст: `Токен ${secret}` }).blocked, true);

// ── итог ──────────────────────────────────────────────────────────────
console.log(`Проверок пройдено: ${passed}`);
if (failures.length > 0) {
  console.error(`\nНе прошло: ${failures.length}`);
  for (const f of failures) console.error(`  — ${f}`);
  process.exit(1);
}
console.log("Самопроверка пройдена.");
