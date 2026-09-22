#!/usr/bin/env bun
/**
 * Outline CLI — база знаний: документы, публикация, ссылки для клиентов.
 * Bun + TypeScript, нулевые зависимости, нативный fetch.
 *
 * Конфиг: ~/.outline/config.json (профили инстансов), env имеет приоритет.
 * Запись требует явного --yes: без него команда печатает предпросмотр и выходит.
 */

import { join } from "node:path";
import { guard, scanText, formatFindings, type Audience, type Finding } from "./guard.ts";

// ─────────────────────────────── конфиг ───────────────────────────────

type Instance = {
  url: string;
  apiKey: string;
  /** Коллекция по умолчанию для новых документов. */
  defaultCollection?: string;
  /** Коллекции, документы которых предназначены клиентам: проверка всегда строгая. */
  clientCollections?: string[];
};

type ConfigFile = {
  default?: string;
  instances: Record<string, Instance>;
};

type Resolved = Instance & { name: string; base: string };

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ".";
const CONFIG_DIR = join(HOME, ".outline");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const CACHE_PATH = join(CONFIG_DIR, "cache.json");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

class UserError extends Error {}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: string,
    readonly method: string,
  ) {
    super(`${method} → ${status} ${code}${details ? `: ${details}` : ""}`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readConfigFile(): Promise<ConfigFile | null> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) return null;
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    throw new UserError(`Конфиг ${CONFIG_PATH} не является валидным JSON.`);
  }
  if (!isRecord(raw) || !isRecord(raw.instances)) {
    throw new UserError(`В ${CONFIG_PATH} нет объекта "instances".`);
  }

  const instances: Record<string, Instance> = {};
  for (const [name, value] of Object.entries(raw.instances)) {
    if (!isRecord(value)) continue;
    instances[name] = {
      url: typeof value.url === "string" ? value.url : "",
      apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
      defaultCollection: typeof value.defaultCollection === "string" ? value.defaultCollection : undefined,
      clientCollections: Array.isArray(value.clientCollections)
        ? value.clientCollections.filter((c): c is string => typeof c === "string")
        : undefined,
    };
  }
  return { default: typeof raw.default === "string" ? raw.default : undefined, instances };
}

function normalizeBase(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new UserError(`URL Outline должен начинаться с http(s)://, получено: ${url}`);
  }
  return trimmed.endsWith("/") ? trimmed : trimmed + "/";
}

function pickInstance(cfg: ConfigFile, wanted: string): [string, Instance] {
  const names = Object.keys(cfg.instances);
  const needle = wanted.toLowerCase();
  const exact = names.find((n) => n.toLowerCase() === needle);
  if (exact) return [exact, cfg.instances[exact]!];
  const byUrl = names.find((n) => (cfg.instances[n]?.url ?? "").toLowerCase().includes(needle));
  if (byUrl) return [byUrl, cfg.instances[byUrl]!];
  throw new UserError(`Инстанс "${wanted}" не найден. Доступные: ${names.join(", ") || "нет"} (см. ${CONFIG_PATH}).`);
}

async function resolveInstance(requested: string | undefined): Promise<Resolved> {
  const cfg = await readConfigFile();
  const envUrl = process.env.OUTLINE_URL;
  const envKey = process.env.OUTLINE_API_KEY;
  const wanted = requested ?? process.env.OUTLINE_INSTANCE ?? cfg?.default;

  let name = "env";
  let inst: Instance | undefined;

  if (cfg && Object.keys(cfg.instances).length > 0) {
    if (wanted) {
      const [n, i] = pickInstance(cfg, wanted);
      name = n;
      inst = i;
    } else {
      const names = Object.keys(cfg.instances);
      if (names.length === 1) {
        name = names[0]!;
        inst = cfg.instances[name]!;
      } else if (!envUrl) {
        throw new UserError(
          `В конфиге несколько инстансов (${names.join(", ")}) и не задан "default". Укажите --instance <имя>.`,
        );
      }
    }
  }

  const url = envUrl ?? inst?.url ?? "";
  const apiKey = envKey ?? inst?.apiKey ?? "";
  if (!url || !apiKey) {
    throw new UserError(
      `Нет доступа к Outline. Заполните ${CONFIG_PATH} (образец — config.example.json в папке скилла) ` +
        `или задайте OUTLINE_URL и OUTLINE_API_KEY. Токен берётся в Outline: Настройки → API.`,
    );
  }
  return { ...(inst ?? {}), name, url, apiKey, base: normalizeBase(url) };
}

