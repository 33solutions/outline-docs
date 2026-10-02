#!/usr/bin/env bun
/**
 * Outline CLI — база знаний: документы, публикация, ссылки для клиентов, вложения.
 * Bun + TypeScript, нулевые зависимости, нативный fetch.
 *
 * Конфиг: ~/.outline/config.json (профили инстансов), env имеет приоритет.
 * Запись требует явного --yes: без него команда печатает предпросмотр и выходит.
 */

import { basename, join } from "node:path";
import { mkdir, readdir, rename, rm as removePath, stat, writeFile } from "node:fs/promises";
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
    /** Сообщение сервера как есть: по нему отличают, например, ограничение ключа от нехватки прав. */
    readonly serverMessage = "",
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
    const serverMessage = isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : "";
    let details = isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : text.slice(0, 200);
    if (code === "authentication_required" || res.status === 401) {
      details = "токен неверен или отозван — перевыпустите его в Настройки → API";
    }
    if (code === "authorization_error" || res.status === 403) {
      details = `недостаточно прав у владельца токена: ${details}`;
    }
    if (res.status === 404) details = `объект не найден: ${details}`;
    throw new ApiError(res.status, code, details, method, serverMessage);
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
  /** null — у ссылки на всю коллекцию. */
  documentId: string | null;
  /** Есть у ссылки на всю коллекцию. */
  collectionId?: string | null;
  /** Что открывает ссылка: название коллекции или документа (1.10). */
  sourceTitle?: string;
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

/**
 * Планка проверки: клиентская — только там, где текст реально уходит наружу.
 * Публикация делает документ видимым команде, а не клиенту, поэтому строгой её делает
 * либо выдача публичной ссылки, либо принадлежность коллекции из clientCollections.
 */
async function audienceFor(rm: Resolved, collectionId: string | null | undefined): Promise<Audience> {
  const marks = rm.clientCollections ?? [];
  if (marks.length === 0 || !collectionId) return "internal";
  const list = await collections(rm);
  const collection = list.find((c) => c.id === collectionId);
  if (!collection) return "internal";
  return isClientCollection(rm, collection) ? "client" : "internal";
}

/** Коллекция помечена в clientCollections — по id или по части названия. */
function isClientCollection(rm: Resolved, collection: Pick<Collection, "id" | "name">): boolean {
  return (rm.clientCollections ?? []).some(
    (mark) => mark === collection.id || collection.name.toLowerCase().includes(mark.toLowerCase()),
  );
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

type Args = {
  cmd: string;
  positional: string[];
  flags: Map<string, string | true>;
  /** Все флаги по порядку, с повторами: flags хранит только последнее значение, а attach --file/--url повторяемы. */
  all: [string, string | true][];
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const all: [string, string | true][] = [];
  const short: Record<string, string> = { i: "instance", c: "collection", q: "query", n: "limit", f: "file" };
  const put = (name: string, value: string | true): void => {
    flags.set(name, value);
    all.push([name, value]);
  };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        put(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        put(body, next);
        index++;
      } else {
        put(body, true);
      }
    } else if (/^-[a-z]$/i.test(token)) {
      const name = short[token[1]!] ?? token[1]!;
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        put(name, next);
        index++;
      } else {
        put(name, true);
      }
    } else {
      positional.push(token);
    }
  }
  const cmd = positional.shift() ?? "help";
  return { cmd, positional, flags, all };
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

// ─────────────── публичные ссылки: своя и унаследованные ──────────────
//
// Без входа документ открывается своей ссылкой, ссылкой на всю коллекцию или ссылкой
// на родительский документ, выданной вместе с вложенными. Две последние открывают и другие
// документы, поэтому по одному документу их не отзывают.

/**
 * Ссылки из ответа shares.info — единственный разбор этого ответа в скрипте. 1.10.1 отдаёт
 * { shares: [...] }: по id — саму ссылку, по documentId — свою ссылку документа и одну родительскую,
 * по collectionId — ссылку коллекции; ссылки нет — 204 без тела. Старые версии — одну ссылку или 404.
 */
async function sharesInfo(rm: Resolved, body: Record<string, unknown>): Promise<Share[]> {
  let data: unknown;
  try {
    data = await api<unknown>(rm, "shares.info", body);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
  const list: unknown[] =
    isRecord(data) && Array.isArray(data.shares) ? data.shares : isRecord(data) && typeof data.id === "string" ? [data] : [];
  return list.filter((s): s is Share => isRecord(s) && typeof s.id === "string");
}

/** Чья ссылка открывает документ: его собственная, на всю коллекцию или на предка вместе с вложенными. */
type LinkVia = "own" | "collection" | "parent";
type DocumentLink = { via: LinkVia; share: Share };

type DocumentLinks = {
  /** Своя ссылка документа — в любом состоянии: снятая с публикации тоже существует и отзывается. */
  own: Share | null;
  /** Опубликованные ссылки, открывающие документ вместе с другими: на коллекцию и на предков. */
  inherited: DocumentLink[];
  /** Почему ссылки коллекции и предков проверены не до конца; нет поля — проверено всё. */
  unchecked?: string;
  /** Черновик вне коллекции: его собственную ссылку 1.10.1 по документу не показывает. */
  ownHidden?: boolean;
};

/**
 * Все ссылки, которыми открыт документ. Outline 1.10.1 на shares.info { documentId } отвечает 204,
 * если своей ссылки у документа нет, — даже когда открыта вся коллекция или родительский документ
 * вместе с вложенными, — а к своей ссылке добавляет лишь одну родительскую. Поэтому по очереди
 * проверяются своя ссылка, ссылка на коллекцию и ссылки предков вверх по дереву.
 * firstOpen — остановиться на первой опубликованной: attach нужно знать только, открыт ли документ.
 * Сбой на своей ссылке — ошибка команды; сбой дальше — пометка unchecked при том, что уже найдено.
 */
async function documentLinks(rm: Resolved, doc: Doc, firstOpen = false): Promise<DocumentLinks> {
  const links: DocumentLinks = { own: null, inherited: [] };
  const seen = new Set<string>();
  // Чужая ссылка открывает документ, если опубликована и выдана на всю коллекцию или на предка
  // вместе с вложенными: ссылка предка без вложенных открывает только его самого.
  const take = (share: Share): void => {
    if (seen.has(share.id) || share.published !== true) return;
    const via: LinkVia | null = share.collectionId
      ? "collection"
      : share.documentId !== doc.id && share.includeChildDocuments === true
        ? "parent"
        : null;
    if (!via) return;
    seen.add(share.id);
    links.inherited.push({ via, share });
  };
  const enough = (): boolean => firstOpen && (links.own?.published === true || links.inherited.length > 0);

  const first = await sharesInfo(rm, { documentId: doc.id });
  links.own = first.find((s) => s.documentId === doc.id && !s.collectionId) ?? null;
  if (links.own) seen.add(links.own.id);
  first.forEach(take);
  // У черновика вне коллекции 1.10.1 на shares.info { documentId } отвечает 204, даже если своя
  // ссылка у него есть («Collection not found for the shared document» превращается в 204).
  if (!links.own && !doc.collectionId) links.ownHidden = true;
  if (enough()) return links;

  try {
    if (doc.collectionId) {
      (await sharesInfo(rm, { collectionId: doc.collectionId })).forEach(take);
      if (enough()) return links;
    }
    const visited = new Set<string>([doc.id]);
    let parentId = doc.parentDocumentId ?? null;
    while (parentId && !visited.has(parentId) && visited.size <= 25) {
      visited.add(parentId);
      (await sharesInfo(rm, { documentId: parentId })).forEach(take);
      if (enough()) return links;
      parentId = (await loadDoc(rm, parentId)).parentDocumentId ?? null;
    }
  } catch (error) {
    links.unchecked = error instanceof ApiError ? `${error.status} ${error.code}` : networkReason(error);
  }
  return links;
}

/** Название коллекции или документа, который открывает ссылка, — в ёлочках и с пробелом впереди; пусто, если его нет. */
function quotedTitle(share: Share): string {
  const name = share.sourceTitle ?? share.documentTitle;
  return name ? ` «${name}»` : "";
}

/** Откуда ссылка — словами: своя, на всю коллекцию «…» или на родительский документ «…» с вложенными. */
function linkOrigin(link: DocumentLink): string {
  if (link.via === "own") return "своя ссылка";
  if (link.via === "collection") return `ссылка на всю коллекцию${quotedTitle(link.share)}`;
  return `ссылка на родительский документ${quotedTitle(link.share)} вместе с вложенными`;
}

// ─────────────────── вложения: файлы, ссылки, разметка ────────────────
//
// Файлы прикладывает сам человек своим ключом из конфига: Outline сам проверяет его право
// на правку документа, а в истории правок остаётся его имя. Служебного ключа у скилла нет.

/**
 * Копии файлов, скачанных по --url. Ссылки одноразовые и короткоживущие: предпросмотр скачивает
 * файл сразу (иначе не показать имя и размер, а без них — и текст, который уйдёт в документ),
 * и запись с --yes берёт байты отсюда, а не со ссылки, которая второй раз уже не откроется.
 */
const DOWNLOAD_DIR = join(CONFIG_DIR, "downloads");
/** Копия живёт до записи; неподтверждённая удаляется через час при следующем запуске скрипта. */
const DOWNLOAD_TTL_MS = 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_MB = 100;
const MAX_REDIRECTS = 5;
/** attachments.create в Outline ограничен 25 вызовами в минуту. */
const MAX_FILES = 20;
const UPDATE_ATTEMPTS = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Картинкой — то, что браузер покажет в тексте документа; tiff, heic и прочее — вложением. */
const INLINE_IMAGE_RE = /^image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)$/;

