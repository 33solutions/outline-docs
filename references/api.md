# Outline API — что нужно знать при доработке скрипта

Все методы вызываются **POST-запросом** на `{base}/api/<метод>` с телом JSON, даже чтение. Авторизация — заголовок `Authorization: Bearer <токен>`. Токен создаётся пользователем в *Настройки → API* и даёт ровно его права.

Ответ: `{ "data": …, "ok": true, "pagination": { "offset": 0, "limit": 25 } }`. Ошибка: `{ "ok": false, "error": "authentication_required", "status": 401, "message": "…" }` — ошибку нужно ловить и по HTTP-статусу, и по полю `ok`.

## Методы, которые использует CLI

| Задача | Метод | Тело |
|---|---|---|
| Кто я | `auth.info` | `{}` → `{ user, team }` |
| Коллекции | `collections.list` | `{ offset, limit }` |
| Структура коллекции | `collections.documents` | `{ id }` → дерево `{ id, title, url, children[] }` |
| Список документов | `documents.list` | `{ collectionId?, userId?, sort, direction, offset, limit }` |
| Поиск | `documents.search` | `{ query, collectionId?, limit, offset }` → `[{ ranking, context, document }]` |
| Документ | `documents.info` | `{ id }` — принимает uuid, `urlId` или слаг из ссылки |
| Создание | `documents.create` | `{ title, text, collectionId, parentDocumentId?, publish }` |
| Изменение | `documents.update` | `{ id, title?, text?, append?, editMode?, lastRevision?, publish? }` |
| Вложение | `attachments.create` | `{ name, documentId, contentType, size, preset: "documentAttachment" }` → `{ mode: "post", uploadUrl, form, attachment }` или `{ mode: "put", url, headers, attachment }` |
| Загрузка в локальное хранилище | `files.create` | multipart: поля `form`, последним — `file` |
| Удалить вложение | `attachments.delete` | `{ id }` |
| Публичные ссылки документа | `shares.info` | `{ documentId }` или `{ collectionId }` → `{ shares: [...] }`; 204 — своей ссылки нет |
| Перемещение | `documents.move` | `{ id, collectionId?, parentDocumentId? }` |
| Архив / удаление | `documents.archive`, `documents.delete` | `{ id }`, `{ id, permanent? }` |
| Выгрузка | `documents.export` | `{ id }` → строка Markdown |
| Выдать ссылку | `shares.create` | `{ documentId, includeChildDocuments? }` |
| Сделать публичной | `shares.update` | `{ id, published: true }` |
| Список ссылок | `shares.list`, `shares.info` | `{ offset, limit }`, `{ documentId }` |
| Отозвать ссылку | `shares.revoke` | `{ id }` |

## Ловушки

1. **`shares.create` не делает ссылку публичной.** Он создаёт объект share и возвращает URL, но до `shares.update { published: true }` ссылка требует входа. CLI выполняет оба шага.
2. **Публикация документа и публичная ссылка — разные вещи.** `documents.update { publish: true }` делает черновик видимым команде по правам коллекции; доступ без входа даёт только опубликованная ссылка.
3. **Обмен ссылками отключается на уровне коллекции и всего пространства.** Отказ `authorization_error` при `shares.create` — это настройка администратора, а не ошибка запроса.
4. **`documents.update` заменяет текст целиком.** Чтобы дописать, нужен `append: true` (в 1.10 — `editMode: "append"`, а `append` оставлен для совместимости); иначе документ перезаписывается — поэтому CLI в предпросмотре явно говорит, заменяется текст или дописывается.
5. **Идентификатор документа.** Подходят uuid, `urlId` и слаг из ссылки `/doc/nazvanie-abc123`. CLI извлекает последний сегмент из URL сам.
6. **`documents.delete` без `permanent` кладёт документ в корзину**, откуда его восстанавливают через `documents.restore`. С `permanent: true` восстановления нет.
7. **Пагинация** — `offset`/`limit`, максимум 100 за запрос; в ответе есть `pagination`, но надёжнее останавливаться, когда вернулось меньше запрошенного.
8. **История правок сохраняется** (`revisions.list`), поэтому удаление секрета правкой текста не убирает его из истории документа.
9. **Вложения** загружаются в два шага: `attachments.create` возвращает адрес и способ загрузки, байты уходят отдельным запросом, затем ссылка дописывается в Markdown. В 1.10 способов три: относительный `uploadUrl` (`/api/files.create`, локальное хранилище) — запрос к адресу инстанса с ключом, форма подписана полем `sig`, предел размера — в `form.maxUploadSize` (ключ, ограниченный по областям доступа без `files`, получает здесь 403 и с подписью — тогда та же форма уходит без ключа); внешний `uploadUrl` (S3 и совместимые) — подписанная форма без заголовка `Authorization`, файл последним полем; `mode: "put"` (`AWS_S3_UPLOAD_METHOD=put`) — PUT с выданными заголовками. Предел размера проверяется уже в `attachments.create`: «Sorry, this file is too large – the maximum size is …».
10. **Markdown — родной формат.** `text` принимает и отдаёт Markdown; HTML в теле документа не поддерживается так, как в Redmine.
11. **Вложение в Markdown** — `[имя размер-в-байтах](/api/attachments.redirect?id=…)`, картинка — `![имя](/api/attachments.redirect?id=…)`. Правило разбора узнаёт вложение только по относительной ссылке на `attachments.redirect`, заменяет им весь абзац (всё остальное в абзаце пропадает) и берёт подпись из первого текстового фрагмента ссылки, отделяя размер по последнему пробелу. Поэтому каждое вложение — отдельным абзацем, а знаки разметки в имени (`[`, `]`, `*`, обратная косая, `_` на границе слова) заменяются: экранирование само дробит текст на фрагменты.
12. **`editMode: "append"` сливает абзацы.** Если дописываемый текст не начинается с перевода строки, а документ кончается абзацем, первый абзац приклеивается к последнему абзацу документа. Дописываемый текст начинается с пустой строки.
13. **`lastRevision` (с 1.10).** `documents.update` с номером правки (`revision` из `documents.info`) отклоняется с 409 `document_conflict`, если документ изменился после чтения, и ничего не пишет: перечитать номер и повторить. Без него сервер дописывает к версии, прочитанной до блокировки строки, — узкое окно, в котором чужая правка может потеряться.
14. **`shares.info { documentId }` в 1.10** отвечает списком `{ shares: [...] }`: своя ссылка документа и, если она есть, родительская (коллекции или документа «со вложенными»). Если своей ссылки нет, ответ — 204 без тела, даже когда открыта вся коллекция или родитель вместе с вложенными. Поэтому `attach` проверяет по очереди свою ссылку, `shares.info { collectionId }` и ссылки родителей вверх по дереву; ссылка родителя открывает потомков, только если `includeChildDocuments: true`, а открыта ссылка — при `published: true`.

Методы и поля сверены с исходниками Outline 1.10.1.

## Файлы состояния

- `~/.outline/config.json` — профили инстансов (URL, токен, коллекция по умолчанию, клиентские коллекции) и настройки аудита репозитория.
- `~/.outline/cache.json` — кэш коллекций, TTL 6 часов.
- `~/.outline/state.json` — отметка последней проверки обновлений скилла.
- `~/.outline/downloads/` — файлы, скачанные `attach --url` и ждущие подтверждения: имя копии — хеш ссылки, сама ссылка на диск не пишется; копия удаляется после записи, неподтверждённая — через час.

## Проверка типов

```bash
bun add -d typescript bun-types && bunx tsc --noEmit
bun scripts/selftest.ts
```