// ──────────────────────────────── HTTP ────────────────────────────────

/** В Outline все методы API вызываются POST-запросом на /api/<метод>. */
async function api<T>(rm: Resolved, method: string, body: Record<string, unknown> = {}): Promise<T> {
  const url = new URL(`api/${method}`, rm.base);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${rm.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* не JSON — обработаем ниже */
  }

  if (!res.ok || (isRecord(parsed) && parsed.ok === false)) {
    const code = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : `http_${res.status}`;
    let details = isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : text.slice(0, 200);
    if (code === "authentication_required" || res.status === 401) {
      details = "токен неверен или отозван — перевыпустите его в Настройки → API";
    }
    if (code === "authorization_error" || res.status === 403) {
      details = `недостаточно прав у владельца токена: ${details}`;
    }
    if (res.status === 404) details = `объект не найден: ${details}`;
    throw new ApiError(res.status, code, details, method);
  }

  if (!isRecord(parsed)) return undefined as T;
  return parsed.data as T;
}

/** Постраничный обход: Outline отдаёт data + pagination. */
async function apiAll<T>(rm: Resolved, method: string, body: Record<string, unknown>, max = 500): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (;;) {
    const limit = Math.min(100, max - out.length);
    if (limit <= 0) break;
    const page = await api<T[]>(rm, method, { ...body, offset, limit });
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    offset += page.length;
    if (page.length < limit) break;
  }
  return out;
}

// ─────────────────────────────── модели ───────────────────────────────

type OutlineUser = { id: string; name: string; email?: string; isAdmin?: boolean };
type Team = { id: string; name: string; url?: string; subdomain?: string };

type Collection = {
  id: string;
  name: string;
  description?: string;
  permission?: string | null;
  sharing?: boolean;
  icon?: string | null;
  color?: string | null;
  createdAt: string;
  updatedAt: string;
};

type DocumentRef = { id: string; title: string; url: string; children?: DocumentRef[] };

type Doc = {
  id: string;
  urlId?: string;
  title: string;
  text: string;
  url: string;
  emoji?: string | null;
  collectionId: string | null;
  parentDocumentId?: string | null;
  publishedAt?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  template?: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: OutlineUser;
  updatedBy?: OutlineUser;
  revision?: number;
};

type Share = {
  id: string;
  documentId: string;
  documentTitle?: string;
  documentUrl?: string;
  published: boolean;
  includeChildDocuments?: boolean;
  url: string;
  views?: number;
  lastAccessedAt?: string | null;
  createdAt: string;
  createdBy?: OutlineUser;
};

type SearchHit = { ranking: number; context: string; document: Doc };

// ──────────────────────────────── кэш ─────────────────────────────────

type CacheFile = Record<string, { at: number; data: unknown }>;
let cacheMemo: CacheFile | null = null;
let noCache = false;

async function cached<T>(rm: Resolved, key: string, load: () => Promise<T>): Promise<T> {
  const full = `${rm.name}:${key}`;
  if (!noCache) {
    if (cacheMemo === null) {
      const file = Bun.file(CACHE_PATH);
      cacheMemo = (await file.exists()) ? ((await file.json().catch(() => ({}))) as CacheFile) : {};
    }
    const hit = cacheMemo[full];
    if (hit && Date.now() - hit.at <= CACHE_TTL_MS) return hit.data as T;
  }
  const data = await load();
  if (cacheMemo === null) cacheMemo = {};
  cacheMemo[full] = { at: Date.now(), data };
  await Bun.write(CACHE_PATH, JSON.stringify(cacheMemo));
  return data;
}

// ─────────────────────────── справочники ──────────────────────────────

async function collections(rm: Resolved): Promise<Collection[]> {
  return cached(rm, "collections", async () => apiAll<Collection>(rm, "collections.list", {}, 200));
}