type AttachSource = { kind: "file" | "url"; value: string };

type PreparedFile = {
  kind: "file" | "url";
  name: string;
  size: number;
  contentType: string;
  /** Где лежат байты: файл пользователя или локальная копия скачанного. */
  path: string;
  /** Что можно показывать: путь к файлу или хост и путь ссылки — без строки запроса. */
  origin: string;
  /** Скачанный файл взят из копии, сделанной предпросмотром. */
  cached?: boolean;
  /** Ключ локальной копии — чтобы удалить её после записи. */
  cacheKey?: string;
};

/**
 * Строки, которые нельзя напечатать ни при каких условиях: ссылки --url целиком, их строка запроса
 * и значения параметров — в них одноразовый токен. Сообщения строятся из хоста и пути, а это —
 * последний рубеж для текста ошибок, пришедшего не от нас.
 */
const SECRET_STRINGS = new Set<string>();

function rememberSecret(url: URL, raw?: string): void {
  if (raw) SECRET_STRINGS.add(raw);
  SECRET_STRINGS.add(url.href);
  if (url.search.length > 1) SECRET_STRINGS.add(url.search.slice(1));
  for (const value of url.searchParams.values()) if (value.length >= 6) SECRET_STRINGS.add(value);
  if (url.password) SECRET_STRINGS.add(url.password);
}

function redact(text: string): string {
  let out = text;
  for (const secret of [...SECRET_STRINGS].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join("…");
  }
  return out;
}

/** Хост и путь — всё, что можно показать из ссылки. */
function safeUrl(url: URL): string {
  return `${url.host}${url.pathname}`;
}

/** Только https: файл не должен идти по сети открытым текстом. */
function parseDownloadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UserError("--url: это не адрес. Передайте ссылку целиком, как её выдал инструмент.");
  }
  rememberSecret(url, raw);
  if (url.protocol !== "https:") {
    throw new UserError(
      `--url принимает только https-ссылки, а ссылка на ${safeUrl(url)} — ${url.protocol.replace(":", "")}: ` +
        `файл шёл бы по сети открытым текстом. Попросите https-ссылку.`,
    );
  }
  return url;
}

/** Байты из %XX, остальное — как UTF-8. */
function percentBytes(text: string): Uint8Array {
  const out: number[] = [];
  const encoder = new TextEncoder();
  for (const part of text.split(/(%[0-9A-Fa-f]{2})/)) {
    if (/^%[0-9A-Fa-f]{2}$/.test(part)) out.push(parseInt(part.slice(1), 16));
    else for (const byte of encoder.encode(part)) out.push(byte);
  }
  return new Uint8Array(out);
}

