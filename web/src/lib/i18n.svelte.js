// Mini-i18n: a Russian string is the key, the en dictionary is the translation.
// t() is reactive via $state, switching is instant. We don't translate the
// simulation feed — it's the bots' server-side events (club flavor), see README.
export const i18n = $state({ lang: 'ru' })

export function setLang(l) { i18n.lang = l === 'en' ? 'en' : 'ru' }

const EN = {
  // App / шапка
  'Дашборд': 'Dashboard', '🕹 Вид сверху': '🕹 Top-down view', '🧪 Тесты API': '🧪 API Tests',
  '📊 Отчёты': '📊 Reports', '⏸ Пауза': '⏸ Pause', '▶ Продолжить': '▶ Resume',
  '♻ Мир': '♻ World', '⏳ Генерирую…': '⏳ Generating…', '⚙ Настройки': '⚙ Settings',
  'Сменить тему интерфейса': 'Switch UI theme', 'Обычный': 'Plain',
  'подключение…': 'connecting…', 'скорость': 'speed', 'тик': 'tick', 'смена': 'shift',
  'в клубе': 'in club', 'из': 'of', 'ПАУЗА': 'PAUSED',
  '♻ Снести тестовый мир и сгенерировать новый?\nВсе боты будут ПОЛНОСТЬЮ удалены со стенда, персоны и планировка комнат станут другими.':
    '♻ Tear down the test world and generate a new one?\nAll bots will be COMPLETELY deleted from the server; personas and room layout will change.',
  // Dashboard
  'Хосты': 'Hosts', 'Игроки': 'Players', 'Живая лента': 'Live feed', 'Очередь заказов': 'Order queue',
  'касса за сеанс': 'session revenue', 'посадок': 'seatings', 'компаний': 'groups', 'заказов': 'orders',
  'выдано': 'delivered', 'продаж на кассе': 'register sales', 'пополнений': 'top-ups',
  'пакетов времени': 'time packages', 'броней': 'reservations', 'игр': 'games', 'турниров': 'tournaments',
  'уходов': 'departures', 'регистраций': 'registrations',
  'очередь пуста — оператор всё разгрёб': 'queue is empty — the operator cleared everything',
  'сидит': 'seated for', 'мин': 'min', 'ещё': 'left', 'в клубе, не за хостом': 'in club, not seated',
  'сегодня не придёт': 'not coming today', 'новый': 'new', 'готовится': 'cooking', 'назад': 'ago',
  // ForceMenu
  '⚡ События': '⚡ Events', 'Посадить игрока': 'Seat a player', 'Компания (2-3)': 'Group (2-3)',
  'Новый игрок в базе': 'New player', 'Заказ на бар': 'Bar order', 'Турнир': 'Tournament',
  'Продажа на кассе': 'Register sale', 'Void чека': 'Invoice void', 'Касса: внести/изъять': 'Register: pay in/out',
  '🪑 Посадить игрока': '🪑 Seat a player', '👥 Компания': '👥 Group visit', '📝 Новый игрок': '📝 New player',
  '🍔 Заказ бара': '🍔 Bar order', '🏆 Турнир': '🏆 Tournament', '💵 Пополнение': '💵 Top-up',
  '🧾 Продажа на кассе': '🧾 Register sale', '💬 Жизнь': '💬 Life event',
  // Визард
  '👋 Первый запуск Gizmo Sandbox': '👋 First run of Gizmo Sandbox',
  'Подключение': 'Connection', 'Режим работы': 'Mode', 'Тема интерфейса': 'UI theme',
  'Загрузка…': 'Loading…',
  'Куда подключаемся. Всё можно поменять позже в ⚙ Настройках.': 'Where to connect. Everything can be changed later in ⚙ Settings.',
  'Только тестовый сервер!': 'Test server only!',
  'Симулятор создаёт реальных пользователей, платежи, чеки и кассовые операции, а «♻ Мир» безвозвратно удаляет ботов. На боевом Gizmo это испортит отчёты и кассу.':
    'The simulator creates real users, payments, invoices and register operations, and "♻ World" permanently deletes bots. On a production Gizmo this will corrupt reports and the register.',
  'Gizmo IP': 'Gizmo IP', 'Порт': 'Port', 'Логин': 'Login', 'Пароль': 'Password',
  'Бренч': 'Branch', 'SQL пароль (опц.)': 'SQL password (opt.)',
  '⏳ Проверяю…': '⏳ Checking…', '🔌 Проверить связь': '🔌 Test connection',
  'Подтверждаю: это': 'I confirm: this is a', 'тестовый': 'TEST',
  'сервер Gizmo, данными на нём можно жертвовать': 'Gizmo server whose data is expendable',
  'Далее →': 'Next →', '← Назад': '← Back',
  'нужна связь с Gizmo, проверь адрес и креды': 'Gizmo must be reachable — check the address and credentials',
  'отметь галочку про тестовый сервер': 'tick the test-server checkbox',
  'Что будем делать? Обе вкладки доступны всегда — это только стартовый экран.': 'What are we doing? Both tabs are always available — this only picks the start screen.',
  'Симулятор клуба': 'Club simulator',
  'Живой клуб: боты играют, заказывают, оператор ведёт смену. Активность видна в админке и отчётах.':
    'A living club: bots play and order, an operator runs the shift. Activity shows up in the admin panel and reports.',
  'Тестировать API Gizmo V3': 'Test Gizmo V3 API',
  'Сценарные тесты и полный скан всех эндпоинтов из OpenAPI-дока с отчётами между версиями.':
    'Scenario tests and a full endpoint scan from the OpenAPI doc with cross-version reports.',
  'Как будет выглядеть интерфейс (меняется в один клик кнопкой 🎨 в шапке).': 'How the UI looks (switchable any time with the 🎨 button in the header).',
  'Акцентный цвет:': 'Accent color:', '🚀 Поехали!': "🚀 Let's go!",
  // ApiTests
  'Сценарные тесты (реальные вызовы, самоочистка)': 'Scenario tests (real calls, self-cleaning)',
  '▶ Запустить сценарии': '▶ Run scenarios', '⏳ Прогоняю…': '⏳ Running…',
  'Полный скан Gizmo V3 (каталог из OpenAPI-дока сервера)': 'Full Gizmo V3 scan (catalog from the server OpenAPI doc)',
  '▶ Полный скан + сохранить отчёт': '▶ Full scan + save report', '⏳ Сканирую все эндпоинты…': '⏳ Scanning all endpoints…',
  'всего': 'total', 'зависимости': 'dependencies', 'пропущено': 'skipped',
  'мутаций': 'mutations', 'юзерских': 'user-scope', 'без образца': 'no sample',
  '◌ «зависимость» = API работает, но нет нужного состояния на сервере (сущность не создана и т.п.). Клик по строке — полная информация о запросе и ответе.':
    '◌ "dependency" = the API works but the server lacks the required state (entity not created etc.). Click a row for full request/response details.',
  'показывать полностью зелёные модули': 'show fully green modules',
  'Метод и путь': 'Method and path', 'Код · время': 'Code · time', 'Детали': 'Details',
  'вызванных GET': 'called GETs', 'проблем:': 'problems:', 'зависимостей:': 'dependencies:',
  'мутаций (не вызываются):': 'mutations (not called):', 'прочих:': 'other:', 'всего в доке:': 'total in doc:',
  '→ Запрос': '→ Request', '← Ответ': '← Response', 'Query-параметры': 'Query parameters',
  'Заголовки запроса': 'Request headers', 'Тело запроса': 'Request body',
  'Заголовки ответа': 'Response headers', 'Тело ответа': 'Response body',
  '— (без тела)': '— (no body)', 'Вызов не выполнялся:': 'The call was not made:',
  '🧨 Скан мутаций (создать → изменить → удалить)': '🧨 Mutation scan (create → update → delete)',
  'Для каждого модуля с парой POST+DELETE создаётся тестовая запись (тело — из схемы OpenAPI), обновляется PUT\'ом и удаляется. Чужие данные не трогаются; системные модули (кассы, смены, платежи, сессии, пользователи, хосты) исключены — их покрывают сценарные тесты.':
    'For every module with a POST+DELETE pair a test record is created (body generated from the OpenAPI schema), updated with PUT and deleted. No foreign data is touched; system modules (registers, shifts, payments, sessions, users, hosts) are excluded — scenario tests cover them.',
  '🧨 Запустить скан мутаций': '🧨 Run mutation scan', '⏳ Гоняю циклы…': '⏳ Running cycles…',
  'модулей': 'modules', 'вызовов': 'calls',
  'Сравнение отчётов между версиями': 'Report comparison between versions',
  '— старый отчёт —': '— old report —', '— новый отчёт —': '— new report —', 'Сравнить': 'Compare',
  'отчётов сохранено:': 'reports saved:', 'новых': 'added', 'удалённых': 'removed', 'изменённых': 'changed',
  'форма ответа изменилась': 'response shape changed',
  'Изменения в API-документации': 'API documentation changes',
  'Сохранённые отчёты:': 'Saved reports:', '🗑 очистить все отчёты': '🗑 clear all reports',
  'Сохранённых отчётов пока нет — запусти «Полный скан», отчёт сохранится автоматически. После обновления Gizmo запусти ещё раз и сравни.':
    'No saved reports yet — run "Full scan" and a report is saved automatically. After a Gizmo update, run it again and compare.',
  'Сравнение API-доков (.json)': 'API doc comparison (.json)',
  'Док каждой версии сохраняется при первом скане (spec_<версия>.json). Можно загрузить док другой версии вручную (Scalar → Download OpenAPI Document) и сравнить: новые/удалённые/изменённые эндпоинты с параметрами и полями.':
    'Each version\'s doc is saved on its first scan (spec_<version>.json). You can also upload another version\'s doc manually (Scalar → Download OpenAPI Document) and compare: added/removed/changed endpoints with parameters and fields.',
  '🌐 Текущая версия (с сервера)': '🌐 Current version (from server)', '— выбери док —': '— pick a doc —',
  'путей': 'paths', 'Сравнить доки': 'Compare docs', '📄 Загрузить .json': '📄 Upload .json',
  'Сохранённые доки:': 'Saved docs:', 'Различий нет — доки идентичны.': 'No differences — the docs are identical.',
  'параметры:': 'parameters:', 'тело:': 'body:', 'ответ:': 'response:', 'параметр': 'parameter',
  'поле тела запроса': 'request body field', 'поле ответа': 'response field',
  'API-док одной из версий не сохранён (spec_*.json появляется при первом скане версии) — диф документации недоступен.':
    'One of the versions has no saved API doc (spec_*.json appears on the first scan of a version) — the doc diff is unavailable.',
  // ReportsPanel
  'Живые отчёты': 'Live reports', 'Занятость': 'Occupancy', 'Касса': 'Revenue',
  'Очередь': 'Queue', 'Сервис': 'Service',
  'Удалить': 'Delete', 'Удалить ВСЕ сохранённые отчёты сканов? (API-доки spec_*.json останутся)': 'Delete ALL saved scan reports? (API docs spec_*.json will remain)',
  '🧨 Скан мутаций создаст в КАЖДОМ подходящем модуле тестовую запись (api_mut_*), обновит и удалит её.\nЧужие данные не трогаются, но на сервере будут реальные операции записи. Продолжить?':
    '🧨 The mutation scan will create a test record (api_mut_*) in EVERY eligible module, update and delete it.\nNo foreign data is touched, but real write operations will hit the server. Continue?',
  // Scenario test groups (server-side group keys)
  'Справочники': 'Reference data', 'Сессии': 'Sessions', 'Деньги': 'Money', 'Заказы': 'Orders',
  'Брони': 'Reservations', 'Смена': 'Shift', 'Отчёты': 'Reports', 'SQL': 'SQL',
  'Не удалось загрузить:': 'Upload failed:', 'созданы недостающие фикстуры:': 'created missing fixtures:',
  'host-API проверены через подключённый хост': 'host API checked via a connected host',
  'host-эндпоинтов помечены пропуском': 'host endpoints marked as skipped',
  "Для каждого модуля с парой POST+DELETE создаётся тестовая запись (тело — из схемы OpenAPI), обновляется PUT'ом и удаляется. Чужие данные не трогаются; системные модули (кассы, смены, платежи, сессии, пользователи, хосты) исключены — их покрывают сценарные тесты.":
    "For every module with a POST+DELETE pair a test record is created (body from the OpenAPI schema), updated with PUT and deleted. No foreign data is touched; system modules (registers, shifts, payments, sessions, users, hosts) are excluded — scenario tests cover them.",
  // ReportsPanel / Settings
  'реальное время': 'real time', 'Занятость клуба': 'Club occupancy', 'Касса за сеанс': 'Session revenue',
  'Очередь заказов бара': 'Bar order queue', 'Сервис (всего за сеанс)': 'Service (session total)',
  'Подключение Gizmo ⟳': 'Gizmo connection ⟳', 'SQL для AppStat ⟳': 'SQL for AppStat ⟳',
  'IP': 'IP', 'База': 'Database', 'Хост': 'Host',
  'Симуляция': 'Simulation', 'Ботов на старте ⟳': 'Bots at start ⟳', 'Максимум игроков': 'Max players',
  'Максимум сидящих (лицензия)': 'Max seated (license)', 'Тик, сек': 'Tick, sec', 'Ускорение ×': 'Speed ×',
  'Порт веб-интерфейса ⟳': 'Web UI port ⟳',
  'Сессии (минуты клуба)': 'Sessions (club minutes)', 'Минимум': 'Min', 'Максимум': 'Max',
  'Шанс раннего ухода': 'Early-leave chance',
  'Кулдауны привычек, мин': 'Habit cooldowns, min', 'Заказ бара: от': 'Bar order: from', 'Заказ бара: до': 'Bar order: to',
  'Пополнение: от': 'Top-up: from', 'Пополнение: до': 'Top-up: to', 'Ассеты: от': 'Assets: from', 'Ассеты: до': 'Assets: to',
  'Оператор': 'Operator', 'Готовка: от': 'Cooking: from', 'Готовка: до': 'Cooking: to',
  'Касса: от': 'Register: from', 'Касса: до': 'Register: to', 'Смена, часов': 'Shift, hours',
  'Веса событий (за тик)': 'Event weights (per tick)', '🪑 Посадка': '🪑 Seating', '🍔 Заказ': '🍔 Order',
  '⏱ Пакет времени': '⏱ Time package', '📅 Бронь': '📅 Reservation', '🎧 Ассет': '🎧 Asset',
  '🎮 Игра (SQL)': '🎮 Game (SQL)', '🧾 Касса': '🧾 Register',
  'Настройки симулятора': 'Simulator settings',
  // SettingsDialog
  'Настройки симулятора': 'Simulator settings', 'Сохранить': 'Save', 'Отмена': 'Cancel', 'Сохранено!': 'Saved!',
}

/** Перевод строки-ключа; на ru возвращает ключ как есть. */
export function t(s) {
  return i18n.lang === 'en' ? (EN[s] ?? s) : s
}
