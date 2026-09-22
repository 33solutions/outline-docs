/**
 * Предотправочная проверка текстов, уходящих наружу.
 *
 * Модуль общий с скиллом redmine-time: правила одни и те же для задач и для базы знаний.
 * При правке — синхронизировать обе копии.
 *
 * Два класса находок:
 *   block — уходить наружу не должно ни при каких условиях (секреты, платёжные и персональные данные);
 *   warn  — требует осознанного решения автора (внутренняя инфраструктура, самооговор, оценки людей,
 *           обещания без основания).
 *
 * Модуль детерминированный: ловит то, что ловится формой. Смысловую редактуру — тон, полнота,
 * корректность формулировок — делает модель по редакционному стандарту в SKILL.md.
 */

export type Severity = "block" | "warn";

export type Audience = "client" | "internal";

export type Finding = {
  severity: Severity;
  rule: string;
  title: string;
  line: number;
  excerpt: string;
  hint: string;
};

type Rule = {
  id: string;
  title: string;
  severity: Severity;
  /** При аудитории «клиент» предупреждение становится запретом. */
  strictForClient?: boolean;
  pattern: RegExp;
  hint: string;
  /** Дополнительная проверка совпадения: false — находка отбрасывается. */
  accept?: (match: RegExpExecArray) => boolean;
};

/** Значения-заглушки, которые не являются утечкой. */
const PLACEHOLDER =
  /^(?:[*x•]{3,}|<[^>]*>?|\[[^\]]*\]?|\{[^}]*\}?|(?:см|смотри|в|из|через)(?:[.\s].*)?|скрыт\p{L}*|удал[её]н\p{L}*|выда[её]тся\p{L}*|запрош\p{L}*|хранилищ\p{L}*|(?:ваш|сюда|мой|тут|здесь|впиши|укажи)[\s\S]*|your[\s\S]*|ключ|key|token|n\/?a|…|\.{2,}|—|-+|""|''|``)$/iu;

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

/**
 * Отличает реквизит от обычного текста: «Токен: см. Настройки → API» — указание, где его взять,
 * а «Токен: Zx9!kLm2025» — сам реквизит. Секретом считаем сплошную строку из символов, допустимых
 * в реквизите, где есть и буквы, и цифры — либо достаточно длинную, как base64 и hex.
 */
const SECRET_CHARS = /^[A-Za-z0-9_\-+/=.!@#$%^&*~]{8,}$/;

/** Похожее по форме, но реквизитом не являющееся: размеры, даты, версии, время, диапазоны. */
const NOT_SECRET = [
  /^\d+[xх*×]\d+$/i, // размеры изображений
  /^\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}$/, // даты
  /^v?\d+(?:\.\d+)+$/i, // версии
  /^\d{1,2}:\d{2}(?::\d{2})?$/, // время
  /^\d+[-–]\d+$/, // диапазоны
  /^[A-Za-z]+\d{1,4}$/, // короткие обозначения вида BUG001, P4618
];