/** filename*: «кодировка'язык'значение-в-процентах» (RFC 5987). */
function decodeExtValue(value: string): string | undefined {
  const match = value.trim().match(/^([A-Za-z0-9!#$&+^_`{}~-]*)'[^']*'(.*)$/);
  if (!match) return undefined;
  const charset = (match[1] ?? "").toLowerCase();
  const bytes = percentBytes(match[2] ?? "");
  try {
    if (charset === "utf-8" || charset === "utf8" || charset === "") {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    if (charset === "iso-8859-1" || charset === "latin1") return String.fromCharCode(...bytes);
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Заголовки HTTP — это байты: имя, отправленное сервером «как есть» в UTF-8, может прийти
 * прочитанным как latin1 («Ð¾Ñ…»). Если строка целиком из таких байтов и складывается
 * в правильный UTF-8 — это он.
 */
function repairUtf8(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value) || /[^\u0000-\u00ff]/.test(value)) return value;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value, (c) => c.charCodeAt(0)));
  } catch {
    return value;
  }
}

/**
 * Имя файла из Content-Disposition (RFC 6266): filename* (RFC 5987, с явной кодировкой) главнее
 * filename — простой filename сервер обычно даёт запасным вариантом для старых клиентов.
 */
function filenameFromDisposition(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const params = new Map<string, string>();
  for (const m of header.matchAll(/;\s*([^\s=;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g)) {
    const key = (m[1] ?? "").toLowerCase();
    const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "").trim();
    if (key && !params.has(key)) params.set(key, value);
  }
  const extended = params.get("filename*");
  const decoded = extended === undefined ? undefined : decodeExtValue(extended);
  if (decoded?.trim()) return decoded;
  const plain = params.get("filename");
  return plain?.trim() ? repairUtf8(plain) : undefined;
}

/** Последний сегмент пути ссылки — имя, если сервер его не назвал. */
function fileNameFromUrl(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Имя без каталогов и управляющих символов, не длиннее того, что хранит Outline (255). */
function cleanFileName(raw: string | undefined): string {
  let name = ((raw ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name === "." || name === "..") name = "";
  if (name.length > 255) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, 255 - ext.length) + ext;
  }
  return name || "file";
}

function mediaType(value: string | null | undefined): string {
  const type = (value ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(type) ? type : "";
}

/**
 * Тип файла: заявленный сервером главнее. «application/octet-stream» ничего не говорит —
 * тогда, как браузер, по расширению имени (таблица типов в Bun; файл при этом не читается).
 */
function contentTypeFor(declared: string | null | undefined, name: string): string {
  const type = mediaType(declared);
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream") return type;
  return mediaType(Bun.file(name).type) || "application/octet-stream";
}

function isInlineImage(contentType: string): boolean {
  return INLINE_IMAGE_RE.test(contentType);
}

function formatBytes(bytes: number): string {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown =
    unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(".", ",").replace(/,0$/, "");
  return `${shown} ${units[unit]}`;
}

/**
 * Подпись вложения в разметке. Outline 1.10.1 (shared/editor/rules/links.ts) превращает в вложение
 * ссылку на /api/attachments.redirect и берёт подпись только из ПЕРВОГО текстового фрагмента ссылки,
 * отделяя размер по последнему пробелу. Экранирование обратной косой не спасает — оно само дробит
 * текст на фрагменты, — поэтому знаки, с которых начинается разметка, заменяются. Обычные имена
 * («IMG_2041.jpg», «Отчёт (финал).xlsx») не меняются.
 */
function attachmentTitle(name: string): string {
  const title = name
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/[\\`*$]/g, "-")
    .replace(/~{2,}|={2,}/g, (run) => "-".repeat(run.length))
    .replace(/&(?=#?[0-9A-Za-z]+;)/g, "+")
    // «_» внутри слова разметку не начинает, а на границе слова открывает курсив: «_черновик_».
    .replace(/_+/g, (run: string, offset: number, whole: string) =>
      /[\p{L}\p{N}]/u.test(whole[offset - 1] ?? "") && /[\p{L}\p{N}]/u.test(whole[offset + run.length] ?? "")
        ? run
        : "-".repeat(run.length),
    )
    .replace(/\s+/g, " ")
    .trim();
  return title || "file";
}

type AppendixItem = { name: string; size: number; contentType: string; url: string };

/**
 * Текст, дописываемый в конец документа: строка комментария и по абзацу на файл.
 *
 * Ведущая пустая строка обязательна: в режиме append Outline сливает первый абзац дописываемого
 * текста с последним абзацем документа, если текст не начинается с перевода строки
 * (DocumentHelper.applyMarkdownToDocument) — комментарий приклеился бы к чужой фразе.
 * Каждое вложение — отдельным абзацем: правило Outline заменяет вложением весь абзац со ссылкой
 * и выбрасывает остальное, что в нём было, — комментарий в том же абзаце пропал бы.
 * Формат вложения — как у самого Outline: «[имя размер-в-байтах](/api/attachments.redirect?id=…)».
 */
function appendixMarkdown(comment: string | undefined, items: AppendixItem[]): string {
  const blocks: string[] = [];
  if (comment?.trim()) blocks.push(comment.trim());
  for (const item of items) {
    const title = attachmentTitle(item.name);
    blocks.push(isInlineImage(item.contentType) ? `![${title}](${item.url})` : `[${title} ${item.size}](${item.url})`);
  }
  return `\n\n${blocks.join("\n\n")}\n`;
}

/** Почему не вышло, без текста исключения: в нём бывает адрес со строкой запроса. */
function networkReason(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  if (name === "TimeoutError" || name === "AbortError") return "сервер не ответил вовремя";
  if (/CERT|SSL|TLS|SELF_SIGNED|VERIFY/i.test(code)) return `сертификат сервера не прошёл проверку (${code})`;
  if (/REFUSED/i.test(code)) return "соединение отклонено";
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(code)) return "адрес сервера не найден";
  if (/RESET|ECONNABORTED|EPIPE|SOCKET|CLOSED/i.test(code)) return "соединение оборвалось";
  return `сетевая ошибка${code ? ` (${code})` : name ? ` (${name})` : ""}`;
}

/** Перенаправления — вручную: каждое обязано остаться на https. */
async function fetchFollowingHttps(start: URL, signal: AbortSignal): Promise<{ res: Response; url: URL }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { redirect: "manual", signal, headers: { Accept: "*/*" } });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return { res, url };
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (!location) throw new UserError(`Ссылка на ${safeUrl(start)}: перенаправление без адреса (${res.status}).`);
    if (hop >= MAX_REDIRECTS) throw new UserError(`Ссылка на ${safeUrl(start)}: слишком много перенаправлений.`);
    const next = new URL(location, url);
    rememberSecret(next);
    if (next.protocol !== "https:") {
      throw new UserError(`Ссылка на ${safeUrl(start)} перенаправляет на не-https адрес ${safeUrl(next)} — скачивание остановлено.`);
    }
    url = next;
  }
}

/** Скачать по одноразовой ссылке с пределом размера и тайм-аутом. */
async function downloadFile(
  raw: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; name: string; contentType: string; origin: string }> {
  const start = parseDownloadUrl(raw);
  const origin = safeUrl(start);
  const tooBig = (): UserError =>
    new UserError(
      `Файл по ссылке ${origin} больше ${formatBytes(maxBytes)} — скачивание остановлено. ` +
        `Предел меняется флагом --max-mb, но и Outline принимает файлы не любого размера.`,
    );

  let res: Response;
  let finalUrl: URL;
  try {
    ({ res, url: finalUrl } = await fetchFollowingHttps(start, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)));
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`Не удалось скачать ${origin}: ${networkReason(error)}.`);
  }

  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => undefined);
    throw new UserError(`Ссылка на ${origin} истекла или уже использована — попросите новую.`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    const hint = res.status === 401 || res.status === 403 ? ": доступ по ссылке закрыт — попросите новую" : "";
    throw new UserError(`Не удалось скачать ${origin}: сервер ответил ${res.status}${hint}.`);
  }
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooBig();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError(`Не удалось дочитать файл по ссылке ${origin}: ${networkReason(error)}.`);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const name = cleanFileName(filenameFromDisposition(res.headers.get("content-disposition")) ?? fileNameFromUrl(finalUrl));
  return { bytes, name, contentType: contentTypeFor(res.headers.get("content-type"), name), origin };
}

type DownloadMeta = { name: string; contentType: string; size: number; origin: string; savedAt: number };

/** Ключ копии — хеш ссылки целиком: сама ссылка (и токен в ней) на диск не пишется. */
function downloadKey(raw: string): string {
  return new Bun.CryptoHasher("sha256").update(raw.trim()).digest("hex");
}

function isDownloadMeta(value: unknown): value is DownloadMeta {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.contentType === "string" &&
    typeof value.size === "number" &&
    typeof value.origin === "string" &&
    typeof value.savedAt === "number"
  );
}

async function prepareRemoteFile(raw: string, maxBytes: number): Promise<PreparedFile> {
  parseDownloadUrl(raw); // проверка схемы и токен — в список скрываемых, даже если копия уже есть
  const key = downloadKey(raw);
  const binPath = join(DOWNLOAD_DIR, `${key}.bin`);
  const metaPath = join(DOWNLOAD_DIR, `${key}.json`);
  const fromMeta = (meta: DownloadMeta, cached: boolean): PreparedFile => ({
    kind: "url",
    name: meta.name,
    size: meta.size,
    contentType: meta.contentType,
    path: binPath,
    origin: meta.origin,
    cached,
    cacheKey: key,
  });

  const meta: unknown = await Bun.file(metaPath)
    .json()
    .catch(() => null);
  if (isDownloadMeta(meta) && Date.now() - meta.savedAt <= DOWNLOAD_TTL_MS) {
    const copy = await stat(binPath).catch(() => null);
    if (copy?.isFile() && copy.size === meta.size) return fromMeta(meta, true);
  }

  const got = await downloadFile(raw, maxBytes);
  await mkdir(DOWNLOAD_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${binPath}.${process.pid}.tmp`;
  await writeFile(temporary, got.bytes, { mode: 0o600 });
  await rename(temporary, binPath);
  const fresh: DownloadMeta = {
    name: got.name,
    contentType: got.contentType,
    size: got.bytes.byteLength,
    origin: got.origin,
    savedAt: Date.now(),
  };
  await writeFile(metaPath, JSON.stringify(fresh), { mode: 0o600 });
  return fromMeta(fresh, false);
}

async function prepareLocalFile(path: string): Promise<PreparedFile> {
  const info = await stat(path).catch(() => null);
  if (!info) throw new UserError(`Файл не найден: ${path}`);
  if (!info.isFile()) throw new UserError(`Это не файл: ${path}`);
  const name = cleanFileName(basename(path));
  return { kind: "file", name, size: info.size, contentType: contentTypeFor(null, name), path, origin: path };
}

/** Удалить локальные копии скачанного — после записи они не нужны. */
async function dropDownloads(files: PreparedFile[]): Promise<void> {
  for (const file of files) {
    if (!file.cacheKey) continue;
    await removePath(join(DOWNLOAD_DIR, `${file.cacheKey}.bin`), { force: true }).catch(() => undefined);
    await removePath(join(DOWNLOAD_DIR, `${file.cacheKey}.json`), { force: true }).catch(() => undefined);
  }
}

/** Неподтверждённые копии старше часа удаляются при любом запуске скрипта. */
async function purgeStaleDownloads(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(DOWNLOAD_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(DOWNLOAD_DIR, name);
    const info = await stat(full).catch(() => null);
    if (info && Date.now() - info.mtimeMs > DOWNLOAD_TTL_MS) {
      await removePath(full, { force: true }).catch(() => undefined);
    }
  }
}

function attachSources(args: Args): AttachSource[] {
  const sources: AttachSource[] = [];
  for (const [name, value] of args.all) {
    if (name !== "file" && name !== "url") continue;
    if (value === true || !value.trim()) throw new UserError(`Флаг --${name} без значения.`);
    if (name === "url") parseDownloadUrl(value);
    sources.push({ kind: name, value });
  }
  if (sources.length === 0) {
    throw new UserError("Нечего прикладывать: укажите --file <путь> и/или --url <https-ссылка> (флаги повторяемы).");
  }
  if (sources.length > MAX_FILES) {
    throw new UserError(`За один раз — не больше ${MAX_FILES} файлов: Outline ограничивает частоту загрузок.`);
  }
  return sources;
}

/** Где документ и кто его увидит: коллекция из clientCollections поднимает планку проверки. */
async function documentCollection(
  rm: Resolved,
  collectionId: string | null,
): Promise<{ id: string; name: string; client: boolean; resolved: boolean } | null> {
  if (!collectionId) return null;
  let collection: Collection | undefined = (await collections(rm)).find((c) => c.id === collectionId);
  if (!collection) {
    collection = await api<Collection>(rm, "collections.info", { id: collectionId }).catch(() => undefined);
  }
  if (!collection) {
    // Название узнать не удалось: если клиентские коллекции заданы, считаем документ клиентским.
    const marks = rm.clientCollections ?? [];
    return { id: collectionId, name: collectionId, client: marks.length > 0, resolved: false };
  }
  return { id: collection.id, name: collection.name, client: isClientCollection(rm, collection), resolved: true };
}

type Exposure = { state: "none" | "public" | "unknown"; detail: string };

/**
 * Открыт ли документ публичной ссылкой — своей, на всю коллекцию или на родительский документ
 * вместе с вложенными (documentLinks). Не удалось проверить — «неизвестно», и планка строгая.
 */
async function publicExposure(rm: Resolved, doc: Doc): Promise<Exposure> {
  try {
    const links = await documentLinks(rm, doc, true);
    const open: DocumentLink | undefined = links.own?.published ? { via: "own", share: links.own } : links.inherited[0];
    if (open) return { state: "public", detail: `есть — ${linkOrigin(open)}` };
    if (links.ownHidden) {
      return { state: "unknown", detail: "проверить не удалось (черновик вне коллекции: Outline не сообщает его ссылку)" };
    }
    if (links.unchecked) return { state: "unknown", detail: `проверить не удалось (${links.unchecked})` };
    return { state: "none", detail: "нет" };
  } catch (error) {
    const reason = error instanceof ApiError ? `${error.status} ${error.code}` : networkReason(error);
    return { state: "unknown", detail: `проверить не удалось (${reason})` };
  }
}

/** Предел из текста отказа Outline: «… the maximum size is 976.56 KB». */
function outlineLimit(message: string): string | undefined {
  const match = message.match(/maximum size(?: is| of)?\s+([\d.,]+)\s*(Bytes|KB|MB|GB|TB)/i);
  if (!match) return undefined;
  const units: Record<string, string> = { bytes: "Б", kb: "КБ", mb: "МБ", gb: "ГБ", tb: "ТБ" };
  return `${(match[1] ?? "").replace(".", ",")} ${units[(match[2] ?? "").toLowerCase()] ?? match[2]}`;
}

/** Отказ Outline на attachments.create — словами: что случилось и что с этим делать. */
function attachRefusal(error: ApiError, file: PreparedFile, doc: Doc): string {
  const raw = error.serverMessage;
  if (error.status === 403 || error.code === "authorization_error") {
    if (/api key|access token/i.test(raw)) {
      return (
        "ключ API ограничен по областям доступа и не допускает загрузку вложений — " +
        "выпустите ключ без ограничений (Outline → Настройки → API)"
      );
    }
    return (
      `у вас нет права править документ «${doc.title}», а без него Outline не даёт прикладывать файлы. ` +
      `Попросите право на правку у владельца документа или коллекции`
    );
  }
  if (/too large|maximum size|larger than/i.test(raw)) {
    const limit = outlineLimit(raw);
    return `файл (${formatBytes(file.size)}) больше, чем принимает Outline${limit ? `: предел ${limit}` : ""}`;
  }
  if (error.status === 429) return "Outline ограничивает частоту загрузок — подождите минуту и повторите";
  if (error.status === 401) return "токен неверен или отозван — перевыпустите его в Outline: Настройки → API";
  if (error.status === 404) return "документ не найден: удалён или недоступен вашей учётной записи";
  return `Outline отказал (${error.status} ${error.code}${raw ? `: ${raw}` : ""})`;
}

type UploadPlan =
  | { mode: "post"; target: URL; internal: boolean; form: Record<string, string> }
  | { mode: "put"; target: URL; internal: boolean; headers: Record<string, string> };

/**
 * Куда и как грузить байты. Относительный адрес — это сам Outline (локальное хранилище,
 * /api/files.create): запрос идёт к адресу инстанса и с ключом. Внешнее хранилище (S3 и
 * совместимые) получает файл по подписанной форме: ключ Outline ему не нужен и не должен
 * уходить третьей стороне, поэтому заголовка Authorization там нет.
 */
function uploadTarget(rm: Resolved, value: string): { target: URL; internal: boolean } {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return { target: new URL(value.replace(/^\/+/, ""), rm.base), internal: true };
  }
  const target = new URL(value, rm.base);
  if (rm.base.startsWith("https:") && target.protocol !== "https:") {
    throw new UserError(
      `Outline предлагает загрузить файл в хранилище ${target.host} без шифрования (${target.protocol.replace(":", "")}) — загрузка остановлена.`,
    );
  }
  return { target, internal: false };
}

/**
 * Ответ attachments.create в 1.10.1: { mode: "post", uploadUrl, form, attachment } — форма для
 * multipart, либо { mode: "put", url, headers, attachment } — подписанный PUT (AWS_S3_UPLOAD_METHOD=put).
 * В локальном хранилище предел размера лежит в form.maxUploadSize.
 */
function uploadPlan(rm: Resolved, data: Record<string, unknown>, file: PreparedFile): UploadPlan {
  if (data.mode === "put") {
    if (typeof data.url !== "string" || !data.url) throw new UserError("Outline не выдал адрес загрузки (PUT).");
    const headers: Record<string, string> = {};
    if (isRecord(data.headers)) {
      for (const [key, value] of Object.entries(data.headers)) {
        if (typeof value === "string" || typeof value === "number") headers[key] = String(value);
      }
    }
    return { mode: "put", ...uploadTarget(rm, data.url), headers };
  }
  if (typeof data.uploadUrl !== "string" || !data.uploadUrl) throw new UserError("Outline не выдал адрес загрузки.");
  const form: Record<string, string> = {};
  if (isRecord(data.form)) {
    for (const [key, value] of Object.entries(data.form)) {
      if (value !== undefined && value !== null) form[key] = String(value);
    }
  }
  const limit = Number(form.maxUploadSize ?? data.maxUploadSize);
  if (Number.isFinite(limit) && limit > 0 && file.size > limit) {
    throw new UserError(`«${file.name}» (${formatBytes(file.size)}) больше предела Outline: ${formatBytes(limit)}.`);
  }
  return { mode: "post", ...uploadTarget(rm, data.uploadUrl), form };
}

/** Отказ хранилища — словами. Из ответа берутся только код и сообщение, а не весь текст. */
function uploadRefusal(status: number, body: string, plan: UploadPlan, file: PreparedFile): string {
  const where = plan.internal ? "Outline" : `хранилище файлов (${plan.target.host})`;
  const ending = plan.internal ? "" : "о"; // «Outline ответил», «хранилище ответило»
  let code = body.match(/<Code>([^<]{1,80})<\/Code>/)?.[1];
  let message = body.match(/<Message>([^<]{1,200})<\/Message>/)?.[1];
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      if (typeof parsed.error === "string") code ??= parsed.error;
      if (typeof parsed.message === "string") message ??= parsed.message.slice(0, 200);
    }
  } catch {
    /* не JSON */
  }
  if (status === 413 || code === "EntityTooLarge" || /too large|exceeds|larger than/i.test(message ?? "")) {
    return `${where} не принимает файл такого размера (${formatBytes(file.size)})`;
  }
  if (status === 401) return `${where} не принял${ending} авторизацию при загрузке (401)`;
  if (status === 403 && plan.internal && /api key|access token/i.test(message ?? "")) {
    return "ключ API ограничен по областям доступа и не допускает загрузку файлов — выпустите ключ без ограничений (Outline → Настройки → API)";
  }
  if (status === 403 && !plan.internal) {
    return `${where} отклонило загрузку (403${code ? ` ${code}` : ""}): подпись формы не подошла или истекла — повторите команду`;
  }
  return `${where} ответил${ending} ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`;
}

/** Имя в части multipart: кавычки и переводы строк сломали бы заголовок части. */
function multipartName(name: string): string {
  return name.replace(/["\\\r\n]/g, "_");
}

async function uploadBytes(rm: Resolved, plan: UploadPlan, file: PreparedFile): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(file.path).arrayBuffer());
  if (bytes.byteLength !== file.size) {
    throw new UserError(
      `«${file.name}» изменился после предпросмотра (${file.size} → ${bytes.byteLength} байт) — повторите команду.`,
    );
  }
  const auth: Record<string, string> = plan.internal
    ? { Authorization: `Bearer ${rm.apiKey}`, Accept: "application/json" }
    : {};

  const postForm = async (form: Record<string, string>, headers: Record<string, string>): Promise<Response> => {
    const body = new FormData();
    for (const [key, value] of Object.entries(form)) body.append(key, value);
    // Файл — последним полем: S3 не читает поля формы, пришедшие после файла.
    body.append("file", new Blob([bytes], { type: file.contentType }), multipartName(file.name));
    return fetch(plan.target, { method: "POST", headers, body, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  };

  let res: Response;
  try {
    if (plan.mode === "put") {
      // Content-Length подписан в адресе и совпадает с длиной тела — fetch выставит его сам.
      const headers = Object.fromEntries(
        Object.entries(plan.headers).filter(([key]) => key.toLowerCase() !== "content-length"),
      );
      res = await fetch(plan.target, {
        method: "PUT",
        headers: { ...headers, ...auth },
        body: bytes,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } else {
      res = await postForm(plan.form, auth);
      // Outline 1.10 подписывает форму загрузки (поле sig), и подпись сама разрешает загрузку.
      // Ключ, ограниченный по областям доступа без files.*, получает здесь 403, хотя подписи
      // хватило бы, — тогда повтор той же формы без ключа.
      if (res.status === 403 && plan.internal && plan.form.sig) {
        await res.body?.cancel().catch(() => undefined);
        res = await postForm(plan.form, { Accept: "application/json" });
      }
    }
  } catch (error) {
    const where = plan.internal ? "Outline" : `хранилище ${plan.target.host}`;
    throw new UserError(`«${file.name}»: не удалось передать файл в ${where}: ${networkReason(error)}.`);
  }

  const body = await res.text().catch(() => "");
  let refused = !res.ok;
  if (!refused && plan.internal) {
    try {
      const parsed: unknown = JSON.parse(body);
      refused = isRecord(parsed) && parsed.ok === false;
    } catch {
      /* пустой ответ или не JSON — успех определяется кодом */
    }
  }
  if (refused) throw new UserError(`«${file.name}»: ${uploadRefusal(res.status, body, plan, file)}.`);
}

/**
 * Дописать текст в конец документа, не потеряв чужую правку.
 *
 * Выбран режим append, а не чтение и запись текста целиком: при чтении-записи всё, что коллеги
 * успели изменить между нашим чтением и записью (а загрузка файлов занимает секунды), стёрлось бы
 * нашей копией текста. В режиме append сервер сам дописывает текст к своей текущей версии документа,
 * включая состояние совместного редактирования, — открытые редакторы получают правку сразу.
 *
 * Остаётся узкое окно внутри Outline: documentUpdater читает документ до блокировки строки.
 * Его закрывает lastRevision: если документ изменился после нашего чтения, сервер отвечает 409
 * и ничего не пишет — тогда перечитываем номер правки и повторяем.
 *
 * append: true дублирует editMode для версий без editMode: без него такая версия отбросила бы
 * незнакомое поле и молча заменила весь текст документа нашими ссылками.
 */
async function appendToDocument(rm: Resolved, doc: Doc, text: string): Promise<void> {
  let revision = doc.revision;
  for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt++) {
    try {
      await api<Doc>(rm, "documents.update", {
        id: doc.id,
        text,
        append: true,
        editMode: "append",
        ...(typeof revision === "number" ? { lastRevision: revision } : {}),
      });
      return;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      revision = (await loadDoc(rm, doc.id)).revision;
    }
  }
  throw new UserError(
    `документ меняется прямо сейчас: ${UPDATE_ATTEMPTS} попыток дописать подряд пришлись на чужие правки. Повторите через минуту`,
  );
}

/** Откат незавершённой записи: вложения, на которые документ не ссылается, удаляются. */
async function rollbackAttachments(rm: Resolved, ids: string[]): Promise<string> {
  if (ids.length === 0) return "Документ не изменён, в Outline ничего не загружено.";
  const left: string[] = [];
  for (const id of ids) {
    try {
      await api(rm, "attachments.delete", { id });
    } catch {
      left.push(id);
    }
  }
  return left.length === 0
    ? `Документ не изменён; уже загруженные вложения (${ids.length}) удалены.`
    : `Документ не изменён. Удалить не удалось вложения: ${left.join(", ")} — на них ничто не ссылается.`;
}

function describeFailure(error: unknown): string {
  if (error instanceof UserError || error instanceof ApiError) return error.message;
  return `сбой: ${networkReason(error)}`;
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
  const action = args.positional[0];
  if (action === "create") return cmdCollectionCreate(rm, args);
  if (action === "update" || action === "set") return cmdCollectionUpdate(rm, args);

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

/**
 * Создание и настройка коллекции.
 * permission: read — видят и читают все участники пространства, read_write — ещё и правят,
 * none — только приглашённые. sharing управляет тем, можно ли выдавать публичные ссылки.
 */
async function cmdCollectionCreate(rm: Resolved, args: Args): Promise<void> {
  const name = str(args, "name") ?? args.positional[1];
  if (!name) throw new UserError('Нужно название: collections create --name "…"');

  const permissionFlag = (str(args, "permission") ?? "read").toLowerCase();
  const permission =
    permissionFlag === "none" || permissionFlag === "private"
      ? null
      : permissionFlag === "read_write" || permissionFlag === "rw"
        ? "read_write"
        : "read";
  const sharing = !bool(args, "no-sharing");

  const body: Record<string, unknown> = { name, permission, sharing };
  const description = (await readBody(args)) ?? str(args, "description");
  if (description) body.description = description;
  const icon = str(args, "icon");
  if (icon) body.icon = icon;
  const color = str(args, "color");
  if (color) body.color = color;

  checkOutgoing({ название: name, описание: description }, args, sharing ? "client" : "internal");

  const preview =
    `НОВАЯ КОЛЛЕКЦИЯ · инстанс ${rm.name}\n` +
    table([
      ["Название", name],
      ["Иконка / цвет", `${icon ?? "—"} ${color ?? ""}`.trim()],
      [
        "Доступ",
        permission === null
          ? "только приглашённые"
          : permission === "read_write"
            ? "все сотрудники: чтение и правка"
            : "все сотрудники: чтение",
      ],
      ["Публичные ссылки", sharing ? "разрешены" : "запрещены"],
    ]) +
    (description ? `\n\nОПИСАНИЕ:\n${RULE}\n${description.trim()}\n${RULE}` : "");
  if (!requireConfirmation(args, preview)) return;

  const collection = await api<Collection>(rm, "collections.create", body);
  noCache = true; // список коллекций в кэше устарел
  emit(collection, () => `Создана коллекция: ${collection.name}\nID: ${collection.id}`);
}

async function cmdCollectionUpdate(rm: Resolved, args: Args): Promise<void> {
  const value = str(args, "collection") ?? args.positional[1];
  if (!value) throw new UserError("Укажите коллекцию: collections update <имя|id> --permission read");
  const collection = await resolveCollection(rm, value);

  const body: Record<string, unknown> = { id: collection.id };
  const permissionFlag = str(args, "permission");
  if (permissionFlag) {
    const low = permissionFlag.toLowerCase();
    body.permission = low === "none" || low === "private" ? null : low === "read_write" || low === "rw" ? "read_write" : "read";
  }
  if (args.flags.has("sharing")) body.sharing = !bool(args, "no-sharing");
  if (bool(args, "no-sharing")) body.sharing = false;
  const name = str(args, "name");
  if (name) body.name = name;
  const description = str(args, "description");
  if (description) body.description = description;
  if (Object.keys(body).length === 1) throw new UserError("Нечего менять: --permission/--sharing/--no-sharing/--name/--description.");

  const preview =
    `ИЗМЕНЕНИЕ КОЛЛЕКЦИИ «${collection.name}» · инстанс ${rm.name}\n` +
    table(Object.entries(body).filter(([k]) => k !== "id").map(([k, v]) => [k, String(v)]));
  if (!requireConfirmation(args, preview)) return;

  const updated = await api<Collection>(rm, "collections.update", body);
  noCache = true;
  emit(updated, () => `Коллекция обновлена: ${updated.name}`);
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

  // Планка — по коллекции: клиентские коллекции проверяются строго, внутренние — мягче.
  checkOutgoing({ название: title, текст: text }, args, await audienceFor(rm, collection.id));

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

  checkOutgoing({ название: title, текст: text }, args, await audienceFor(rm, current.collectionId));

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

  // Публикация делает документ видимым команде: планка зависит от того, клиентская ли коллекция.
  checkOutgoing({ название: doc.title, текст: doc.text }, args, await audienceFor(rm, doc.collectionId));

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

/**
 * Выдать публичную ссылку. Открывает она ровно то, что показал предпросмотр: без --children — только
 * сам документ, с --children — и все вложенные. После записи ссылка перечитывается и сверяется
 * с запрошенным: вложенные, открытые вопреки просьбе, — утечка наружу, о ней сказано прямо, код 1.
 */
async function cmdShare(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) throw new UserError("Укажите документ: outline.ts share <id|url>");
  const doc = await loadDoc(rm, value);
  const withChildren = bool(args, "children");

  // Ссылка делает документ доступным всем, у кого она есть, — это публикация наружу.
  checkOutgoing({ название: doc.title, текст: doc.text }, args, "client");

  // Второй ссылки на документ shares.create не выдаёт: свою, не отозванную, он возвращает как есть,
  // и запись меняет её. Поэтому предпросмотр говорит, что в ней сейчас и что поменяется.
  let links: DocumentLinks | null = null;
  let linksError = "";
  try {
    links = await documentLinks(rm, doc);
  } catch (error) {
    linksError = error instanceof ApiError ? `${error.status} ${error.code}` : networkReason(error);
  }
  const existing = links?.own ?? null;
  const opens = (children: boolean): string => (children ? "документ и все вложенные" : "только сам документ");

  const warnings: string[] = [];
  if (!doc.publishedAt) warnings.push("документ ещё черновик — по ссылке он будет доступен как есть");
  if (doc.archivedAt) warnings.push("документ в архиве");
  if (existing?.published && existing.includeChildDocuments === true && !withChildren) {
    warnings.push("сейчас по ссылке открыты и вложенные документы — после записи они закроются, останется только сам документ");
  }
  if (existing?.published && existing.includeChildDocuments !== true && withChildren) {
    warnings.push("сейчас по ссылке открыт только сам документ — после записи откроются и все вложенные");
  }
  if (existing && !existing.published) {
    warnings.push(
      `ссылка ${existing.url} снята с публикации — после записи этот адрес снова откроется, ` +
        "в том числе у тех, кому его давали раньше",
    );
  }
  if (withChildren) {
    warnings.push("текст вложенных документов в предпросмотр не входит и не проверялся — прочитайте их до выдачи");
  }
  for (const link of links?.inherited ?? []) warnings.push(`документ уже открыт без входа: ${linkOrigin(link)} — ${link.share.url}`);
  if (links?.ownHidden) {
    warnings.push(
      "есть ли у черновика вне коллекции своя ссылка, Outline не сообщает; если есть — запись снова откроет её прежний адрес",
    );
  }
  if (linksError) warnings.push(`есть ли у документа ссылка, проверить не удалось (${linksError})`);

  const preview =
    `ПУБЛИЧНАЯ ССЫЛКА · инстанс ${rm.name}\n` +
    table([
      ["Документ", doc.title],
      ["Адрес внутри", docUrl(rm, doc)],
      [
        "Ссылка",
        !existing
          ? "будет выдана новая"
          : `уже есть: ${existing.url} — ` +
            (existing.published ? `открывает ${opens(existing.includeChildDocuments === true)}` : "снята с публикации"),
      ],
      ["Вложенные документы", withChildren ? "включены в ссылку" : "не включены"],
      ["Кто увидит", "любой, у кого есть ссылка, без входа в Outline"],
    ]) +
    (warnings.length ? `\n\nВнимание:\n${warnings.map((w) => `  — ${w}`).join("\n")}` : "") +
    `\n\nТЕКСТ, КОТОРЫЙ УВИДИТ ПОЛУЧАТЕЛЬ:\n${RULE}\n${clip(doc.text, 2000)}\n${RULE}`;
  if (!requireConfirmation(args, preview)) return;

  const share = await api<Share>(rm, "shares.create", {
    documentId: doc.id,
    includeChildDocuments: withChildren,
  });
  // Публичной ссылку делает published. Outline 1.10.1 (server/routes/api/shares/shares.ts,
  // обработчик shares.update) при published: true сам ставит includeChildDocuments = true и только
  // потом применяет includeChildDocuments из запроса. Поэтому флаг идёт явно и в том же запросе:
  // без него ссылка, выданная без --children, открыла бы и все вложенные документы.
  const published = await api<Share>(rm, "shares.update", {
    id: share.id,
    published: true,
    includeChildDocuments: withChildren,
  });

  // Сверка: ссылка перечитывается — по документу (там она в любом состоянии), а у черновика вне
  // коллекции — по её id — и то, что она открывает, сравнивается с запрошенным.
  let reread: Share | null = null;
  let rereadError = "";
  try {
    reread =
      (await sharesInfo(rm, { documentId: doc.id })).find((s) => s.id === published.id) ??
      (await sharesInfo(rm, { id: published.id }))[0] ??
      null;
  } catch (error) {
    rereadError = error instanceof ApiError ? `${error.status} ${error.code}` : networkReason(error);
  }
  const result = { ...(reread ?? published), requested: { includeChildDocuments: withChildren }, verified: false };
  if (!reread || typeof reread.includeChildDocuments !== "boolean") {
    process.exitCode = 1;
    const why = !reread
      ? `перечитать её не удалось${rereadError ? ` (${rereadError})` : ""}`
      : "Outline не сообщил, открывает ли она вложенные документы";
    emit(result, () =>
      `Ссылка выдана: ${published.url}, но сверить её не удалось: ${why}.\n` +
        `Проверьте, что она открывает: outline.ts shares --document ${doc.id}`,
    );
    return;
  }
  const mismatch: string[] = [];
  if (reread.published !== true) {
    mismatch.push(
      `РАСХОЖДЕНИЕ: после записи ссылка ${reread.url} не опубликована — без входа она не откроется. ` +
        `Повторите: outline.ts share ${doc.id}${withChildren ? " --children" : ""}`,
    );
  }
  if (reread.includeChildDocuments && !withChildren) {
    mismatch.push(
      `РАСХОЖДЕНИЕ: просили открыть только документ «${doc.title}», а ссылка ${reread.url} открывает и все ` +
        `вложенные документы — без входа, любому, у кого она есть.`,
      `Закрыть утечку сейчас — отозвать ссылку: outline.ts unshare ${reread.id} (предпросмотр, затем --yes). ` +
        `Вложенные можно выключить и в настройках этой ссылки в самом Outline.`,
    );
  }
  if (!reread.includeChildDocuments && withChildren) {
    mismatch.push(
      `РАСХОЖДЕНИЕ: просили открыть документ «${doc.title}» вместе с вложенными, а ссылка ${reread.url} ` +
        `открывает только сам документ. Вложенные получателю не откроются; если они нужны — повторите: ` +
        `outline.ts share ${doc.id} --children`,
    );
  }
  if (mismatch.length > 0) {
    process.exitCode = 1;
    emit(result, () => mismatch.join("\n"));
    return;
  }
  result.verified = true;
  emit(result, () =>
    [
      `Ссылка выдана: ${reread.url}`,
      `Документ: ${doc.title}`,
      `Открывает: ${opens(withChildren)}`,
      "Сверка: ссылка перечитана — открывает ровно то, что в предпросмотре.",
      `Отозвать: outline.ts unshare ${reread.id}`,
    ].join("\n"),
  );
}

/** Что открывает ссылка — для таблицы: документ по названию или всю коллекцию. */
function shareSubject(share: Share): string {
  if (share.collectionId) return `коллекция${quotedTitle(share)}`;
  return share.sourceTitle ?? share.documentTitle ?? share.documentId ?? "—";
}

async function cmdShares(rm: Resolved, args: Args): Promise<void> {
  const documentValue = str(args, "document") ?? args.positional[0];
  if (documentValue) return cmdDocumentShares(rm, documentValue);

  const list = await apiAll<Share>(rm, "shares.list", {}, num(args, "limit") ?? 100);
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
            clip(shareSubject(s), 30),
            s.url,
          ]),
        ]),
  );
}

