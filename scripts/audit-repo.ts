#!/usr/bin/env bun
/**
 * Проверка репозитория перед публикацией: тот же сканер, что защищает сообщения в Redmine,
 * прогоняется по всем файлам под контролем версий.
 *
 * Запуск: bun scripts/audit-repo.ts [--history]
 *   --history — проверить ещё и содержимое всех коммитов (публикация раскрывает историю целиком).
 *
 * Код возврата 1, если найдено то, чего в публичном репозитории быть не должно.
 */

import { scanText, type Finding } from "./guard.ts";

const TEXT_EXTENSIONS = new Set([
  "ts", "js", "mjs", "cjs", "json", "md", "html", "htm", "css", "yml", "yaml", "txt", "sh", "toml", "gitignore",
  "gitattributes",
]);

/** Файлы с намеренными примерами: там «секреты» синтетические и нужны для тестов, правил и документации. */
const FIXTURE_FILES = new Set([
  "scripts/selftest.ts",
  "scripts/guard.ts",
  "scripts/audit-repo.ts",
  "references/safety.md",
  "references/editorial.md",
]);

/**
 * В исходном коде «pwd: value» — это имя поля, а не утечка, поэтому к коду применяются
 * только правила, распознающие сам секрет по форме, а не по соседнему слову.
 */
const CODE_EXTENSIONS = new Set(["ts", "js", "mjs", "cjs", "json", "yml", "yaml"]);
const STRONG_RULES = new Set([
  "private-key",
  "aws-key",
  "github-token",
  "slack-token",
  "llm-key",
  "jwt",
  "bearer",
  "conn-string",
  "onec-conn",
  "hex-secret",
  "card",
  "snils",
  "passport",
]);

/**
 * Внутренняя инфраструктура не должна упоминаться в публичном репозитории.
 * Сами адреса в коде не хранятся — иначе проверяющий файл сам становится утечкой.
 * Источник списка: переменная AUDIT_INTERNAL_DOMAINS (через запятую) или
 * ~/.outline/config.json → { "audit": { "internalDomains": [...], "allow": [...] } }.
 */
type AuditConfig = { internalDomains?: string[]; allow?: string[] };

