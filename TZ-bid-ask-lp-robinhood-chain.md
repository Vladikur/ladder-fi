# ТЗ: утилита Bid-Ask ликвидности на Robinhood Chain

Self-hosted инструмент на одного пользователя. Раскладывает ликвидность в пуле Uniswap лестницей узких позиций по стратегии Bid-Ask (имитация бинов Meteora DLMM). Встроенный кошелёк, автоподпись без ручных подтверждений.

## 1. Сеть

| Параметр | Значение |
|---|---|
| Chain ID | `4663` (Arbitrum Orbit L2) |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` (Blockscout) |
| Gas | ETH, block ~100 мс |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec) |

Развёрнуты Uniswap v2, v3, v4. Адреса контрактов Uniswap **агент находит и верифицирует сам** в Blockscout — не переносить с других сетей. Дедлайны считать от timestamp, не от номера блока. Публичный RPC рателимитится — все чтения через multicall. В сети есть форкнутый `UniversalRouter` и контракты-двойники: для LP не критично, но при добавлении свопов проверять.

## 2. Логика Bid-Ask

**Бин = отдельная концентрированная позиция (NFT) с узким тик-диапазоном.** N бинов = N позиций, минтятся батчем.

**Ограничение:** бины возможны только на v3/v4. Для v2 доступно лишь обычное добавление ликвидности в пару — при выборе v2 UI скрывает всё, что касается бинов и диапазона.

### Веса
Лестница из `n` бинов, `j=0` — ближайший к цене, `j=n-1` — дальний:
```
Bid-Ask:  w_j = ((j+1)/n)^α     (α = 1 по умолчанию, слайдер 0.5–4.0)
Spot:     w_j = 1
Curve:    w_j = ((n-j)/n)^α
```
Нормализация `ŵ_j = w_j / Σw`. Bid-Ask — по умолчанию: минимум ликвидности у цены, максимум на краях.

### Нарезка диапазона
```
tickLowerG = nearestUsableTick(priceToTick(Pmin), spacing)
tickUpperG = nearestUsableTick(priceToTick(Pmax), spacing)
binWidth   = floor((tickUpperG - tickLowerG) / (N * spacing)) * spacing
```
Если `binWidth < spacing` — ошибка с подсказкой максимального N. Фактическая верхняя граница = `tickLowerG + N*binWidth`, показать её пользователю.

**Активный бин пропускается.** Ask-лестница строится от `nearestUsableTick(currentTick) + spacing` вверх, bid-лестница — вниз, между ними настраиваемый gap (по умолчанию 1×spacing). Каждая позиция строго односторонняя; двусторонний депозит = две независимые лестницы.

### Суммы
Веса распределяют вносимые суммы токенов, не `L`:
```
amount0_j = X0 · ŵ_j   (ask)      amount1_k = X1 · ŵ_k   (bid)
```
Далее `Position.fromAmount0/fromAmount1` из `@uniswap/v3-sdk` — формулы ликвидности руками не писать.

Только `bigint` в денежной арифметике. Остаток после округления вниз добавлять в бин, ближайший к цене. Инвариант: `Σ amount ≤ входная сумма`, строго.

### Порядок токенов — главный источник ошибок
`token0` = меньший адрес, цена = `token1/token0`. Пользователь мыслит парой base/quote, соответствие может быть инвертировано. Вся математика — во внутренних координатах token0/token1, инверсия только на границе с UI. Если base = token1, ask-лестница уходит **вниз** по тикам — обработать оба случая.

## 3. Функциональность

### 3.1 Поиск пула
Пользователь вводит **адрес одного токена** и выбирает версию (v2 / v3). Приложение находит существующие пулы:
- v3: `factory.getPool(token, quote, fee)` перебором по кандидатам quote-токенов (WETH, USDG + пользовательский список) × всем fee-тирам, одним multicall. Отбросить нулевые адреса.
- v2: `factory.getPair(token, quote)` по тем же кандидатам.
- Для найденных прочитать `slot0`/`reserves`, `liquidity`, символы и decimals обоих токенов.

Показать список: пара, версия, fee, текущая цена, TVL/ликвидность, ссылка на explorer. Отсортировать по ликвидности. Выбор строкой. Плюс поле ручного ввода адреса пула как fallback и поле для добавления своего quote-токена в кандидаты.

### 3.2 Конфигуратор
Стратегия (Bid-Ask/Spot/Curve), α, режим депозита (двусторонний / только base / только quote), N бинов (1–50), границы диапазона (цена или % от текущей), gap, суммы с кнопкой MAX, slippage (0.5% по умолчанию).

### 3.3 Превью
- Гистограмма: столбики по бинам, высота = сумма, линия текущей цены, цвета base/quote. Форма «V» должна быть видна.
- Таблица: #, тик-диапазон, цены, сторона, amount0/amount1.
- Сводка: фактический диапазон, итоги, число позиций и транзакций, оценка газа.
- Предупреждения: диапазон обрезан, N уменьшено, суммы ниже пылевого порога.

### 3.4 Исполнение
Целиком на сервере, `POST /api/execute`, прогресс через SSE.
1. Пересчёт плана на сервере из исходных параметров — готовый calldata от клиента не принимать.
2. Проверка лимитов (§5), балансов, allowance.
3. `approve` на нужную сумму, не `MaxUint256`.
4. Симуляция каждой позиции; при реверте хотя бы одной — не отправлять ничего.
5. Минт: `NonfungiblePositionManager.multicall([mint × K])`, чанк ≤ 10 позиций.
6. Чанки отправляются **последовательно** через очередь с единым nonce-менеджером.
7. `amount0Min/amount1Min` из slippage, deadline = now + 300 с.
8. Частичный успех: показать какие чанки прошли, дать доотправить остаток. Идемпотентность — сверкой с блокчейном.

### 3.5 Позиции
Список NFT кошелька с фильтром по пулу: диапазон, in/out of range, состав, несобранные комиссии. Агрегат по группе + доля отработавших бинов (ключевая метрика Bid-Ask как DCA). Действия: собрать комиссии, вывести бин или группу (`decreaseLiquidity → collect → burn` одним multicall).

Пресеты и метки групп — в `localStorage`.

## 4. Архитектура

```
Next.js 15 App Router, TypeScript strict, viem v2, @tanstack/react-query,
@uniswap/v3-sdk, Tailwind + shadcn/ui, zod, server-only, recharts
```
Wagmi/RainbowKit не нужны — браузерного кошелька нет.

### Граница клиент/сервер
Ключ существует **только** в серверном рантайме. Клиент шлёт параметры → сервер считает, подписывает, отправляет → SSE-прогресс.
- Модули с ключом начинаются с `import 'server-only'`.
- Переменная **никогда** не с префиксом `NEXT_PUBLIC_`. Env через zod, раздельно `serverEnv` / `clientEnv`.
- Единый сериализатор `bigint` в JSON.

```
/app/api    pools | plan | execute | positions
/components UI, не знает о сетях и протоколах
/lib
  /core       ЧИСТАЯ математика: ticks, binning, weights, amounts, orientation
              (без React, viem и сети)
  /registry   chains.ts, protocols.ts, resolve.ts
  /adapters   types.ts, uniswap-v3-fork.ts, uniswap-v2.ts   (v4 — позже)
  /signer     server-only: local-key, nonce-manager, queue
  /rpc        клиенты, retry, backoff
  /guards     server-only: лимиты, аудит
