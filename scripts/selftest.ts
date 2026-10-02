#!/usr/bin/env bun
/**
 * Самопроверка скилла без обращения к настоящему Outline: разбор ссылок, правила проверки текстов
 * и команда attach — против поддельного Outline и поддельной раздачи файлов на этой же машине.
 * Запуск: bun scripts/selftest.ts — код возврата 1, если хоть один случай не прошёл.
 * Нужен openssl: раздача файлов работает только по https, и для неё выпускается одноразовый сертификат.
 */

import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
} from "./outline.ts";
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
  ["пароль в таблице", ["| Логин | Пароль |", "| --- | --- |", "| SalesAssistant | fsWVnzC13IQN2Uk |"].join("\n")],
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
  ["таблица размеров изображений", ["| Файл | Размер |", "| --- | --- |", "| Экран входа | 2947x1236 |"].join("\n")],
  ["таблица с датами", ["| Документ | Дата |", "| --- | --- |", "| Регламент | 03.10.2025 |"].join("\n")],
  [
    "пароль без значения",
    ["| Логин | Пароль |", "| --- | --- |", "| SalesAssistant | выдаётся администратором |"].join("\n"),
  ],
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

// ── вложения: имя, тип, подпись, разметка ─────────────────────────────
/** Имя в UTF-8, прочитанное как latin1, — так заголовок с «сырым» UTF-8 видит клиент HTTP. */
const asLatin1 = (text: string): string => String.fromCharCode(...new TextEncoder().encode(text));

check(
  "имя: filename* главнее filename",
  filenameFromDisposition(`attachment; filename="fallback.png"; filename*=UTF-8''%D0%A1%D1%85%D0%B5%D0%BC%D0%B0.png`),
  "Схема.png",
);
check("имя: filename* в другом регистре", filenameFromDisposition(`attachment; FILENAME*=utf-8''report%20v2.pdf`), "report v2.pdf");
check("имя: filename* в latin1", filenameFromDisposition(`attachment; filename*=ISO-8859-1''caf%E9.txt`), "café.txt");
check(
  "имя: битый filename* — берётся filename",
  filenameFromDisposition(`attachment; filename*=UTF-8''%FF%FE.txt; filename="ok.txt"`),
  "ok.txt",
);
check("имя: кавычка внутри filename", filenameFromDisposition(`attachment; filename="a \\"b\\".txt"`), 'a "b".txt');
check("имя: точка с запятой внутри кавычек", filenameFromDisposition(`attachment; filename="a;b.txt"`), "a;b.txt");
check(
  "имя: UTF-8, прочитанный как latin1, восстанавливается",
  filenameFromDisposition(`attachment; filename="${asLatin1("отчёт.pdf")}"`),
  "отчёт.pdf",
);
check("имя: без заголовка", filenameFromDisposition(null) ?? "нет", "нет");
check(
  "имя из пути ссылки",
  fileNameFromUrl(new URL("https://files.example.com/files/a/%D0%A1%D1%87%D1%91%D1%82.pdf?link=x")),
  "Счёт.pdf",
);
check("имя: каталоги отбрасываются", cleanFileName("../../etc/passwd"), "passwd");
check("имя: обратная косая — тоже каталог", cleanFileName("C:\\Users\\someone\\file.txt"), "file.txt");
check("имя: управляющие символы", cleanFileName("a\nb\tc.txt"), "a b c.txt");
check("имя: пустое", cleanFileName("  "), "file");
check(
  "ссылка: показываются только хост и путь",
  safeUrl(new URL("https://user:pw@files.example.com:8443/files/a/b.png?link=SECRET#frag")),
  "files.example.com:8443/files/a/b.png",
);
check("тип: octet-stream уточняется по имени", contentTypeFor("application/octet-stream", "схема.png"), "image/png");
check("тип: заявленный сервером главнее", contentTypeFor("Text/Plain; charset=utf-8", "x.png"), "text/plain");
check("тип: без заголовка и расширения", contentTypeFor(null, "README"), "application/octet-stream");
check("картинкой: png", isInlineImage("image/png"), true);
check("картинкой: tiff — нет, вложением", isInlineImage("image/tiff"), false);
check("подпись: обычное имя не меняется", attachmentTitle("IMG_2041 (копия) отчёт.jpg"), "IMG_2041 (копия) отчёт.jpg");
check("подпись: разметка обезврежена", attachmentTitle("_черновик_ [v2] *x* a\\b `c`.pdf"), "-черновик- (v2) -x- a-b -c-.pdf");
check(
  "разметка: пустая строка в начале, по абзацу на комментарий и на каждый файл",
  appendixMarkdown("Схема и отчёт", [
    { name: "схема.png", size: 10, contentType: "image/png", url: "/api/attachments.redirect?id=1" },
    { name: "отчёт.pdf", size: 2048, contentType: "application/pdf", url: "/api/attachments.redirect?id=2" },
  ]),
  "\n\nСхема и отчёт\n\n![схема.png](/api/attachments.redirect?id=1)\n\n[отчёт.pdf 2048](/api/attachments.redirect?id=2)\n",
);
check("размер словами", formatBytes(1536), "1,5 КБ");
check(
  "предел Outline словами",
  outlineLimit("Sorry, this file is too large – the maximum size is 976.56 KB"),
  "976,56 КБ",
);