function looksLikeSecret(token: string): boolean {
  const clean = token.replace(/^[*_`"'<[({|]+/, "").replace(/[*_`"'>\])},.;:!?|]+$/, "").trim();
  if (!SECRET_CHARS.test(clean)) return false;
  if (NOT_SECRET.some((re) => re.test(clean))) return false;
  return (/\d/.test(clean) && /[A-Za-z]/.test(clean)) || clean.length >= 24;
}

/** В хвосте строки после «пароль:» ищем кусок, похожий на реквизит. */
function containsSecret(tail: string): boolean {
  return tail
    .split(/[\s,;|/\\]+/)
    .filter(Boolean)
    .some(looksLikeSecret);
}

/**
 * Границы слова для кириллицы: \b в JavaScript опирается на ASCII-класс \w,
 * поэтому рядом с русскими буквами он не срабатывает. Используем lookaround
 * по Unicode-свойствам — только с флагом «u».
 */
const L = "(?<![\\p{L}\\p{N}_])";
const R = "(?![\\p{L}\\p{N}_])";

function ru(body: string, flags = "giu"): RegExp {
  return new RegExp(`${L}(?:${body})${R}`, flags);
}

function luhnValid(digits: string): boolean {
  const clean = digits.replace(/\D/g, "");
  if (clean.length < 13 || clean.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const RULES: Rule[] = [
  // ── секреты ────────────────────────────────────────────────────────────
  {
    id: "private-key",
    title: "Приватный ключ",
    severity: "block",
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    hint: "Ключ нужно отозвать и перевыпустить: он скомпрометирован уже тем, что попал в текст.",
  },
  {
    id: "aws-key",
    title: "Ключ доступа AWS",
    severity: "block",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    hint: "Удалите ключ из текста и отзовите его в консоли AWS.",
  },
  {
    id: "github-token",
    title: "Токен GitHub",
    severity: "block",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    hint: "Токен считается утёкшим — отзовите его в настройках GitHub.",
  },
  {
    id: "slack-token",
    title: "Токен Slack",
    severity: "block",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    hint: "Отзовите токен в настройках приложения Slack.",
  },
  {
    id: "llm-key",
    title: "Ключ API модели",
    severity: "block",
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
    hint: "Перевыпустите ключ в кабинете провайдера.",
  },
  {
    id: "jwt",
    title: "JWT-токен",
    severity: "block",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    hint: "В токене обычно лежат идентификаторы пользователя и права — выньте его из текста.",
  },
  {
    id: "bearer",
    title: "Заголовок авторизации с токеном",
    severity: "block",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
    hint: "Опишите факт авторизации словами, значение токена не публикуйте.",
  },
  {
    id: "conn-string",
    // Пароль может содержать «@» (в том числе незакодированный), поэтому идём до последнего «@» перед хостом.
    title: "Строка подключения с паролем",
    severity: "block",
    pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|ftp|ssh|smb|https?):\/\/[^\s:/@]+:[^\s/]{3,}@[^\s/]+/gi,
    hint: "Оставьте только хост и базу, учётные данные замените на «см. хранилище секретов».",
  },
  {
    id: "onec-conn",
    title: "Строка соединения 1С с учётными данными",
    severity: "block",
    pattern: /\bUsr\s*=\s*"[^"]*"\s*;\s*Pwd\s*=\s*"[^"]+"/gi,
    hint: "Логин и пароль базы 1С из текста уберите, оставьте Srvr и Ref.",
  },
  {
    id: "password-assign",
    title: "Пароль или ключ в явном виде",
    severity: "block",
    // Между ключевым словом и значением допускаем короткое уточнение: «пароль от админки: …».
    pattern: new RegExp(
      `${L}(?:парол[ьяием]*|пасс|password|passwd|pwd|секрет\\p{L}*|secret|api[ _-]?key|apikey|token|токен\\p{L}*|ключ доступа|логин и пароль)` +
        `[^:=\\n]{0,24}[:=\\s]\\s*([^\\n]{3,120})`,
      "giu",
    ),
    hint: "Передавайте учётные данные через менеджер секретов, а в тексте ссылайтесь на него.",
    // Находка только тогда, когда после двоеточия стоит сам реквизит, а не указание, где его взять.
    accept: (m) => {
      const tail = (m[1] ?? "").trim();
      if (isPlaceholder(tail.replace(/["'`]/g, "").replace(/[.,;:!?)]+$/, ""))) return false;
      return containsSecret(tail);
    },
  },
  {
    id: "credential-near-keyword",
    title: "Реквизит доступа рядом со словом «пароль» или «ключ»",
    severity: "block",
    // Ловит то, что не укладывается в «пароль: значение»: таблицы с колонкой «Пароль»,
    // списки логинов, значение строкой ниже ключевого слова.
    pattern: new RegExp(
      `${L}(?:парол[ьяием]*|password|passwd|pwd|ключ доступа|api[ _-]?key|apikey|токен\\p{L}*|token|secret|секрет\\p{L}*)[\\s\\S]{0,200}`,
      "giu",
    ),
    hint: "Учётные данные хранятся в менеджере секретов; в документе оставляют ссылку на него.",
    accept: (m) => containsSecret(m[0].replace(/^[^\s|:=]+/, "")),
  },
  {
    id: "hex-secret",
    title: "Ключ доступа в шестнадцатеричном виде",
    severity: "block",
    // Ключ Redmine — 40 hex-символов. Требуем рядом ключевое слово, иначе ловили бы хеши коммитов.
    pattern: new RegExp(
      `(?:api[ _-]?key|apikey|token|токен\\p{L}*|secret|секрет\\p{L}*|ключ\\p{L}*)[^\\n]{0,16}?["'\`]?([0-9a-f]{32,64})["'\`]?`,
      "giu",
    ),
    hint: "Похоже на ключ доступа: уберите значение из текста и перевыпустите ключ.",
  },
  {
    id: "card",
    title: "Номер платёжной карты",
    severity: "block",
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    hint: "Номер карты не должен попадать в трекер. Достаточно последних четырёх цифр.",
    accept: (m) => luhnValid(m[0]),
  },
  {
    id: "snils",
    title: "СНИЛС",
    severity: "block",
    pattern: /\b\d{3}-\d{3}-\d{3}[\s-]?\d{2}\b/g,
    hint: "Персональные данные в трекере хранить нельзя — сошлитесь на кадровую систему.",
  },
  {
    id: "passport",
    title: "Паспортные данные",
    severity: "block",
    pattern: new RegExp(`${L}паспорт\\p{L}*\\s*(?:№|N|номер)?\\s*:?\\s*\\d{4}\\s?\\d{6}${R}`, "giu"),
    hint: "Персональные данные в трекере хранить нельзя.",
  },
  {
    id: "inn",
    title: "ИНН в тексте",
    severity: "warn",
    pattern: new RegExp(`${L}ИНН\\s*:?\\s*(\\d{10}|\\d{12})${R}`, "giu"),
    hint: "Реквизиты живут в карточке контрагента, а не в описании задачи.",
  },

  // ── внутренняя кухня ───────────────────────────────────────────────────
  {
    id: "private-ip",
    title: "Внутренний IP-адрес",
    severity: "warn",
    strictForClient: true,
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    hint: "Адреса внутренней сети клиенту не нужны — назовите сервис по имени.",
  },
  {
    id: "internal-host",
    title: "Имя внутреннего узла",
    severity: "warn",
    strictForClient: true,
    pattern: /\b[\w-]+\.(?:local|lan|internal|corp|intranet)\b/gi,
    hint: "Замените на роль узла: «сервер приложений», «тестовый контур».",
  },
  {
    id: "local-path",
    title: "Путь на личной машине",
    severity: "warn",
    pattern: /(?:[A-Za-z]:\\Users\\[^\\\s"']+|\/(?:home|Users)\/[^/\s"']+)/g,
    hint: "Личные пути ничего не говорят читателю — опишите расположение относительно проекта.",
  },
  {
    id: "phone",
    title: "Номер телефона",
    severity: "warn",
    pattern: /\+7[\s(-]?\d{3}[)\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g,
    hint: "Контакты уместны в карточке контрагента, а не в тексте задачи.",
  },
  {
    id: "email",
    title: "Адрес электронной почты",
    severity: "warn",
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g,
    hint: "Убедитесь, что адрес уместен: переписку лучше упоминать ссылкой на задачу.",
  },

  // ── репутационные риски ────────────────────────────────────────────────
  {
    id: "self-incrimination",
    title: "Самооговор",
    severity: "warn",
    strictForClient: true,
    pattern: ru(
      "наша вина|моя вина|мы виноваты|виноват\\p{L}*|накосячил\\p{L}*|косяк наш|наш косяк|мы сломали|я сломал\\p{L}*|" +
        "по нашей (?:вине|глупости)|забыл\\p{L}*\\s+(?:сделать|проверить|включить|обновить)|проворонил\\p{L}*|" +
        "упустил\\p{L}*\\s+из\\s+виду|мы не успели|не успели по нашей|провалил\\p{L}*|прошляпил\\p{L}*|" +
        "из-за нашей ошибки|это мы (?:сломали|уронили|испортили)",
    ),
    hint: "Факт опишите без признания вины: что произошло, что уже сделано, что предотвращает повтор.",
  },
  {
    id: "blame",
    title: "Оценка людей вместо фактов",
    severity: "warn",
    strictForClient: true,
    pattern: ru(
      "клиент\\p{L}*\\s+(?:тупит|не понимает|не читает|не думает)|они не умеют|как обычно у них|опять эти|" +
        "некомпетентн\\p{L}*|бардак у них|у них бардак|их программист\\p{L}*\\s+(?:не|криво)|рук[аи] не оттуда",
    ),
    hint: "Замените оценку на наблюдаемый факт и следствие для работы.",
  },
  {
    id: "unfounded-promise",
    title: "Обещание без основания",
    severity: "warn",
    strictForClient: true,
    pattern: ru(
      "гарантиру\\p{L}+|обещаю|стопроцентно|100\\s?%\\s+(?:успе\\p{L}+|сдел\\p{L}+)|" +
        "точно (?:успеем|будет готово|сделаем)|без проблем сдела\\p{L}+|в любом случае успе\\p{L}+",
    ),
    hint: "Назовите условие и дату: «при доступе к контуру до 25.09 — сдача 27.09».",
  },
  {
    id: "internal-money",
    title: "Внутренняя экономика",
    severity: "warn",
    strictForClient: true,
    pattern: ru("себестоимост\\p{L}+|маржа|маржинальност\\p{L}+|наценк\\p{L}+|закупочн\\p{L}+ цен\\p{L}+|внутренн\\p{L}+ ставк\\p{L}+"),
    hint: "Экономику сделки в клиентской задаче не обсуждают — перенесите во внутренний проект.",
  },
  {
    id: "internal-talk",
    title: "Внутренняя кухня в клиентской задаче",
    severity: "warn",
    strictForClient: true,
    pattern: ru(
      "другой клиент\\p{L}*|у другого заказчика|параллельн\\p{L}+ проект\\p{L}*|" +
        "пока не платят|оплата не прошла|не оплатил\\p{L}*|за свой счёт доделаем",
    ),
    hint: "Ссылки на других заказчиков и расчёты в задаче не уместны — обсуждайте во внутреннем проекте.",
  },
];

export type ScanOptions = {
  audience?: Audience;
  /** Что за поле проверяется — попадает в отчёт. */
  field?: string;
};

export function scanText(text: string, options: ScanOptions = {}): Finding[] {
  const audience = options.audience ?? "client";
  const findings: Finding[] = [];
  if (!text.trim()) return findings;

  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid]! <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (rule.accept && !rule.accept(match)) continue;
      const severity: Severity =
        rule.severity === "warn" && rule.strictForClient && audience === "client" ? "block" : rule.severity;
      findings.push({
        severity,
        rule: rule.id,
        title: rule.title,
        line: lineOf(match.index),
        excerpt: mask(match[0], rule.severity === "block"),
        hint: rule.hint,
      });
      if (findings.filter((f) => f.rule === rule.id).length >= 5) break; // не захламляем отчёт
    }
  }
  return findings.sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === "block" ? -1 : 1));
}

/** Секреты в отчёт целиком не попадают — иначе отчёт сам становится утечкой. */
function mask(value: string, secret: boolean): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (!secret) return flat.length > 70 ? flat.slice(0, 69) + "…" : flat;
  if (flat.length <= 8) return "•".repeat(flat.length);
  return `${flat.slice(0, 4)}${"•".repeat(Math.min(12, flat.length - 8))}${flat.slice(-2)}`;
}

export function formatFindings(findings: Finding[], field?: string): string {
  if (findings.length === 0) return "";
  const where = field ? ` (${field})` : "";
  return findings
    .map((f) => `  [${f.severity === "block" ? "ЗАПРЕТ" : "ВНИМАНИЕ"}]${where} стр. ${f.line} — ${f.title}: ${f.excerpt}\n    ${f.hint}`)
    .join("\n");
}

export type GuardResult = { findings: Finding[]; blocked: boolean; report: string };

/** Проверяет набор полей одного сообщения и собирает общий отчёт. */
export function guard(fields: Record<string, string | undefined>, options: ScanOptions = {}): GuardResult {
  const all: Finding[] = [];
  const parts: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    const findings = scanText(value, { ...options, field });
    if (findings.length === 0) continue;
    all.push(...findings);
    parts.push(formatFindings(findings, field));
  }
  return {
    findings: all,
    blocked: all.some((f) => f.severity === "block"),
    report: parts.join("\n"),
  };
}