async function resolveCollection(rm: Resolved, value: string): Promise<Collection> {
  const list = await collections(rm);
  const low = value.toLowerCase();
  const byId = list.find((c) => c.id === value);
  if (byId) return byId;
  const exact = list.find((c) => c.name.toLowerCase() === low);
  if (exact) return exact;
  const partial = list.filter((c) => c.name.toLowerCase().includes(low));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new UserError(`Коллекция "${value}" неоднозначна: ${partial.map((c) => c.name).join(", ")}.`);
  }
  throw new UserError(`Коллекция "${value}" не найдена. Список: outline.ts collections`);
}

/** Принимает id, urlId или полный URL документа. */
function documentRef(value: string): string {
  const trimmed = value.trim();
  const fromUrl = trimmed.match(/\/doc\/([^/?#]+)/i);
  if (fromUrl?.[1]) return fromUrl[1];
  const fromShare = trimmed.match(/\/s\/([^/?#]+)/i);
  if (fromShare?.[1]) return fromShare[1];
  return trimmed;
}

// ────────────────────────────── argv ──────────────────────────────────

type Args = { cmd: string; positional: string[]; flags: Map<string, string | true> };

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const short: Record<string, string> = { i: "instance", c: "collection", q: "query", n: "limit", f: "file" };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(body, next);
        index++;
      } else {
        flags.set(body, true);
      }
    } else if (/^-[a-z]$/i.test(token)) {
      const name = short[token[1]!] ?? token[1]!;
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(name, next);
        index++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(token);
    }
  }
  const cmd = positional.shift() ?? "help";
  return { cmd, positional, flags };
}

const str = (args: Args, name: string): string | undefined => {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
};
const bool = (args: Args, name: string): boolean => args.flags.has(name) && args.flags.get(name) !== "false";
const num = (args: Args, name: string): number | undefined => {
  const v = str(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UserError(`Флаг --${name} ожидает число, получено "${v}".`);
  return n;
};
const required = (args: Args, name: string): string => {
  const v = str(args, name);
  if (v === undefined) throw new UserError(`Не задан обязательный флаг --${name}.`);
  return v;
};

// ────────────────────────────── вывод ─────────────────────────────────

let jsonMode = false;

function emit(data: unknown, human: () => string): void {
  if (jsonMode) console.log(JSON.stringify(data, null, 2));
  else console.log(human());
}

function table(rows: string[][]): string {
  if (rows.length === 0) return "(пусто)";
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, col) => Math.max(...rows.map((r) => (r[col] ?? "").length)));
  return rows
    .map((r) => r.map((cell, i) => (i === cols - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd())
    .join("\n");
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function docUrl(rm: Resolved, doc: Doc): string {
  return doc.url.startsWith("http") ? doc.url : new URL(doc.url.replace(/^\//, ""), rm.base).toString();
}

const RULE = "─".repeat(64);

// ─────────────── проверка содержимого и подтверждение ─────────────────

/**
 * Черновик проверяется по внутренней планке, публикация и выдача ссылки — по клиентской:
 * документ, который увидит заказчик, не должен содержать ни реквизитов, ни внутренней кухни.
 */
function checkOutgoing(fields: Record<string, string | undefined>, args: Args, audience: Audience): Finding[] {
  const result = guard(fields, { audience });
  if (result.findings.length === 0) return [];

  if (result.blocked && !bool(args, "override-guard")) {
    throw new UserError(
      `Остановлено: в тексте есть то, чего в базе знаний быть не должно.\n${result.report}\n` +
        `  Исправьте текст. Если находка ложная — повторите с --override-guard.`,
    );
  }
  console.error(
    (result.blocked ? "ПРОВЕРКА ОБОЙДЕНА (--override-guard):\n" : "Предупреждения проверки:\n") + result.report,
  );
  return result.findings;
}

function requireConfirmation(args: Args, preview: string): boolean {
  if (bool(args, "yes") && !bool(args, "dry-run")) return true;
  const tail = bool(args, "dry-run")
    ? "Предпросмотр: ничего не отправлено."
    : "Ничего не отправлено. Показать это пользователю, дождаться согласия и повторить с --yes.";
  emit({ dryRun: true, preview }, () => `${preview}\n\n${tail}`);
  return false;
}

async function readBody(args: Args): Promise<string | undefined> {
  const file = str(args, "file");
  if (file) return Bun.file(file).text();
  const inline = str(args, "text");
  if (inline !== undefined) return inline;
  if (bool(args, "stdin")) return new Response(Bun.stdin.stream()).text();
  return undefined;
}

// ───────────────────────────── команды ────────────────────────────────

async function cmdInstances(_args: Args): Promise<void> {
  const cfg = await readConfigFile();
  const rows = Object.entries(cfg?.instances ?? {}).map(([name, i]) => ({
    name,
    url: i.url,
    isDefault: cfg?.default === name,
    hasKey: Boolean(i.apiKey),
  }));
  emit({ configPath: CONFIG_PATH, instances: rows }, () =>
    rows.length === 0
      ? `Конфиг ${CONFIG_PATH} пуст или отсутствует.`
      : table([
          ["ИНСТАНС", "URL", "ТОКЕН", "ПО УМОЛЧ."],
          ...rows.map((r) => [r.name, r.url, r.hasKey ? "есть" : "НЕТ", r.isDefault ? "да" : ""]),
        ]),
  );
}

async function cmdWhoami(rm: Resolved, _args: Args): Promise<void> {
  const info = await api<{ user: OutlineUser; team: Team }>(rm, "auth.info");
  emit({ instance: rm.name, ...info }, () =>
    [
      `Инстанс: ${rm.name} (${rm.base})`,
      `Пользователь: ${info.user.name}${info.user.email ? ` (${info.user.email})` : ""}${
        info.user.isAdmin ? ", администратор" : ""
      }`,
      `Пространство: ${info.team.name}`,
    ].join("\n"),
  );
}

async function cmdCollections(rm: Resolved, args: Args): Promise<void> {
  const q = (str(args, "query") ?? args.positional[0] ?? "").toLowerCase();
  const list = (await collections(rm)).filter((c) => !q || c.name.toLowerCase().includes(q));
  emit(list, () =>
    list.length === 0
      ? "Коллекций не найдено."
      : table([
          ["ID", "КОЛЛЕКЦИЯ", "ДОСТУП", "ССЫЛКИ"],
          ...list.map((c) => [
            c.id.slice(0, 8),
            clip(c.name, 40),
            c.permission ?? "по приглашению",
            c.sharing === false ? "запрещены" : "разрешены",
          ]),
        ]),
  );
}

async function cmdTree(rm: Resolved, args: Args): Promise<void> {
  const value = str(args, "collection") ?? args.positional[0] ?? rm.defaultCollection;
  if (!value) throw new UserError("Укажите коллекцию: outline.ts tree --collection <имя>");
  const collection = await resolveCollection(rm, value);
  const nodes = await api<DocumentRef[]>(rm, "collections.documents", { id: collection.id });

  const lines: string[] = [];
  const walk = (list: DocumentRef[], depth: number): void => {
    for (const node of list) {
      lines.push(`${"  ".repeat(depth)}${depth > 0 ? "└ " : ""}${node.title || "(без названия)"}  ${node.id.slice(0, 8)}`);
      if (node.children?.length) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);

  emit({ collection, tree: nodes }, () =>
    `КОЛЛЕКЦИЯ ${collection.name}\n${lines.join("\n") || "(пусто)"}\n\nДокументов верхнего уровня: ${nodes.length}`,
  );
}

async function cmdDocs(rm: Resolved, args: Args): Promise<void> {
  const body: Record<string, unknown> = { sort: str(args, "sort") ?? "updatedAt", direction: "DESC" };
  const collection = str(args, "collection") ?? rm.defaultCollection;
  if (collection) body.collectionId = (await resolveCollection(rm, collection)).id;
  if (bool(args, "mine")) body.userId = (await api<{ user: OutlineUser }>(rm, "auth.info")).user.id;
  if (bool(args, "drafts")) body.template = false;

  const list = await apiAll<Doc>(rm, "documents.list", body, num(args, "limit") ?? 25);
  emit(list, () =>
    list.length === 0
      ? "Документов не найдено."
      : table([
          ["ID", "ОБНОВЛЁН", "СТАТУС", "НАЗВАНИЕ"],
          ...list.map((d) => [
            d.id.slice(0, 8),
            (d.updatedAt ?? "").slice(0, 10),
            d.publishedAt ? "опубликован" : "черновик",
            clip(d.title || "(без названия)", 60),
          ]),
        ]),
  );
}

async function cmdSearch(rm: Resolved, args: Args): Promise<void> {
  const query = args.positional.join(" ") || str(args, "query");
  if (!query) throw new UserError('Укажите текст поиска: outline.ts search "фраза"');
  const body: Record<string, unknown> = { query, limit: num(args, "limit") ?? 15 };
  const collection = str(args, "collection");
  if (collection) body.collectionId = (await resolveCollection(rm, collection)).id;

  const hits = await api<SearchHit[]>(rm, "documents.search", body);
  emit(hits, () =>
    hits.length === 0
      ? "Ничего не найдено."
      : hits
          .map(
            (h) =>
              `${h.document.title || "(без названия)"}  ${h.document.id.slice(0, 8)}\n` +
              `  ${clip(h.context, 150)}\n  ${docUrl(rm, h.document)}`,
          )
          .join("\n\n"),
  );
}

async function loadDoc(rm: Resolved, value: string): Promise<Doc> {
  return api<Doc>(rm, "documents.info", { id: documentRef(value) });
}

async function cmdDoc(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) throw new UserError("Укажите документ: outline.ts doc <id|url>");
  const doc = await loadDoc(rm, value);

  const out = str(args, "out");
  if (out) {
    await Bun.write(out, doc.text);
  }

  emit(doc, () => {
    const head = [
      `${doc.emoji ? doc.emoji + " " : ""}${doc.title || "(без названия)"}`,
      docUrl(rm, doc),
      `Статус: ${doc.publishedAt ? "опубликован" : "черновик"}${doc.archivedAt ? ", в архиве" : ""} | ` +
        `Обновлён: ${(doc.updatedAt ?? "").slice(0, 16).replace("T", " ")}` +
        (doc.updatedBy ? ` (${doc.updatedBy.name})` : ""),
    ].join("\n");
    if (bool(args, "meta")) return head;
    const body = bool(args, "full") ? doc.text : doc.text.slice(0, 4000);
    return `${head}\n${RULE}\n${body}${doc.text.length > body.length ? "\n… (полностью: --full)" : ""}\n${RULE}` +
      (out ? `\nСохранено: ${out}` : "");
  });
}

async function cmdCreate(rm: Resolved, args: Args): Promise<void> {
  const title = str(args, "title") ?? args.positional[0];
  if (!title) throw new UserError('Нужно название: --title "…"');
  const text = (await readBody(args)) ?? "";
  if (!text.trim()) throw new UserError("Нужен текст документа: --file <файл>, --text или --stdin.");

  const collectionValue = str(args, "collection") ?? rm.defaultCollection;
  if (!collectionValue) throw new UserError("Укажите коллекцию: --collection <имя>");
  const collection = await resolveCollection(rm, collectionValue);
  const publish = bool(args, "publish");

  // Публикуемый документ проверяем по клиентской планке, черновик — по внутренней.
  checkOutgoing({ название: title, текст: text }, args, publish ? "client" : "internal");

  const body: Record<string, unknown> = { title, text, collectionId: collection.id, publish };
  const parent = str(args, "parent");
  if (parent) body.parentDocumentId = documentRef(parent);

  const preview =
    `НОВЫЙ ДОКУМЕНТ · инстанс ${rm.name}\n` +
    table([
      ["Коллекция", collection.name],
      ["Название", title],
      ["Родитель", parent ? documentRef(parent) : "—"],
      ["Публикация", publish ? "да, сразу" : "нет, черновик"],
      ["Размер", `${text.length} символов`],
    ]) +
    `\n\nТЕКСТ (как уйдёт в Outline):\n${RULE}\n${text.trim()}\n${RULE}`;
  if (!requireConfirmation(args, preview)) return;

  const doc = await api<Doc>(rm, "documents.create", body);
  emit(doc, () => `Создан: ${doc.title}\n${docUrl(rm, doc)}\nID: ${doc.id}`);
}

async function cmdUpdate(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) throw new UserError("Укажите документ: outline.ts update <id|url> --file body.md");
  const current = await loadDoc(rm, value);

  const text = await readBody(args);
  const title = str(args, "title");
  const append = bool(args, "append");
  const publish = bool(args, "publish");
  if (text === undefined && title === undefined && !publish) {
    throw new UserError("Нечего менять: задайте --file/--text/--title или --publish.");
  }

  const audience: Audience = publish || current.publishedAt ? "client" : "internal";
  checkOutgoing({ название: title, текст: text }, args, audience);

  const body: Record<string, unknown> = { id: current.id };
  if (title !== undefined) body.title = title;
  if (text !== undefined) {
    body.text = text;
    body.append = append;
  }
  if (publish) body.publish = true;

  const preview =
    `ИЗМЕНЕНИЕ ДОКУМЕНТА · инстанс ${rm.name}\n${docUrl(rm, current)}\n` +
    table([
      ["Документ", current.title],
      ["Состояние", current.publishedAt ? "опубликован" : "черновик"],
      ["Новое название", title ?? "— без изменений"],
      ["Текст", text === undefined ? "— без изменений" : append ? "дописывается в конец" : "заменяется целиком"],
      ["Публикация", publish ? "да" : "— без изменений"],
    ]) +
    (text === undefined ? "" : `\n\n${append ? "ДОПИСЫВАЕМЫЙ ТЕКСТ" : "НОВЫЙ ТЕКСТ"}:\n${RULE}\n${text.trim()}\n${RULE}`);
  if (!requireConfirmation(args, preview)) return;

  const doc = await api<Doc>(rm, "documents.update", body);
  emit(doc, () => `Обновлён: ${doc.title}\n${docUrl(rm, doc)}`);
}

async function cmdPublish(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) throw new UserError("Укажите документ: outline.ts publish <id|url>");
  const doc = await loadDoc(rm, value);
  if (doc.publishedAt) {
    emit(doc, () => `Документ уже опубликован: ${docUrl(rm, doc)}`);
    return;
  }

  // Публикация переводит текст в разряд видимого команде и клиентам — планка клиентская.
  checkOutgoing({ название: doc.title, текст: doc.text }, args, "client");

  const preview =
    `ПУБЛИКАЦИЯ ДОКУМЕНТА · инстанс ${rm.name}\n${docUrl(rm, doc)}\n` +
    table([
      ["Документ", doc.title],
      ["Коллекция", doc.collectionId ?? "—"],
      ["Размер", `${doc.text.length} символов`],
    ]) +
    `\n\nТЕКСТ:\n${RULE}\n${clip(doc.text, 2000)}\n${RULE}`;
  if (!requireConfirmation(args, preview)) return;

  const updated = await api<Doc>(rm, "documents.update", { id: doc.id, publish: true });
  emit(updated, () => `Опубликован: ${updated.title}\n${docUrl(rm, updated)}`);
}

async function cmdShare(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) throw new UserError("Укажите документ: outline.ts share <id|url>");
  const doc = await loadDoc(rm, value);
  const withChildren = bool(args, "children");

  // Ссылка делает документ доступным всем, у кого она есть, — это публикация наружу.
  checkOutgoing({ название: doc.title, текст: doc.text }, args, "client");

  const warnings: string[] = [];
  if (!doc.publishedAt) warnings.push("документ ещё черновик — по ссылке он будет доступен как есть");
  if (doc.archivedAt) warnings.push("документ в архиве");

  const preview =
    `ПУБЛИЧНАЯ ССЫЛКА · инстанс ${rm.name}\n` +
    table([
      ["Документ", doc.title],
      ["Адрес внутри", docUrl(rm, doc)],
      ["Вложенные документы", withChildren ? "включены в ссылку" : "не включены"],
      ["Кто увидит", "любой, у кого есть ссылка, без входа в Outline"],
    ]) +
    (warnings.length ? `\n\nВнимание: ${warnings.join("; ")}.` : "") +
    `\n\nТЕКСТ, КОТОРЫЙ УВИДИТ ПОЛУЧАТЕЛЬ:\n${RULE}\n${clip(doc.text, 2000)}\n${RULE}`;
  if (!requireConfirmation(args, preview)) return;

  const share = await api<Share>(rm, "shares.create", {
    documentId: doc.id,
    includeChildDocuments: withChildren,
  });
  // shares.create возвращает ссылку, но публичной её делает флаг published.
  const published = await api<Share>(rm, "shares.update", { id: share.id, published: true });
  emit(published, () =>
    `Ссылка выдана: ${published.url}\nДокумент: ${doc.title}\nОтозвать: outline.ts unshare ${published.id} --yes`,
  );
}

async function cmdShares(rm: Resolved, args: Args): Promise<void> {
  const documentValue = str(args, "document") ?? args.positional[0];
  const list = documentValue
    ? [await api<Share>(rm, "shares.info", { documentId: documentRef(documentValue) })].filter(Boolean)
    : await apiAll<Share>(rm, "shares.list", {}, num(args, "limit") ?? 100);

  emit(list, () =>
    list.length === 0
      ? "Выданных ссылок нет."
      : table([
          ["ID ССЫЛКИ", "ПУБЛИЧНА", "ПРОСМОТРОВ", "ПОСЛЕДНИЙ", "ДОКУМЕНТ", "URL"],
          ...list.map((s) => [
            s.id.slice(0, 8),
            s.published ? "да" : "нет",
            String(s.views ?? 0),
            (s.lastAccessedAt ?? "—").slice(0, 10),
            clip(s.documentTitle ?? s.documentId, 30),
            s.url,
          ]),
        ]),
  );
}

async function cmdUnshare(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) throw new UserError("Укажите ссылку или документ: outline.ts unshare <shareId|docId> --yes");
  let shareId = value;
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    const info = await api<Share>(rm, "shares.info", { documentId: documentRef(value) });
    shareId = info.id;
  }
  if (!bool(args, "yes")) {
    throw new UserError(`Отзыв ссылки необратим. Повторите с --yes: outline.ts unshare ${shareId} --yes`);
  }
  await api(rm, "shares.revoke", { id: shareId });
  emit({ revoked: shareId }, () => `Ссылка ${shareId} отозвана: документ больше не доступен по ней.`);
}

async function cmdMove(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) throw new UserError("Укажите документ: outline.ts move <id> --collection <имя>");
  const doc = await loadDoc(rm, value);
  const body: Record<string, unknown> = { id: doc.id };
  const collection = str(args, "collection");
  if (collection) body.collectionId = (await resolveCollection(rm, collection)).id;
  const parent = str(args, "parent");
  if (parent) body.parentDocumentId = documentRef(parent);
  if (!collection && !parent) throw new UserError("Задайте --collection и/или --parent.");

  const preview = `ПЕРЕМЕЩЕНИЕ · ${doc.title}\n${docUrl(rm, doc)}\nКуда: ${collection ?? "та же коллекция"}${
    parent ? `, родитель ${documentRef(parent)}` : ""
  }`;
  if (!requireConfirmation(args, preview)) return;

  await api(rm, "documents.move", body);
  const updated = await loadDoc(rm, doc.id);
  emit(updated, () => `Перемещён: ${updated.title}\n${docUrl(rm, updated)}`);
}