/**
 * Все ссылки одного документа: своя и унаследованные — на всю коллекцию и на предков вместе
 * с вложенными. По документу отзывается только своя; унаследованная — отдельно, по её адресу.
 */
async function cmdDocumentShares(rm: Resolved, value: string): Promise<void> {
  const doc = await loadDoc(rm, value);
  const links = await documentLinks(rm, doc);
  const all: DocumentLink[] = links.own ? [{ via: "own", share: links.own }, ...links.inherited] : links.inherited;
  const whose = (link: DocumentLink): string =>
    link.via === "own" ? "своя" : `${link.via === "collection" ? "коллекции" : "родителя"}${quotedTitle(link.share)}`;
  emit(
    {
      document: { id: doc.id, title: doc.title, url: docUrl(rm, doc) },
      shares: all.map((link) => ({ via: link.via, ...link.share })),
      ownHidden: links.ownHidden ?? false,
      unchecked: links.unchecked ?? null,
    },
    () => {
      const parts = [`ССЫЛКИ ДОКУМЕНТА «${doc.title || "(без названия)"}» · инстанс ${rm.name}\n${docUrl(rm, doc)}`];
      if (all.length === 0 && !links.ownHidden) {
        parts.push(
          links.unchecked
            ? "Своей публичной ссылки нет."
            : "Публичной ссылки нет: ни своей, ни на всю коллекцию, ни на родительский документ.",
        );
      } else if (all.length > 0) {
        parts.push(
          table([
            ["ID ССЫЛКИ", "ЧЬЯ", "ПУБЛИЧНА", "ПРОСМОТРОВ", "ПОСЛЕДНИЙ", "URL"],
            ...all.map((link) => [
              link.share.id.slice(0, 8),
              clip(whose(link), 40),
              link.share.published ? "да" : "нет",
              String(link.share.views ?? 0),
              (link.share.lastAccessedAt ?? "—").slice(0, 10),
              link.share.url,
            ]),
          ]),
        );
      }
      if (links.ownHidden) {
        parts.push(
          "Своя ссылка не видна: документ — черновик вне коллекции, и Outline не сообщает его ссылку по документу. " +
            "Если она выдавалась, её отзывают по адресу: outline.ts unshare <адрес ссылки>.",
        );
      }
      if (links.inherited.length > 0) {
        parts.push(
          "Ссылка коллекции или родителя открывает и другие документы, поэтому unshare по этому документу " +
            "её не трогает: она отзывается отдельно, по своему адресу — outline.ts unshare <адрес ссылки>.",
        );
      }
      if (links.unchecked) parts.push(`Ссылки коллекции и родительских документов проверены не до конца: ${links.unchecked}.`);
      return parts.join("\n\n");
    },
  );
}