```
Зависимости: `core ← adapters ← api`. `core` не импортирует ничего из остальных.

### Реестр сетей и протоколов
Добавление сети (BNB и т.п.) — **одна запись** в `chains.ts`:
```ts
interface ChainDescriptor {
  id: number; key: string; name: string;
  nativeCurrency: { symbol: string; decimals: number };
  rpcUrls: string[]; explorer: { url: string; kind: 'blockscout' | 'etherscan' };
  multicall3?: Address;
  gasStrategy: 'eip1559' | 'legacy';   // BNB — legacy
  priorityFeeMatters: boolean;         // на Robinhood Chain sequencer FCFS → false
  blockTimeMs: number; confirmations: number;
  wrappedNative: Address; quoteCandidates: Address[];
}
```
Добавление v3-форка (PancakeSwap и т.п.) — **одна запись** в `protocols.ts`:
```ts
interface ProtocolDescriptor {
  key: string; chainId: number;
  family: 'univ2-fork' | 'univ3-fork' | 'univ4';
  contracts: { factory: Address; positionManager?: Address; router?: Address;
               quoter?: Address; permit2?: Address; poolManager?: Address };
  feeTiers: { fee: number; tickSpacing: number }[];
  poolInitCodeHash?: Hex;
  capabilities: { batchMint: boolean; maxPositionsPerTx: number;
                  supportsNativeToken: boolean; requiresPermit2: boolean };
}
```
Форки v3 отличаются только адресами, fee-тирами и `initCodeHash` → **один параметризуемый** `UniswapV3ForkAdapter`, новых классов не писать.

```ts
interface ILiquidityAdapter {
  findPools(token: Address, candidates: Address[]): Promise<PoolRef[]>;
  getPoolState(ref: PoolRef): Promise<PoolState>;
  buildApproveCalls(plan): Promise<Call[]>;
  buildMintCalls(plan): Promise<Call[][]>;      // уже разбито на чанки
  listPositions(owner, ref?): Promise<PositionView[]>;
  buildCollectCalls(ids): Promise<Call[][]>;
  buildWithdrawCalls(ids, bps): Promise<Call[][]>;
}
```
Адаптер только строит вызовы, не подписывает и не отправляет.

**Критерий приёмки по расширяемости:** любой `if (chainId === 4663)` или `if (protocol === 'uniswap')` вне файлов реестра — дефект. Сейчас BNB и PancakeSwap **не добавлять**, только держать архитектуру готовой.

### Подписант
```ts
interface ISigner { address: Address;
  sendCalls(chainId: number, calls: Call[]): Promise<Hash>;
  waitForReceipt(hash: Hash): Promise<Receipt>; }