async function cmdArchive(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) throw new UserError("Укажите документ: outline.ts archive <id> --yes");
  const doc = await loadDoc(rm, value);
  const preview = `АРХИВАЦИЯ · ${doc.title}\n${docUrl(rm, doc)}\nДокумент пропадёт из коллекции, но останется в архиве.`;
  if (!requireConfirmation(args, preview)) return;
  await api(rm, "documents.archive", { id: doc.id });
  emit({ archived: doc.id }, () => `В архиве: ${doc.title}`);
}

async function cmdDelete(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) throw new UserError("Укажите документ: outline.ts delete <id> --yes");
  const doc = await loadDoc(rm, value);
  if (!bool(args, "yes")) {
    throw new UserError(
      `Удаление необратимо${bool(args, "permanent") ? " и окончательно" : ""}: «${doc.title}».\n` +
        `Повторите с --yes: outline.ts delete ${doc.id} --yes`,
    );
  }
  await api(rm, "documents.delete", { id: doc.id, permanent: bool(args, "permanent") });
  emit({ deleted: doc.id }, () => `Удалён: ${doc.title}${bool(args, "permanent") ? " (окончательно)" : " (в корзину)"}`);
}

async function cmdExport(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) throw new UserError("Укажите документ: outline.ts export <id> --out файл.md");
  const doc = await loadDoc(rm, value);
  const markdown = await api<string>(rm, "documents.export", { id: doc.id });
  const out = str(args, "out");
  if (out) await Bun.write(out, typeof markdown === "string" ? markdown : doc.text);
  emit({ id: doc.id, title: doc.title, out: out ?? null }, () =>
    out ? `Выгружено в ${out}: ${doc.title}` : (typeof markdown === "string" ? markdown : doc.text),
  );
}

