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
| Изменение | `documents.update` | `{ id, title?, text?, append?, publish? }` |
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
4. **`documents.update` заменяет текст целиком.** Чтобы дописать, нужен `append: true`; иначе документ перезаписывается — поэтому CLI в предпросмотре явно говорит, заменяется текст или дописывается.
5. **Идентификатор документа.** Подходят uuid, `urlId` и слаг из ссылки `/doc/nazvanie-abc123`. CLI извлекает последний сегмент из URL сам.
6. **`documents.delete` без `permanent` кладёт документ в корзину**, откуда его восстанавливают через `documents.restore`. С `permanent: true` восстановления нет.
7. **Пагинация** — `offset`/`limit`, максимум 100 за запрос; в ответе есть `pagination`, но надёжнее останавливаться, когда вернулось меньше запрошенного.
8. **История правок сохраняется** (`revisions.list`), поэтому удаление секрета правкой текста не убирает его из истории документа.
9. **Вложения** загружаются в два шага: `attachments.create` возвращает presigned-форму, файл отправляется отдельным multipart-запросом, затем ссылка вставляется в Markdown.
10. **Markdown — родной формат.** `text` принимает и отдаёт Markdown; HTML в теле документа не поддерживается так, как в Redmine.

## Файлы состояния

- `~/.outline/config.json` — профили инстансов (URL, токен, коллекция по умолчанию, клиентские коллекции) и настройки аудита репозитория.
- `~/.outline/cache.json` — кэш коллекций, TTL 6 часов.
- `~/.outline/state.json` — отметка последней проверки обновлений скилла.

## Проверка типов

```bash
bun add -d typescript bun-types && bunx tsc --noEmit
bun scripts/selftest.ts
```