```
Реализация одна — ключ из env; интерфейс на будущее (KMS).
- Nonce: при старте `getTransactionCount(pending)`, далее локальный инкремент под мьютексом; при `nonce too low` — ресинк и повтор.
- Очередь на адрес, конкурентность **строго 1**. Повторный запрос при активной пачке → 409.
- Газ: `estimateGas` +20%, стратегия из `ChainDescriptor`.
- Застрявшая tx: таймаут 60 с → replacement с тем же nonce и повышенной комиссией.
- Никогда не логировать ключ и raw signed tx — только хэш, nonce, газ.

## 5. Безопасность

Ключ в окружении = компрометация машины означает полную потерю средств адреса. Компенсируется изоляцией и лимитами.

- `.env.local` в `.gitignore` и `.dockerignore`, права `600`. Поддержать два режима через `SIGNER_MODE`: открытый env и зашифрованный keystore с паролем при старте.
- **Отдельный кошелёк** только под этот инструмент, с рабочим капиталом и запасом газа — не основной адрес.
- В обработчике ошибок редактор, вырезающий любые 64-hex последовательности.
- Сервер слушает `127.0.0.1`. Публичная привязка — только через явный флаг и TLS.
- **CSRF:** любая открытая в браузере страница может отправить POST на localhost и запустить подписание. Обязательны проверка `Origin`/`Sec-Fetch-Site` на мутирующих маршрутах **и** секрет `APP_TOKEN` в заголовке. Без токена — 401.

Guard-rails на сервере (не только в UI), значения из env: `TOKEN_ALLOWLIST`, `MAX_NOTIONAL_PER_RUN`, `MAX_NOTIONAL_PER_DAY`, `MAX_SLIPPAGE_BPS`, `MAX_POSITIONS_PER_RUN`, `MAX_GAS_PER_RUN`, `KILL_SWITCH` (проверяется первым).

Аудит: append-only `audit.jsonl` — timestamp, chainId, protocol, nonce, hash, операция, суммы, тики, результат. Ключ и raw tx туда не пишутся.

Баннер в UI: инструмент экспериментальный, горячий ключ, риск impermanent loss. Сначала форк/малые суммы. Утилита не даёт финансовых рекомендаций и не прогнозирует доходность.

## 6. Этапы

1. `/lib/core` — чистая математика.
2. Реестры + адаптеры v2/v3 + поиск пулов по адресу токена.
3. Подписант, nonce, очередь, guard-rails — **до** любого кода, тратящего деньги.
4. Конфигуратор + гистограмма превью.
5. Минт батчем, чанкинг, SSE, доотправка остатка.
6. Управление позициями, комиссии, вывод, аудит.
7. Uniswap v4 (позже).

## 7. Вне скоупа

BNB, PancakeSwap и любые другие сети/протоколы (архитектура готова, записи не добавлять); свопы и авто-балансировка сумм; планировщик и боты; мультикошельки и KMS; расчёт APR и бэктест; мобильное приложение.

## 8. Проверить до начала кодирования

Адреса `UniswapV3Factory`, `NonfungiblePositionManager`, `UniswapV2Factory`, `Multicall3` на chain 4663 (верификация в Blockscout); фактические fee-тиры и `tickSpacing`; существует ли целевой пул и в какой версии основная ликвидность; доступность тестнета — иначе разработка на локальном форке Anvil. О расхождениях с ТЗ сообщать до реализации, не обходить молча.