async function cmdScan(args: Args): Promise<void> {
  const file = str(args, "file");
  const text = file ? await Bun.file(file).text() : (str(args, "text") ?? args.positional.join(" "));
  if (!text.trim()) throw new UserError('Нечего проверять: --text "…" или --file <файл>.');
  const audience: Audience = str(args, "audience") === "internal" ? "internal" : "client";
  const findings = scanText(text, { audience });
  const blocked = findings.some((f) => f.severity === "block");
  emit({ audience, blocked, findings }, () =>
    findings.length === 0
      ? `Проверка пройдена (аудитория: ${audience === "client" ? "клиент" : "внутренняя"}). Публиковать можно.`
      : `${blocked ? "ПУБЛИКОВАТЬ НЕЛЬЗЯ" : "Замечания"}:\n${formatFindings(findings)}`,
  );
  if (blocked) process.exitCode = 2;
}

function cmdHelp(): void {
  console.log(`outline.ts — CLI для Outline (Bun).

Общие флаги: --instance <имя>  --json  --no-cache

ЗАПИСЬ ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ: create, update, publish, share, move, archive, delete
без --yes печатают полный предпросмотр и ничего не меняют. Текст документа проверяется
на компрометацию: черновик — по внутренней планке, публикация и ссылка — по клиентской.

Навигация
  instances                         профили из конфига
  whoami                            кто я и в каком пространстве
  collections [строка]              коллекции
  tree [--collection X]             структура коллекции
  docs [--collection X] [--mine] [--limit N]
  search "фраза" [--collection X] [--limit N]
  doc <id|url> [--full] [--meta] [--out файл.md]

Документы
  create --title "…" (--file f | --text "…" | --stdin) [--collection X] [--parent <id>] [--publish] [--yes]
  update <id|url> [--title "…"] [--file f|--text "…"] [--append] [--publish] [--yes]
  publish <id|url> [--yes]          черновик → опубликован
  move <id> [--collection X] [--parent <id>] [--yes]
  archive <id> [--yes] | delete <id> [--permanent] --yes
  export <id> --out файл.md

Ссылки для клиентов
  share <id|url> [--children] [--yes]   выдать публичную ссылку
  shares [--document <id>]              что выдано: просмотры и последнее обращение
  unshare <shareId|docId> --yes         отозвать ссылку

Проверка текста
  scan (--file f | --text "…") [--audience client|internal]

Конфиг: ${CONFIG_PATH} (env OUTLINE_URL / OUTLINE_API_KEY / OUTLINE_INSTANCE имеют приоритет).
Токен: в Outline → Настройки → API → создать токен.`);
}