async function readAuditConfig(): Promise<AuditConfig> {
  const fromEnv = (name: string): string[] =>
    (process.env[name] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const envDomains = fromEnv("AUDIT_INTERNAL_DOMAINS");
  const envAllow = fromEnv("AUDIT_ALLOW");
  if (envDomains.length > 0 || envAllow.length > 0) {
    return { internalDomains: envDomains, allow: envAllow };
  }

  const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  const file = Bun.file(`${home}/.outline/config.json`);
  if (!(await file.exists())) return {};
  const raw: unknown = await file.json().catch(() => ({}));
  if (typeof raw !== "object" || raw === null) return {};
  const audit = (raw as Record<string, unknown>).audit;
  if (typeof audit !== "object" || audit === null) return {};
  const a = audit as Record<string, unknown>;
  return {
    internalDomains: Array.isArray(a.internalDomains) ? a.internalDomains.map(String) : undefined,
    allow: Array.isArray(a.allow) ? a.allow.map(String) : undefined,
  };
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const auditConfig = await readAuditConfig();
const INTERNAL_PATTERNS: { pattern: RegExp; title: string }[] = (auditConfig.internalDomains ?? []).map((domain) => ({
  pattern: new RegExp(`(?:[\\w-]+\\.)*${escapeRegExp(domain)}\\b`, "gi"),
  title: "внутренний адрес организации",
}));
/** Контексты, в которых совпадение допустимо (например, адрес самого репозитория). */
const INTERNAL_ALLOW = (auditConfig.allow ?? []).map((source) => new RegExp(source, "i"));

/**
 * Ссылка скилла на собственную страницу в базе знаний — не утечка, а правило: SKILL.md обязан
 * называть страницу, которая обновляется вместе с версией. Страница опознаётся по пути
 * «/doc/<имя скилла>-…»: база знаний строит адрес из названия, а название страницы начинается
 * с имени скилла. Любое другое упоминание внутреннего домена — по-прежнему находка, и список
 * разрешений в секрете для этого не нужен (его значения не прочитать, а перезапись стёрла бы их).
 */
const SKILL_NAME = await (async (): Promise<string | null> => {
  const file = Bun.file("SKILL.md");
  if (!(await file.exists())) return null;
  const head = (await file.text()).match(/^---\s*\n([\s\S]*?)\n---/);
  const name = head?.[1]?.match(/^name:\s*["']?([\w.-]+)["']?\s*$/m)?.[1];
  return name ?? null;
})();

function isSelfLink(text: string, matchEnd: number): boolean {
  return SKILL_NAME !== null && text.startsWith(`/doc/${SKILL_NAME}-`, matchEnd);
}

async function sh(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${command.join(" ")} → код ${code}: ${err.trim()}`);
  }
  return out;
}

/** Файлы без расширения (VERSION, LICENSE) — тоже текст и тоже проверяются. */
const TEXT_NAMES = new Set(["version", "license", "changelog", "readme", "dockerfile", "makefile"]);

function isTextFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  if (!name.includes(".")) return TEXT_NAMES.has(name.toLowerCase());
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || TEXT_NAMES.has(name.toLowerCase());
}

type Problem = { file: string; line: number | null; title: string; detail: string };

const problems: Problem[] = [];
const notes: string[] = [];

const files = (await sh(["git", "ls-files"])).split("\n").map((f) => f.trim()).filter(Boolean);
if (files.length === 0) throw new Error("git ls-files ничего не вернул — запускать из корня репозитория");

// ── 1. Файлы, которых не должно быть под контролем версий ─────────────
const FORBIDDEN = [/(^|\/)config\.json$/, /(^|\/)\.env/, /(^|\/)node_modules\//, /\.key$/, /\.pem$/, /\.pfx$/];
for (const file of files) {
  if (FORBIDDEN.some((re) => re.test(file))) {
    problems.push({ file, line: null, title: "файл не должен быть в репозитории", detail: file });
  }
}

// ── 2. Секреты в содержимом файлов ────────────────────────────────────
let scanned = 0;
for (const file of files) {
  if (!isTextFile(file)) {
    notes.push(`пропущен как бинарный: ${file}`);
    continue;
  }
  const text = await Bun.file(file).text();
  scanned++;

  if (!FIXTURE_FILES.has(file)) {
    const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    const isCode = CODE_EXTENSIONS.has(ext);
    const findings: Finding[] = scanText(text, { audience: "internal" })
      .filter((f) => f.severity === "block")
      .filter((f) => !isCode || STRONG_RULES.has(f.rule));
    for (const f of findings) {
      problems.push({ file, line: f.line, title: f.title, detail: f.excerpt });
    }
  }

  for (const { pattern, title } of INTERNAL_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20);
      if (INTERNAL_ALLOW.some((re) => re.test(around))) continue;
      if (isSelfLink(text, m.index + m[0].length)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      problems.push({ file, line, title, detail: m[0] });
    }
  }
}

// ── 3. История коммитов ───────────────────────────────────────────────
if (process.argv.includes("--history")) {
  // Проверяем не диффы, а каждую когда-либо существовавшую версию файла: строка,
  // добавленная в первом коммите и не тронутая во втором, в дифф второго не попадает,
  // а в публичной истории видна целиком.
  const objects = (await sh(["git", "rev-list", "--objects", "--all"]))
    .split("\n")
    .map((line) => {
      const space = line.indexOf(" ");
      return space === -1 ? null : { sha: line.slice(0, space), path: line.slice(space + 1).trim() };
    })
    .filter((o): o is { sha: string; path: string } => o !== null && o.path.length > 0);

  const blobs = new Map<string, string>(); // sha → путь (для адреса находки)
  for (const o of objects) {
    if (!isTextFile(o.path) || FIXTURE_FILES.has(o.path)) continue;
    if (!blobs.has(o.sha)) blobs.set(o.sha, o.path);
  }

  const MAX_BLOBS = 5000;
  const list = [...blobs.entries()].slice(0, MAX_BLOBS);
  if (blobs.size > MAX_BLOBS) notes.push(`история: проверено ${MAX_BLOBS} версий файлов из ${blobs.size}`);

  let checked = 0;
  for (const [sha, path] of list) {
    let text: string;
    try {
      text = await sh(["git", "cat-file", "-p", sha]);
    } catch {
      continue; // не блоб (дерево или тег)
    }
    checked++;
    const where = `${path}@${sha.slice(0, 8)}`;

    for (const f of scanText(text, { audience: "internal" })) {
      if (f.severity !== "block" || !STRONG_RULES.has(f.rule)) continue;
      problems.push({ file: `история ${where}`, line: f.line, title: f.title, detail: f.excerpt });
    }
    // Внутренние адреса в истории — ровно та утечка, ради которой история и проверяется.
    for (const { pattern, title } of INTERNAL_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20);
        if (INTERNAL_ALLOW.some((re) => re.test(around))) continue;
        if (isSelfLink(text, m.index + m[0].length)) continue;
        const line = text.slice(0, m.index).split("\n").length;
        problems.push({ file: `история ${where}`, line, title, detail: m[0] });
      }
    }
  }
  notes.push(`история: проверено ${checked} версий файлов во всех ветках и тегах`);
  const everAdded = (await sh(["git", "log", "--all", "--diff-filter=A", "--name-only", "--pretty=format:"]))
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  for (const file of new Set(everAdded)) {
    if (FORBIDDEN.some((re) => re.test(file))) {
      problems.push({ file, line: null, title: "файл присутствовал в истории", detail: file });
    }
  }
  notes.push(`история: просмотрено ${new Set(everAdded).size} когда-либо добавленных файлов`);
}

// ── итог ──────────────────────────────────────────────────────────────
console.log(`Файлов под контролем версий: ${files.length}, просмотрено как текст: ${scanned}`);
if (INTERNAL_PATTERNS.length === 0) {
  console.log("  список внутренних доменов не задан — проверяются только секреты по форме.");
  console.log("  Задайте AUDIT_INTERNAL_DOMAINS или audit.internalDomains в ~/.outline/config.json.");
} else {
  console.log(`  внутренних доменов в проверке: ${INTERNAL_PATTERNS.length}`);
}
for (const n of notes) console.log(`  ${n}`);

if (problems.length === 0) {
  console.log("\nПубликовать можно: секретов и внутренних адресов не найдено.");
  process.exit(0);
}

console.error(`\nНайдено проблем: ${problems.length}`);
for (const p of problems) {
  console.error(`  ${p.file}${p.line ? `:${p.line}` : ""} — ${p.title}: ${p.detail}`);
}
process.exit(1);