type UnshareTarget = { kind: "share"; share: Share } | { kind: "document"; doc: Doc };

/**
 * Опубликованная ссылка по id или по слагу из адреса …/s/… (shares.info { id }); null — такой нет:
 * отозвана, снята с публикации или выдана в другом пространстве.
 */
async function findShare(rm: Resolved, ref: string): Promise<Share | null> {
  try {
    return (await sharesInfo(rm, { id: ref }))[0] ?? null;
  } catch (error) {
    // 403 на ссылку по id: она есть, но обмен ссылками выключен в её коллекции или во всём пространстве.
    if (error instanceof ApiError && error.status === 403) {
      throw new UserError(
        `Ссылка ${ref} сейчас не открывается: публичные ссылки запрещены в её коллекции или во всём пространстве. ` +
          `Убрать её совсем можно по документу: outline.ts unshare <документ>.`,
      );
    }
    throw error;
  }
}

/**
 * Что отзывать: ссылку (id, адрес …/s/…) или документ (id, urlId, адрес …/doc/… — в том числе документ
 * внутри чужой ссылки …/s/…/doc/…). Голый uuid бывает и у ссылки, и у документа: сначала он ищется
 * как ссылка — её id печатает share, — потом как документ.
 */
async function unshareTarget(rm: Resolved, value: string): Promise<UnshareTarget> {
  const trimmed = value.trim();
  const docInUrl = trimmed.match(/\/doc\/([^/?#]+)/i)?.[1];
  if (docInUrl) return { kind: "document", doc: await loadDoc(rm, docInUrl) };
  // Снятую с публикации ссылку shares.info { id } не отдаёт: её находят только по документу.
  const unpublishedHint = "Снятую с публикации ссылку отзывают по документу: outline.ts unshare <документ>.";
  const shareInUrl = trimmed.match(/\/s\/([^/?#]+)/i)?.[1];
  if (shareInUrl) {
    const share = await findShare(rm, shareInUrl);
    if (!share) {
      throw new UserError(
        `Публичной ссылки ${shareInUrl} нет: она уже отозвана, снята с публикации или выдана в другом пространстве. ` +
          unpublishedHint,
      );
    }
    return { kind: "share", share };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    throw new UserError(
      "Адрес не распознан: нужна ссылка …/s/<ссылка>, адрес документа …/doc/<документ> или id. " +
        "Ссылку на собственном домене отзывайте по документу: outline.ts unshare <документ>.",
    );
  }
  if (!UUID_RE.test(trimmed)) return { kind: "document", doc: await loadDoc(rm, trimmed) };
  const share = await findShare(rm, trimmed);
  if (share) return { kind: "share", share };
  try {
    return { kind: "document", doc: await loadDoc(rm, trimmed) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new UserError(`Ни публичной ссылки, ни документа с id ${trimmed} нет. ${unpublishedHint}`);
    }
    throw error;
  }
}

/**
 * Отозвать публичную ссылку. Названная ссылка (id, адрес …/s/…) отзывается сама. По документу
 * отзывается только его собственная: ссылка на коллекцию или на родителя вместе с вложенными
 * открывает и другие документы, поэтому скилл называет её и говорит, где отзывать, но не трогает.
 * Ссылок нет — так и сказано, а shares.revoke не отправляется.
 */
async function cmdUnshare(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) throw new UserError("Укажите документ или ссылку: outline.ts unshare <docId|shareId|url> [--yes]");
  const target = await unshareTarget(rm, value);
  if (target.kind === "share") return revokeShare(rm, args, target.share, null);

  const { doc } = target;
  const links = await documentLinks(rm, doc);
  if (links.own) return revokeShare(rm, args, links.own, { doc, links });

  const title = doc.title || "(без названия)";
  const result = {
    revoked: null,
    document: { id: doc.id, title: doc.title, url: docUrl(rm, doc) },
    inherited: links.inherited.map((link) => ({ via: link.via, id: link.share.id, url: link.share.url })),
    ownHidden: links.ownHidden ?? false,
    unchecked: links.unchecked ?? null,
  };
  if (links.ownHidden) {
    // Своя ссылка, может быть, есть, но Outline её по документу не отдаёт: «нет» было бы неправдой.
    process.exitCode = 1;
    emit(result, () =>
      `Документ «${title}» — черновик вне коллекции: его собственную ссылку Outline по документу не сообщает, ` +
        `поэтому скилл не может ни отозвать её отсюда, ни сказать, что её нет.\n` +
        `Если ссылка выдавалась, отзовите её по адресу: outline.ts unshare <адрес …/s/…>.`,
    );
    return;
  }
  if (links.inherited.length > 0) {
    // Документ по-прежнему открыт, а отзывать по нему нечего: просьба не выполнена — код возврата 1.
    process.exitCode = 1;
    emit(result, () =>
      [
        `У документа «${title}» нет своей публичной ссылки — отзывать по нему нечего. Но без входа в Outline он открыт:`,
        ...links.inherited.map((link) => `  — ${linkOrigin(link)}: ${link.share.url}`),
        "Такая ссылка открывает не только этот документ, поэтому скилл её сам не отзывает.",
        "Чтобы закрыть доступ, отзовите её саму — предпросмотр покажет, что ещё закроется:",
        ...links.inherited.map((link) => `  outline.ts unshare ${link.share.id}`),
      ].join("\n"),
    );
    return;
  }
  if (links.unchecked) {
    process.exitCode = 1;
    emit(result, () =>
      `У документа «${title}» нет своей публичной ссылки. Открыт ли он ссылкой на коллекцию ` +
        `или на родительский документ, проверить не удалось (${links.unchecked}).`,
    );
    return;
  }
  emit(result, () =>
    `Публичной ссылки нет: у документа «${title}» нет своей, и он не открыт ни ссылкой на всю коллекцию, ` +
      `ни ссылкой на родительский документ. Отзывать нечего.`,
  );
}

/**
 * Предпросмотр и отзыв одной ссылки — протоколом --yes, как любая запись. found — документ, по которому
 * ссылку нашли, и прочие его ссылки: о тех, что оставят его открытым и после отзыва, сказано прямо.
 */
async function revokeShare(
  rm: Resolved,
  args: Args,
  share: Share,
  found: { doc: Doc; links: DocumentLinks } | null,
): Promise<void> {
  // shares.revoke принимает только uuid ссылки: без него Outline отказывает, а слаг из адреса — не id.
  if (!UUID_RE.test(share.id)) throw new UserError("Outline не назвал id ссылки — отзыв не отправлен.");
  const remaining = found?.links.inherited ?? [];

  const warnings: string[] = [];
  if (share.collectionId) warnings.push("это ссылка на всю коллекцию: после отзыва без входа не откроется ни один её документ");
  if (!share.published) warnings.push("ссылка снята с публикации и сейчас не открывается; отзыв удалит её совсем");
  for (const link of remaining) {
    warnings.push(
      `документ останется открыт: ${linkOrigin(link)} — ${link.share.url}. ` +
        `Она открывает и другие документы и отзывается отдельно: outline.ts unshare ${link.share.id}`,
    );
  }
  if (found?.links.unchecked) {
    warnings.push(`открыт ли документ ещё ссылкой коллекции или родителя, проверить не удалось (${found.links.unchecked})`);
  }

  const preview =
    `ОТЗЫВ ПУБЛИЧНОЙ ССЫЛКИ · инстанс ${rm.name}\n` +
    table([
      ["Ссылка", share.url],
      [
        "Открывает",
        share.collectionId
          ? `всю коллекцию${quotedTitle(share)}`
          : `документ${quotedTitle(share)}${share.includeChildDocuments ? " вместе с вложенными" : ""}`,
      ],
      ["Состояние", share.published ? "опубликована: открывается без входа в Outline" : "снята с публикации"],
      ["Просмотров", String(share.views ?? 0)],
      ["Выдана", [share.createdAt?.slice(0, 10), share.createdBy?.name].filter(Boolean).join(", ") || "—"],
    ]) +
    (warnings.length ? `\n\nВнимание:\n${warnings.map((w) => `  — ${w}`).join("\n")}` : "") +
    `\n\nОтзыв необратим: ${share.published ? "адрес перестанет открываться сразу, " : ""}` +
    "вернуть его нельзя — только выдать новую ссылку.";
  if (!requireConfirmation(args, preview)) return;

  try {
    await api(rm, "shares.revoke", { id: share.id });
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      const who = share.createdBy?.name ? ` (${share.createdBy.name})` : "";
      throw new UserError(`Outline не дал отозвать ссылку: отзывает тот, кто её выдал${who}, или администратор пространства.`);
    }
    throw error;
  }
  emit(
    {
      revoked: share.id,
      url: share.url,
      document: found ? { id: found.doc.id, title: found.doc.title, url: docUrl(rm, found.doc) } : null,
      stillOpen: remaining.map((link) => ({ via: link.via, id: link.share.id, url: link.share.url })),
    },
    () =>
      [
        `Ссылка отозвана: ${share.url} больше не открывается.`,
        ...remaining.map((link) => `Документ по-прежнему открыт: ${linkOrigin(link)} — ${link.share.url}.`),
      ].join("\n"),
  );
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
  // Порядок внутри родителя: Outline ожидает числовую позицию, а не строковый ключ.
  const index = num(args, "index");
  if (index !== undefined) body.index = index;
  if (!collection && !parent && !index) throw new UserError("Задайте --collection, --parent и/или --index.");

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

/**
 * Приложить файлы к документу от имени и с правами самого человека — его ключом из конфига.
 * Байты загружаются в Outline (attachments.create + загрузка в хранилище), в конец документа
 * дописываются строка комментария и ссылки на файлы; остальной текст не трогается.
 */
async function cmdAttach(rm: Resolved, args: Args): Promise<void> {
  const value = args.positional[0] ?? str(args, "id");
  if (!value) {
    throw new UserError(
      'Укажите документ: outline.ts attach <id|url> (--file <путь> | --url <https-ссылка>)… [--comment "…"]',
    );
  }
  const sources = attachSources(args);
  const commentFlag = args.flags.get("comment");
  if (commentFlag === true) throw new UserError('--comment без текста: --comment "…"');
  const comment = commentFlag?.trim() || undefined;
  // Одноразовая ссылка в тексте документа раздала бы её токен всем читателям. Сверяются длинные
  // строки — ссылка, строка запроса, токен, — чтобы короткое значение вроде lang=ru не мешало.
  if (comment && [...SECRET_STRINGS].some((secret) => secret.length >= 12 && comment.includes(secret))) {
    throw new UserError(
      "В комментарии — ссылка из --url: она одноразовая и с токеном, в документ её вставлять нельзя. " +
        "Уберите её из комментария: файл и так будет приложен.",
    );
  }
  const maxMb = num(args, "max-mb") ?? DEFAULT_MAX_MB;
  if (maxMb <= 0) throw new UserError("--max-mb ожидает число мегабайт больше нуля.");

  const doc = await loadDoc(rm, value);
  if (doc.deletedAt) throw new UserError(`Документ «${doc.title}» в корзине — сначала восстановите его.`);

  // Кто увидит вложения: клиентская коллекция и публичная ссылка поднимают планку проверки.
  // Не удалось проверить ссылку — считаем, что она есть: ошибиться в строгую сторону дешевле.
  const collection = await documentCollection(rm, doc.collectionId);
  const exposure = await publicExposure(rm, doc);
  const audience: Audience = collection?.client || exposure.state !== "none" ? "client" : "internal";

  // Ссылки скачиваются уже при предпросмотре: они одноразовые, а без имени и размера не показать
  // текст, который уйдёт в документ, и не проверить его.
  const maxBytes = Math.floor(maxMb * 1024 * 1024);
  const files: PreparedFile[] = [];
  for (const source of sources) {
    files.push(
      source.kind === "file" ? await prepareLocalFile(source.value) : await prepareRemoteFile(source.value, maxBytes),
    );
  }

  // Проверяется всё, что станет текстом документа: комментарий и имена файлов.
  const fields: Record<string, string | undefined> = { комментарий: comment };
  files.forEach((file, index) => {
    fields[`имя файла ${index + 1}`] = file.name;
  });
  checkOutgoing(fields, args, audience);

  const warnings: string[] = [];
  if (collection?.client) {
    warnings.push(
      collection.resolved
        ? `документ в клиентской коллекции «${collection.name}»: файлы увидят клиенты`
        : "коллекцию документа определить не удалось — проверка по клиентской планке",
    );
  }
  if (exposure.state === "public") {
    warnings.push("документ открыт публичной ссылкой: файлы будут доступны любому, у кого она есть, без входа в Outline");
  }
  if (exposure.state === "unknown") {
    warnings.push(`открыт ли документ публичной ссылкой, ${exposure.detail} — проверка по клиентской планке`);
  }
  if (audience === "client") {
    warnings.push(
      "комментарий и имена файлов проверены по клиентской планке; содержимое файлов скилл не проверяет — " +
        "убедитесь, что его можно показывать",
    );
  }
  if (doc.archivedAt) warnings.push("документ в архиве");

  const total = files.reduce((sum, file) => sum + file.size, 0);
  const preview =
    `ВЛОЖЕНИЯ В ДОКУМЕНТ · инстанс ${rm.name}\n${docUrl(rm, doc)}\n` +
    table([
      ["Документ", doc.title || "(без названия)"],
      ["Коллекция", collection ? `${collection.name}${collection.client ? " (клиентская)" : ""}` : "— (вне коллекции)"],
      ["Состояние", `${doc.publishedAt ? "опубликован" : "черновик"}${doc.archivedAt ? ", в архиве" : ""}`],
      ["Публичная ссылка", exposure.detail],
      ["Планка проверки", audience === "client" ? "клиентская" : "внутренняя"],
      ["Файлов", `${files.length}, всего ${formatBytes(total)}`],
      ["Кто пишет", "вы, своим ключом: право на правку Outline проверит сам"],
    ]) +
    (warnings.length ? `\n\nВнимание:\n${warnings.map((w) => `  — ${w}`).join("\n")}` : "") +
    `\n\nФАЙЛЫ:\n` +
    table(
      files.map((file, index) => [
        `${index + 1}.`,
        file.name,
        formatBytes(file.size),
        file.contentType,
        isInlineImage(file.contentType) ? "картинкой" : "вложением",
        file.kind === "file"
          ? `с диска: ${file.origin}`
          : `по ссылке: ${file.origin} (${file.cached ? "скачан ранее" : "скачан"}, ждёт подтверждения)`,
      ]),
    ) +
    `\n\nДОПИСЫВАЕТСЯ В КОНЕЦ ДОКУМЕНТА:\n${RULE}\n` +
    appendixMarkdown(
      comment,
      files.map((file) => ({ ...file, url: "/api/attachments.redirect?id=…" })),
    ).trim() +
    `\n${RULE}\nОстальной текст документа не меняется. Адреса вложений Outline выдаст при записи.` +
    (files.some((file) => file.kind === "url")
      ? "\nСкачанное лежит локально до записи (не дольше часа): второй раз по ссылке скилл не пойдёт."
      : "");
  if (!requireConfirmation(args, preview)) return;

  // ── запись: вложения → текст документа → сверка ──
  const created: string[] = [];
  const attached: { file: PreparedFile; id: string; url: string }[] = [];
  try {
    for (const file of files) {
      let data: unknown;
      try {
        data = await api<unknown>(rm, "attachments.create", {
          name: file.name,
          documentId: doc.id,
          contentType: file.contentType,
          size: file.size,
          preset: "documentAttachment",
        });
      } catch (error) {
        if (error instanceof ApiError) throw new UserError(`«${file.name}»: ${attachRefusal(error, file, doc)}.`);
        throw error;
      }
      const attachment = isRecord(data) && isRecord(data.attachment) ? data.attachment : null;
      const id = typeof attachment?.id === "string" && UUID_RE.test(attachment.id) ? attachment.id : null;
      if (!isRecord(data) || !id) {
        throw new UserError(`«${file.name}»: Outline ответил на attachments.create без идентификатора вложения.`);
      }
      created.push(id);
      await uploadBytes(rm, uploadPlan(rm, data, file), file);
      // Ссылка — через attachments.redirect, как у самого Outline: по ней правило разметки узнаёт вложение.
      attached.push({ file, id, url: `/api/attachments.redirect?id=${id}` });
    }
  } catch (error) {
    const cleanup = await rollbackAttachments(rm, created);
    throw new UserError(`Файлы не приложены: ${describeFailure(error)}\n${cleanup}`);
  }

  const appendix = appendixMarkdown(
    comment,
    attached.map((item) => ({ ...item.file, url: item.url })),
  );
  try {
    await appendToDocument(rm, doc, appendix);
  } catch (error) {
    // Ответ мог потеряться уже после записи: удалять вложения можно, только убедившись,
    // что документ на них не ссылается.
    const now = await loadDoc(rm, doc.id).catch(() => null);
    if (!now || !attached.every((item) => now.text.includes(item.id))) {
      const cleanup = now
        ? await rollbackAttachments(rm, created)
        : `Документ перечитать не удалось, поэтому вложения не удалялись: ${created.join(", ")}.`;
      throw new UserError(`Ссылки в документ не дописаны: ${describeFailure(error)}\n${cleanup}`);
    }
  }

  // Запись прошла: локальные копии скачанного больше не нужны, а повтор команды загрузил бы файлы
  // второй раз — поэтому они удаляются до сверки, что бы она ни показала.
  await dropDownloads(files);

  const result = {
    document: { id: doc.id, title: doc.title, url: docUrl(rm, doc) },
    attachments: attached.map((item) => ({
      id: item.id,
      name: item.file.name,
      size: item.file.size,
      contentType: item.file.contentType,
      inline: isInlineImage(item.file.contentType),
      url: item.url,
    })),
    verified: false,
  };

  // Сверка после записи: документ перечитывается, и в нём ищется каждое вложение.
  let check: Doc;
  try {
    check = await loadDoc(rm, doc.id);
  } catch (error) {
    process.exitCode = 1;
    emit(result, () =>
      `Файлы приложены к «${doc.title}», но перечитать документ для сверки не удалось: ${describeFailure(error)}\n` +
        `Проверьте документ сами, команду не повторяйте — файлы загрузились бы второй раз: ${docUrl(rm, doc)}`,
    );
    return;
  }
  const missing = attached.filter((item) => !check.text.includes(item.id));
  result.verified = missing.length === 0;
  if (missing.length > 0) {
    process.exitCode = 1;
    emit({ ...result, missing: missing.map((item) => item.id), appendix }, () =>
      `Файлы загружены, но при сверке в документе «${doc.title}» нет ссылок на: ` +
        `${missing.map((item) => item.file.name).join(", ")}.\n` +
        `Допишите в конец документа вручную:\n${RULE}\n${appendix.trim()}\n${RULE}`,
    );
    return;
  }
  emit(result, () =>
    [
      `Приложено к «${doc.title}» · инстанс ${rm.name}`,
      docUrl(rm, doc),
      ...attached.map(
        (item, index) =>
          `  ${index + 1}. ${item.file.name} — ${formatBytes(item.file.size)}, ` +
          `${isInlineImage(item.file.contentType) ? "картинкой" : "вложением"}`,
      ),
      `Сверка: документ перечитан, ссылки на все вложения (${attached.length}) на месте.`,
    ].join("\n"),
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

ЗАПИСЬ ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ: create, update, publish, share, unshare, move, archive, delete, attach
без --yes печатают полный предпросмотр и ничего не меняют. Текст документа проверяется
на компрометацию: черновик — по внутренней планке, публикация и ссылка — по клиентской.

Навигация
  instances                         профили из конфига
  whoami                            кто я и в каком пространстве
  collections [строка]              коллекции
  collections create --name "…" [--permission read|read_write|none] [--no-sharing]
                                   [--icon имя] [--color #RRGGBB] [--description "…"] [--yes]
  collections update <имя|id> [--permission …] [--no-sharing] [--name "…"] [--yes]
  tree [--collection X]             структура коллекции
  docs [--collection X] [--mine] [--limit N]
  search "фраза" [--collection X] [--limit N]
  doc <id|url> [--full] [--meta] [--out файл.md]

Документы
  create --title "…" (--file f | --text "…" | --stdin) [--collection X] [--parent <id>] [--publish] [--yes]
  update <id|url> [--title "…"] [--file f|--text "…"] [--append] [--publish] [--yes]
  publish <id|url> [--yes]          черновик → опубликован
  move <id> [--collection X] [--parent <id>] [--index <номер>] [--yes]
  archive <id> [--yes] | delete <id> [--permanent] --yes
  export <id> --out файл.md

Вложения — вашим ключом и от вашего имени
  attach <id|url> (--file путь | --url https-ссылка)… [--comment "…"] [--max-mb N] [--yes]
                                    загрузить файлы и дописать ссылки на них в конец документа;
                                    --file и --url повторяемы, ссылка печатается только хостом и путём

Ссылки для клиентов
  share <id|url> [--children] [--yes]   выдать публичную ссылку: без --children — только сам документ,
                                        с --children — и все вложенные; после записи сверяется
  shares [--document <id|url>]          что выдано: просмотры и последнее обращение; по документу —
                                        своя ссылка и унаследованные (на коллекцию, на родителя)
  unshare <docId|shareId|url> [--yes]   отозвать ссылку; по документу — только его собственную,
                                        унаследованную называет, но не трогает

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
  await purgeStaleDownloads();

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
    attach: cmdAttach,
  };
  const handler = handlers[args.cmd];
  if (!handler) throw new UserError(`Неизвестная команда "${args.cmd}". Список команд: outline.ts help`);
  await handler(rm, args);
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    // redact — последний рубеж: ссылки --url с токеном не печатаются даже в чужом тексте ошибки.
    if (error instanceof UserError) console.error(redact(`Ошибка: ${error.message}`));
    else if (error instanceof ApiError) console.error(redact(`Outline API: ${error.message}`));
    else console.error(redact(`Сбой: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
  }
}

// Импорт модуля (тесты) не должен запускать CLI.
if (import.meta.main) await run();

export {
  documentRef,
  clip,
  filenameFromDisposition,
  fileNameFromUrl,
  cleanFileName,
  contentTypeFor,
  attachmentTitle,
  appendixMarkdown,
  safeUrl,
  formatBytes,
  outlineLimit,
  isInlineImage,
};