// ─────────────────────────────── точка входа ──────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  jsonMode = bool(args, "json");
  noCache = bool(args, "no-cache") || bool(args, "refresh");

  if (args.cmd === "help" || bool(args, "help")) return cmdHelp();
  if (args.cmd === "instances" || args.cmd === "config") return cmdInstances(args);
  if (args.cmd === "scan" || args.cmd === "check") return cmdScan(args);

  const rm = await resolveInstance(str(args, "instance"));
  const handlers: Record<string, (rm: Resolved, a: Args) => Promise<void>> = {
    whoami: cmdWhoami,
    collections: cmdCollections,
    tree: cmdTree,
    docs: cmdDocs,
    list: cmdDocs,
    search: cmdSearch,
    doc: cmdDoc,
    read: cmdDoc,
    create: cmdCreate,
    update: cmdUpdate,
    publish: cmdPublish,
    share: cmdShare,
    shares: cmdShares,
    unshare: cmdUnshare,
    move: cmdMove,
    archive: cmdArchive,
    delete: cmdDelete,
    export: cmdExport,
  };
  const handler = handlers[args.cmd];
  if (!handler) throw new UserError(`Неизвестная команда "${args.cmd}". Список команд: outline.ts help`);
  await handler(rm, args);
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (error instanceof UserError) console.error(`Ошибка: ${error.message}`);
    else if (error instanceof ApiError) console.error(`Outline API: ${error.message}`);
    else console.error(`Сбой: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// Импорт модуля (тесты) не должен запускать CLI.
if (import.meta.main) await run();

export { documentRef, clip };
