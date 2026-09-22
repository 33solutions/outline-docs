#!/usr/bin/env bun
/**
 * Обновление скилла из репозитория.
 *
 *   bun scripts/update.ts               проверить и сообщить, если вышла новая версия
 *   bun scripts/update.ts --apply       обновить (git pull --ff-only)
 *   bun scripts/update.ts --apply --if-stale 86400 --quiet   тихая проверка раз в сутки (для hook)
 *
 * Обновление применяется только при чистом рабочем дереве и только перемоткой вперёд:
 * локальные правки пользователя никогда не затираются.
 */

import { join } from "node:path";

const SKILL_DIR = join(import.meta.dir, "..");
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ".";
const STATE_PATH = join(HOME, ".outline", "state.json");

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const valueOf = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const quiet = has("--quiet");
const apply = has("--apply");

function say(message: string): void {
  if (!quiet) console.log(message);
}

async function git(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", "-C", SKILL_DIR, ...argv], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
}

type State = Record<string, unknown> & { update?: { checkedAt?: number; lastVersion?: string } };

async function readState(): Promise<State> {
  const file = Bun.file(STATE_PATH);
  if (!(await file.exists())) return {};
  return ((await file.json().catch(() => ({}))) ?? {}) as State;
}

async function writeState(patch: State["update"]): Promise<void> {
  const state = await readState();
  state.update = { ...(state.update ?? {}), ...patch };
  await Bun.write(STATE_PATH, JSON.stringify(state, null, 2));
}

async function localVersion(): Promise<string> {
  const file = Bun.file(join(SKILL_DIR, "VERSION"));
  return (await file.exists()) ? (await file.text()).trim() : "0.0.0";
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function main(): Promise<void> {
  // Пропуск по свежести: hook при каждом запуске сессии не должен ходить в сеть.
  const stale = valueOf("--if-stale");
  if (stale !== undefined) {
    const maxAge = Number(stale) * 1000;
    const checkedAt = (await readState()).update?.checkedAt ?? 0;
    const age = Date.now() - checkedAt;
    if (Number.isFinite(maxAge) && age < maxAge) {
      say(`Проверка обновлений пропущена: прошло ${Math.round(age / 3600_000)} ч из ${Math.round(maxAge / 3600_000)}.`);
      return;
    }
  }

  const repo = await git("rev-parse", "--is-inside-work-tree");
  if (repo.code !== 0) {
    say("Скилл установлен не из git — обновление недоступно. Переустановите через git clone, чтобы получать обновления.");
    return;
  }

  const fetched = await git("fetch", "--quiet", "--tags", "origin");
  await writeState({ checkedAt: Date.now() });
  if (fetched.code !== 0) {
    say(`Не удалось связаться с репозиторием: ${fetched.err || "нет сети"}`);
    return;
  }

  const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).out || "main";
  const behind = await git("rev-list", "--count", `HEAD..origin/${branch}`);
  const ahead = await git("rev-list", "--count", `origin/${branch}..HEAD`);
  const behindCount = Number(behind.out) || 0;
  const aheadCount = Number(ahead.out) || 0;
  const version = await localVersion();

  if (behindCount === 0) {
    say(`Скилл актуален: версия ${version}, ветка ${branch}.`);
    return;
  }

  const log = await git("log", "--oneline", "--no-decorate", `HEAD..origin/${branch}`);
  const remoteVersion = (await git("show", `origin/${branch}:VERSION`)).out || version;
  const newer = compareVersions(remoteVersion, version) > 0;

  const headline =
    `Доступно обновление скилла outline-docs: ${version} → ${remoteVersion}` +
    (newer ? "" : " (изменения без смены версии)") +
    `, коммитов: ${behindCount}`;

  if (!apply) {
    console.log(`${headline}\n${log.out}\n\nОбновить: bun ${join(SKILL_DIR, "scripts", "update.ts")} --apply`);
    await writeState({ lastVersion: remoteVersion });
    return;
  }

  const dirty = await git("status", "--porcelain");
  if (dirty.out) {
    console.log(
      `${headline}\nОбновление не применено: в папке скилла есть несохранённые изменения.\n${dirty.out}\n` +
        `Разберитесь с ними и повторите: git -C "${SKILL_DIR}" pull --ff-only`,
    );
    return;
  }
  if (aheadCount > 0) {
    console.log(`${headline}\nОбновление не применено: локальная ветка ушла вперёд на ${aheadCount} коммит(ов).`);
    return;
  }

  const pulled = await git("pull", "--ff-only", "--quiet", "origin", branch);
  if (pulled.code !== 0) {
    console.log(`${headline}\nОбновление не применено: ${pulled.err}`);
    return;
  }
  await writeState({ lastVersion: remoteVersion });
  console.log(`Скилл обновлён: ${version} → ${await localVersion()}\n${log.out}`);
}

await main();