// ── attach против поддельного Outline ─────────────────────────────────

/**
 * Поддельный Outline (http, эта машина) изображает API 1.10.1: documents.info/update с номером
 * правки, collections.list, shares.info и attachments.create во всех трёх режимах загрузки —
 * локальное хранилище (/api/files.create), внешнее по подписанной форме (S3 POST) и подписанный PUT.
 * Поддельная раздача файлов (https с одноразовым сертификатом) отдаёт файл по одноразовой ссылке.
 * CLI запускается отдельным процессом с HOME во временном каталоге: настоящий конфиг не читается,
 * в сеть дальше этой машины ничего не уходит.
 */
async function attachScenarios(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "outline-docs-selftest-"));
  const servers: ReturnType<typeof Bun.serve>[] = [];
  try {
    await runAttachScenarios(work, servers);
  } catch (error) {
    failures.push(`сценарии attach прерваны: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const server of servers) await server.stop(true);
    await rm(work, { recursive: true, force: true });
  }
}

type Logged = {
  method: string;
  path: string;
  auth: string | null;
  status?: number;
  body?: Record<string, unknown>;
  fields?: string[];
  size?: number;
  contentType?: string | null;
};

type FakeDoc = {
  id: string;
  urlId: string;
  title: string;
  text: string;
  revision: number;
  collectionId: string;
  parentDocumentId?: string;
  upload: "local" | "external" | "put";
  readOnly?: boolean;
  colleagueEdit?: "pending" | "done";
  failUpload?: string;
  /** Ключ ограничен по областям доступа без files.*: /api/files.create с ним отвечает 403. */
  scopedKey?: boolean;
  shares?: Record<string, unknown>[];
};

async function runAttachScenarios(work: string, servers: ReturnType<typeof Bun.serve>[]): Promise<void> {
  const KEY = "selftest-key";
  const LIMIT = 1_000_000;
  const home = join(work, "home");
  await mkdir(join(home, ".outline"), { recursive: true });

  // CLI принимает только https-ссылки и проверяет сертификат. Для раздачи выпускается одноразовый,
  // процесс CLI получает его как доверенный через NODE_EXTRA_CA_CERTS — проверка не отключается.
  const certPath = join(work, "cert.pem");
  const keyPath = join(work, "key.pem");
  let issued = false;
  try {
    const openssl = Bun.spawnSync(
      ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
        "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1",
        "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
      { stdout: "ignore", stderr: "ignore" },
    );
    issued = openssl.exitCode === 0;
  } catch {
    issued = false;
  }
  if (!issued) {
    failures.push("сценарии attach: нужен openssl — им выпускается сертификат для поддельной https-раздачи файлов");
    return;
  }

  // ── поддельный Outline ──
  const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const collectionsList = [
    { id: uuid(901), name: "Инструкции" },
    { id: uuid(902), name: "Документация для клиентов" },
    { id: uuid(903), name: "Открытые материалы" },
  ];
  /** Ссылка на всю коллекцию: shares.info { collectionId }. */
  const collectionShares = new Map([[uuid(903), [{ id: uuid(951), collectionId: uuid(903), documentId: null, published: true }]]]);
  const ORIGINAL = "# Подключение\n\nИсходный текст документа, который писали люди.";
  const docs = new Map<string, FakeDoc>();
  const addDoc = (n: number, urlId: string, extra: Partial<FakeDoc> = {}): FakeDoc => {
    const doc: FakeDoc = {
      id: uuid(n),
      urlId,
      title: `Документ ${n}`,
      text: ORIGINAL,
      revision: 7,
      collectionId: uuid(901),
      upload: "local",
      ...extra,
    };
    docs.set(doc.id, doc);
    docs.set(urlId, doc);
    return doc;
  };
  const plain = addDoc(1, "Plain00001", { title: "Подключение к обмену" });
  const forClients = addDoc(2, "Client0002", {
    title: "Инструкция для клиентов",
    collectionId: uuid(902),
    shares: [{ id: uuid(950), documentId: uuid(2), published: true }],
  });
  const busy = addDoc(3, "Busy000003", { colleagueEdit: "pending" });
  const external = addDoc(4, "Extern0004", { upload: "external" });
  const viaPutDoc = addDoc(5, "Put0000005", { upload: "put" });
  const readOnly = addDoc(6, "ReadOnly06", { readOnly: true });
  const flaky = addDoc(7, "Flaky00007", { failUpload: "второй.txt" });
  const scopedDoc = addDoc(8, "Scoped0008", { scopedKey: true });
  // Чужие ссылки: на всю коллекцию; на родителя вместе с вложенными; на родителя без вложенных.
  const inOpenCollection = addDoc(9, "OpenColl09", { collectionId: uuid(903) });
  addDoc(10, "Parent0010", { shares: [{ id: uuid(952), documentId: uuid(10), published: true, includeChildDocuments: true }] });
  const underSharedParent = addDoc(11, "Child00011", { parentDocumentId: uuid(10) });
  addDoc(12, "Parent0012", { shares: [{ id: uuid(953), documentId: uuid(12), published: true, includeChildDocuments: false }] });
  const underNarrowShare = addDoc(13, "Child00013", { parentDocumentId: uuid(12) });

  const log: Logged[] = [];
  const pending = new Map<string, { id: string; doc: FakeDoc; name: string; size: number }>();
  let nextAttachment = 100;
  const json = (status: number, body: unknown): Response =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const present = (doc: FakeDoc): Record<string, unknown> => ({
    id: doc.id,
    urlId: doc.urlId,
    title: doc.title,
    text: doc.text,
    url: `/doc/dokument-${doc.urlId}`,
    collectionId: doc.collectionId,
    parentDocumentId: doc.parentDocumentId ?? null,
    publishedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    revision: doc.revision,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });

  const outline = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const entry: Logged = { method: req.method, path: url.pathname, auth: req.headers.get("authorization") };
      log.push(entry);
      const res = await handleOutline(req, url, entry);
      entry.status = res.status;
      return res;
    },
  });
  servers.push(outline);
  const base = `http://127.0.0.1:${outline.port}/`;

  async function handleOutline(req: Request, url: URL, entry: Logged): Promise<Response> {
    // Внешнее хранилище: подписанная форма или PUT. Ключ Outline сюда приходить не должен.
    if (url.pathname === "/bucket" && req.method === "POST") {
      const form = await req.formData();
      entry.fields = [...form.keys()];
      const file = form.get("file");
      const item = pending.get(String(form.get("key")));
      if (!(file instanceof Blob) || !item || file.size !== item.size) {
        return new Response("<Error><Code>InvalidArgument</Code></Error>", { status: 400 });
      }
      entry.size = file.size;
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/bucket/") && req.method === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      entry.size = bytes.byteLength;
      entry.contentType = req.headers.get("content-type");
      const item = pending.get(decodeURIComponent(url.pathname.slice("/bucket/".length)));
      if (!item || bytes.byteLength !== item.size) {
        return new Response("<Error><Code>BadDigest</Code></Error>", { status: 400 });
      }
      return new Response(null, { status: 200 });
    }
    // Локальное хранилище, как в 1.10.1: ключ необязателен, загрузку разрешает подпись формы (sig),
    // но ключ, которому не хватает областей доступа, получает 403 и с подписью.
    if (url.pathname === "/api/files.create") {
      const form = await req.formData();
      entry.fields = [...form.keys()];
      const file = form.get("file");
      const item = pending.get(String(form.get("key")));
      if (entry.auth ? entry.auth !== `Bearer ${KEY}` : form.get("sig") !== "fake") {
        return json(401, { ok: false, error: "authentication_required", message: "Authentication required" });
      }
      if (entry.auth && item?.doc.scopedKey) {
        return json(403, { ok: false, error: "authorization_error", message: "API key does not have access to this resource" });
      }
      if (!(file instanceof Blob) || !item) {
        return json(400, { ok: false, error: "validation_error", message: "Request must include a file parameter" });
      }
      entry.size = file.size;
      if (item.name === item.doc.failUpload) {
        return json(500, { ok: false, error: "internal_server_error", message: "Disk is full" });
      }
      // Коллега правит документ, пока идёт загрузка: номер правки растёт.
      if (item.doc.colleagueEdit === "pending") {
        item.doc.text += "\n\nПравка коллеги, сделанная во время загрузки.";
        item.doc.revision += 1;
        item.doc.colleagueEdit = "done";
      }
      return json(200, { ok: true, success: true });
    }

    if (entry.auth !== `Bearer ${KEY}`) {
      return json(401, { ok: false, error: "authentication_required", message: "Authentication required" });
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    entry.body = body;
    switch (url.pathname) {
      case "/api/documents.info": {
        const doc = docs.get(String(body.id));
        return doc
          ? json(200, { ok: true, data: present(doc) })
          : json(404, { ok: false, error: "not_found", message: "Resource not found" });
      }
      case "/api/collections.list":
        return json(200, { ok: true, data: collectionsList, pagination: { offset: 0, limit: 100 } });
      case "/api/shares.info": {
        if (body.collectionId) {
          const shares = collectionShares.get(String(body.collectionId));
          return shares?.length ? json(200, { ok: true, data: { shares } }) : json(204, null);
        }
        // Как в 1.10.1: нет своей ссылки у документа — 204, даже если открыта коллекция или родитель.
        const doc = docs.get(String(body.documentId));
        return doc?.shares?.length ? json(200, { ok: true, data: { shares: doc.shares } }) : json(204, null);
      }
      case "/api/attachments.create": {
        const doc = docs.get(String(body.documentId));
        if (!doc || body.documentId !== doc.id) {
          return json(400, { ok: false, error: "validation_error", message: "documentId: Invalid UUID" });
        }
        if (doc.readOnly) return json(403, { ok: false, error: "authorization_error", message: "Authorization error" });
        const size = Number(body.size);
        if (size > LIMIT) {
          return json(400, {
            ok: false,
            error: "validation_error",
            message: "Sorry, this file is too large – the maximum size is 976.56 KB",
          });
        }
        const id = uuid(nextAttachment++);
        const name = String(body.name);
        const contentType = String(body.contentType);
        const key = `uploads/${uuid(999)}/${id}/${name}`;
        pending.set(key, { id, doc, name, size });
        const attachment = { id, name, size, contentType, documentId: doc.id, url: `/api/attachments.redirect?id=${id}` };
        const form = { "Cache-Control": "max-age=31557600", "Content-Type": contentType };
        if (doc.upload === "put") {
          return json(200, {
            ok: true,
            data: {
              mode: "put",
              url: `${base}bucket/${encodeURIComponent(key)}?X-Amz-Signature=fake`,
              headers: { "Content-Type": contentType, "Content-Length": String(size), "Cache-Control": "max-age=31557600" },
              attachment,
            },
          });
        }
        if (doc.upload === "external") {
          return json(200, {
            ok: true,
            data: { mode: "post", uploadUrl: `${base}bucket`, form: { ...form, key, Policy: "fake", "X-Amz-Signature": "fake" }, attachment },
          });
        }
        return json(200, {
          ok: true,
          data: {
            mode: "post",
            uploadUrl: "/api/files.create",
            form: { ...form, key, acl: "private", maxUploadSize: String(LIMIT), contentType, sig: "fake" },
            attachment,
          },
        });
      }
      case "/api/attachments.delete":
        for (const [key, item] of pending) if (item.id === body.id) pending.delete(key);
        return json(200, { ok: true, success: true });
      case "/api/documents.update": {
        const doc = docs.get(String(body.id));
        if (!doc) return json(404, { ok: false, error: "not_found", message: "Resource not found" });
        if (typeof body.lastRevision === "number" && body.lastRevision !== doc.revision) {
          return json(409, {
            ok: false,
            error: "document_conflict",
            message: "Document has been modified since the provided revision",
          });
        }
        // Как в 1.10.1: append дописывает к текущей версии, без него текст заменяется целиком.
        doc.text = body.editMode === "append" || body.append === true ? doc.text + String(body.text) : String(body.text);
        doc.revision += 1;
        return json(200, { ok: true, data: present(doc) });
      }
    }
    return json(404, { ok: false, error: "not_found", message: "Endpoint not found" });
  }

  // ── поддельная раздача файлов по одноразовым ссылкам ──
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 56 }, (_, i) => i)]);
  const TOKEN = "tok-scheme-7f3a9c1e5b2d";
  const remote = new Map([
    [
      TOKEN,
      {
        bytes: PNG,
        type: "image/png",
        disposition: `attachment; filename="fallback.png"; filename*=UTF-8''${encodeURIComponent("Схема подключения.png")}`,
      },
    ],
  ]);
  const opened = new Map<string, number>();
  const filesServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) },
    fetch(req) {
      const token = new URL(req.url).searchParams.get("link") ?? "";
      opened.set(token, (opened.get(token) ?? 0) + 1);
      const item = remote.get(token);
      if (!item) return new Response("not found", { status: 404 });
      if ((opened.get(token) ?? 0) > 1) return new Response("gone", { status: 410 });
      return new Response(item.bytes, {
        headers: { "Content-Type": item.type, "Content-Disposition": item.disposition },
      });
    },
  });
  servers.push(filesServer);
  const link = (token: string, path = "/files/chat/42/scan"): string =>
    `https://127.0.0.1:${filesServer.port}${path}?link=${token}`;

  // ── конфиг и файлы ──
  await writeFile(
    join(home, ".outline", "config.json"),
    JSON.stringify({
      default: "test",
      instances: { test: { url: base, apiKey: KEY, clientCollections: ["Документация для клиентов"] } },
    }),
  );
  const reportText = "Отчёт: обмен работает.\n";
  const reportSize = new TextEncoder().encode(reportText).byteLength;
  const reportPath = join(work, "report.txt");
  const secondPath = join(work, "второй.txt");
  const bigPath = join(work, "big.bin");
  const imagePath = join(work, "photo.png");
  await writeFile(reportPath, reportText);
  await writeFile(secondPath, "второй файл\n");
  await writeFile(bigPath, new Uint8Array(LIMIT + 1));
  await writeFile(imagePath, PNG);

  const cliPath = join(import.meta.dir, "outline.ts");
  const cli = async (...args: string[]) => {
    const mark = log.length;
    const proc = Bun.spawn([process.execPath, cliPath, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, NODE_EXTRA_CA_CERTS: certPath, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 60_000);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code, out, err, all: out + err, requests: log.slice(mark) };
  };
  const WRITES = new Set(["/api/attachments.create", "/api/files.create", "/api/attachments.delete", "/api/documents.update"]);
  const writes = (requests: Logged[]): Logged[] => requests.filter((r) => WRITES.has(r.path) || r.path.startsWith("/bucket"));
  const paths = (requests: Logged[]): string[] =>
    requests.map((r) => (r.path.startsWith("/bucket") ? "bucket" : r.path.replace(/^\/api\//, "")));
  const pick = (value: unknown, keys: string[]): Record<string, unknown> =>
    Object.fromEntries(keys.map((key) => [key, (value as Record<string, unknown> | undefined)?.[key]]));
  const createFields = ["name", "documentId", "contentType", "size", "preset"];

  // 1. Предпросмотр: файл с диска, файл по одноразовой ссылке и комментарий.
  const scheme = link(TOKEN);
  const attachArgs = ["attach", plain.urlId, "--file", reportPath, "--url", scheme, "--comment", "Схема и отчёт по задаче"];
  const preview = await cli(...attachArgs);
  check("attach, предпросмотр: завершается успешно", preview.code, 0);
  check("attach, предпросмотр: в Outline ничего не записано", writes(preview.requests).length, 0);
  check("attach, предпросмотр: ссылка открыта один раз — файл ждёт подтверждения", opened.get(TOKEN) ?? 0, 1);
  check(
    "attach, предпросмотр: называет документ и коллекцию",
    preview.out.includes("Подключение к обмену") && preview.out.includes("Инструкции"),
    true,
  );
  check(
    "attach, предпросмотр: имя из filename*, а не из запасного filename",
    preview.out.includes("Схема подключения.png") && !preview.all.includes("fallback.png"),
    true,
  );
  check(
    "attach, предпросмотр: размеры и типы файлов",
    preview.out.includes(formatBytes(reportSize)) && preview.out.includes("text/plain") && preview.out.includes("image/png"),
    true,
  );
  check(
    "attach, предпросмотр: картинка — картинкой, прочее — вложением",
    preview.out.includes("![Схема подключения.png](") && preview.out.includes(`[report.txt ${reportSize}](`),
    true,
  );
  check(
    "attach, предпросмотр: ссылка показана хостом и путём",
    preview.out.includes(`127.0.0.1:${filesServer.port}/files/chat/42/scan`),
    true,
  );
  check("attach, предпросмотр: токен ссылки не напечатан", preview.all.includes(TOKEN), false);
  check("attach, предпросмотр: просит подтверждения", preview.out.includes("--yes"), true);

  // 2. Та же команда с --yes.
  const done = await cli(...attachArgs, "--yes");
  check("attach --yes: завершается успешно", done.code, 0);
  check("attach --yes: ровно нужные записи и по порядку", paths(writes(done.requests)), [
    "attachments.create",
    "files.create",
    "attachments.create",
    "files.create",
    "documents.update",
  ]);
  check("attach --yes: после записи документ перечитан", paths(done.requests).at(-1), "documents.info");
  check("attach --yes: по ссылке второй раз не ходили", opened.get(TOKEN) ?? 0, 1);
  const creates = done.requests.filter((r) => r.path === "/api/attachments.create").map((r) => r.body);
  check("attach --yes: attachments.create для файла с диска", pick(creates[0], createFields), {
    name: "report.txt",
    documentId: plain.id,
    contentType: "text/plain",
    size: reportSize,
    preset: "documentAttachment",
  });
  check("attach --yes: attachments.create для файла по ссылке", pick(creates[1], createFields), {
    name: "Схема подключения.png",
    documentId: plain.id,
    contentType: "image/png",
    size: PNG.byteLength,
    preset: "documentAttachment",
  });
  check(
    "attach --yes: загрузка в Outline — с ключом, файл последним полем",
    done.requests
      .filter((r) => r.path === "/api/files.create")
      .every((r) => r.auth === `Bearer ${KEY}` && r.fields?.at(-1) === "file"),
    true,
  );
  const update = done.requests.find((r) => r.path === "/api/documents.update")?.body ?? {};
  check("attach --yes: дописывание — append с номером правки", [update.editMode, update.append, update.lastRevision], [
    "append",
    true,
    7,
  ]);
  check("attach --yes: исходный текст документа на месте", plain.text.startsWith(ORIGINAL), true);
  check(
    "attach --yes: в конец дописаны комментарий и ссылки, каждая отдельным абзацем",
    /^\n\nСхема и отчёт по задаче\n\n\[report\.txt \d+\]\(\/api\/attachments\.redirect\?id=[0-9a-f-]{36}\)\n\n!\[Схема подключения\.png\]\(\/api\/attachments\.redirect\?id=[0-9a-f-]{36}\)\n$/.test(
      plain.text.slice(ORIGINAL.length),
    ),
    true,
  );
  check("attach --yes: сверка после записи", done.out.includes("Сверка"), true);
  check("attach --yes: токен ссылки не напечатан", done.all.includes(TOKEN), false);
  check(
    "attach --yes: локальная копия скачанного удалена",
    (await readdir(join(home, ".outline", "downloads")).catch(() => [] as string[])).length,
    0,
  );

  // 3. Коллега правит документ, пока идут загрузки: запись с устаревшим номером правки отклоняется.
  const conflict = await cli("attach", busy.urlId, "--file", reportPath, "--yes");
  const updates = conflict.requests.filter((r) => r.path === "/api/documents.update");
  check("attach, чужая правка во время загрузки: завершается успешно", conflict.code, 0);
  check(
    "attach, чужая правка: первая запись отклонена (409), повтор — с новым номером правки",
    updates.map((r) => [r.status, r.body?.lastRevision]),
    [
      [409, 7],
      [200, 8],
    ],
  );
  const colleague = busy.text.indexOf("Правка коллеги");
  check(
    "attach, чужая правка не потеряна, ссылка дописана после неё",
    busy.text.startsWith(ORIGINAL) && colleague > 0 && colleague < busy.text.indexOf("[report.txt "),
    true,
  );

  // 4. Внешнее хранилище по подписанной форме (S3 POST).
  const viaForm = await cli("attach", external.urlId, "--file", imagePath, "--yes");
  const bucketPost = viaForm.requests.find((r) => r.path === "/bucket");
  check("attach, внешнее хранилище (POST): успешно", viaForm.code, 0);
  check("attach, внешнее хранилище (POST): ключ Outline туда не уходит", bucketPost?.auth ?? "нет заголовка", "нет заголовка");
  check("attach, внешнее хранилище (POST): поля формы, файл последним", bucketPost?.fields, [
    "Cache-Control",
    "Content-Type",
    "key",
    "Policy",
    "X-Amz-Signature",
    "file",
  ]);
  check(
    "attach, внешнее хранилище: картинка дописана картинкой",
    external.text.includes("![photo.png](/api/attachments.redirect?id="),
    true,
  );

  // 5. Подписанный PUT (AWS_S3_UPLOAD_METHOD=put).
  const viaPut = await cli("attach", viaPutDoc.urlId, "--file", imagePath, "--yes");
  const bucketPut = viaPut.requests.find((r) => r.method === "PUT");
  check("attach, подписанный PUT: успешно", viaPut.code, 0);
  check(
    "attach, подписанный PUT: без ключа Outline, с типом и целым файлом",
    [bucketPut?.auth ?? null, bucketPut?.contentType, bucketPut?.size],
    [null, "image/png", PNG.byteLength],
  );

  // 6. Нет права на правку документа: Outline отказывает на attachments.create.
  const denied = await cli("attach", readOnly.urlId, "--file", reportPath, "--yes");
  check("attach, нет права на правку: команда отказывает", denied.code, 1);
  check("attach, нет права на правку: отказ словами", denied.err.includes("нет права править документ"), true);
  check("attach, нет права на правку: ни загрузки, ни правки текста", paths(writes(denied.requests)), ["attachments.create"]);

  // 7. Файл больше предела Outline.
  const tooBig = await cli("attach", plain.urlId, "--file", bigPath, "--yes");
  check(
    "attach, файл больше предела Outline: отказ словами, с пределом",
    tooBig.code === 1 && tooBig.err.includes("больше, чем принимает Outline") && tooBig.err.includes("976,56 КБ"),
    true,
  );
  check("attach, файл больше предела: ни загрузки, ни правки текста", paths(writes(tooBig.requests)), ["attachments.create"]);

  // 8. Второй файл не загрузился: уже созданные вложения удаляются, документ не меняется.
  const broken = await cli("attach", flaky.urlId, "--file", reportPath, "--file", secondPath, "--yes");
  check("attach, сбой загрузки второго файла: команда отказывает", broken.code, 1);
  check("attach, сбой загрузки: созданные вложения удалены, текст не правился", paths(writes(broken.requests)), [
    "attachments.create",
    "files.create",
    "attachments.create",
    "files.create",
    "attachments.delete",
    "attachments.delete",
  ]);
  check("attach, сбой загрузки: документ не изменён", flaky.text, ORIGINAL);
  check(
    "attach, сбой загрузки: сказано словами",
    broken.err.includes("Файлы не приложены") && broken.err.includes("удалены"),
    true,
  );

  // 9. Ключ ограничен по областям доступа без files.*: подписанная форма загружается без ключа.
  const scoped = await cli("attach", scopedDoc.urlId, "--file", reportPath, "--yes");
  check(
    "attach, ключ без области files: повтор загрузки по подписи формы, без ключа",
    [scoped.code, scoped.requests.filter((r) => r.path === "/api/files.create").map((r) => [r.auth !== null, r.status])],
    [
      0,
      [
        [true, 403],
        [false, 200],
      ],
    ],
  );

  // 10. Ссылка неизвестна (404) или уже использована (410).
  const expiredToken = "tok-expired-55aa77bb99cc";
  const expired = await cli("attach", plain.urlId, "--url", link(expiredToken, "/files/chat/7/old"));
  check(
    "attach, неизвестная ссылка (404): «истекла или уже использована, попросите новую»",
    expired.code === 1 && expired.err.includes("истекла или уже использована") && expired.err.includes("попросите новую"),
    true,
  );
  check("attach, неизвестная ссылка: токен не напечатан", expired.all.includes(expiredToken), false);
  const reused = await cli("attach", plain.urlId, "--url", scheme);
  check(
    "attach, использованная ссылка (410): «истекла или уже использована»",
    reused.code === 1 && reused.err.includes("истекла или уже использована"),
    true,
  );
  check("attach, использованная ссылка: токен не напечатан", reused.all.includes(TOKEN), false);
  check("attach, негодные ссылки: в Outline ничего не записано", writes([...expired.requests, ...reused.requests]).length, 0);

  // 11. Не-https ссылка отклоняется до любых запросов.
  const httpToken = "tok-plain-http-31337";
  const insecure = await cli("attach", plain.urlId, "--url", `http://files.example.com/files/a.pdf?link=${httpToken}`);
  check("attach, http-ссылка: отказ до любых запросов", [insecure.code, insecure.requests.length], [1, 0]);
  check(
    "attach, http-ссылка: объяснено словами, токен не напечатан",
    insecure.err.includes("только https") && !insecure.all.includes(httpToken),
    true,
  );
  const pastedToken = "tok-pasted-0a9b8c7d6e";
  const pasted = await cli("attach", plain.urlId, "--url", link(pastedToken), "--comment", `Файл: ${link(pastedToken)}`);
  check(
    "attach, ссылка из --url в комментарии: отказ до любых запросов, токен не напечатан",
    [pasted.code, pasted.requests.length, opened.get(pastedToken) ?? 0, pasted.all.includes(pastedToken)],
    [1, 0, 0, false],
  );

  // 12. Клиентская коллекция и публичная ссылка: планка клиентская, предупреждения в предпросмотре.
  const leak = await cli("attach", forClients.urlId, "--file", reportPath, "--comment", "Логи сняты с сервера 10.0.0.5");
  check(
    "attach, клиентская коллекция: внутренний адрес в комментарии останавливает",
    leak.code === 1 && leak.err.includes("Остановлено"),
    true,
  );
  check("attach, клиентская коллекция: остановлено до записи", writes(leak.requests).length, 0);
  const clientPreview = await cli("attach", forClients.urlId, "--file", reportPath, "--comment", "Пример отчёта");
  check(
    "attach, клиентская коллекция и публичная ссылка: предупреждения в предпросмотре",
    clientPreview.code === 0 &&
      clientPreview.out.includes("клиентской коллекции") &&
      clientPreview.out.includes("публичной ссылкой"),
    true,
  );

  // 13. У документа нет своей ссылки, но он открыт чужой: всей коллекции или родителя с вложенными.
  const exposed = async (urlId: string) => {
    const run = await cli("attach", urlId, "--file", reportPath);
    return { code: run.code, out: run.out, client: /Планка проверки\s+клиентская/.test(run.out) };
  };
  const viaCollection = await exposed(inOpenCollection.urlId);
  check(
    "attach, открыта вся коллекция: предупреждение и клиентская планка",
    viaCollection.code === 0 && viaCollection.out.includes("ссылка на всю коллекцию") && viaCollection.client,
    true,
  );
  const viaParent = await exposed(underSharedParent.urlId);
  check(
    "attach, открыт родитель вместе с вложенными: предупреждение и клиентская планка",
    viaParent.code === 0 && viaParent.out.includes("ссылка на родительский документ") && viaParent.client,
    true,
  );
  const narrow = await exposed(underNarrowShare.urlId);
  check(
    "attach, у родителя ссылка без вложенных: документ закрыт, планка внутренняя",
    narrow.code === 0 && /Публичная ссылка\s+нет/.test(narrow.out) && !narrow.client,
    true,
  );
}

await attachScenarios();

// ── итог ──────────────────────────────────────────────────────────────
console.log(`Проверок пройдено: ${passed}`);
if (failures.length > 0) {
  console.error(`\nНе прошло: ${failures.length}`);
  for (const f of failures) console.error(`  — ${f}`);
  process.exit(1);
}
console.log("Самопроверка пройдена.");
