# 12. 日時・祝日・週レイアウト仕様（Task 1-5）

このドキュメントは、Danran におけるタイムゾーン（`Asia/Tokyo`）、祝日判定、週の範囲計算、画面レイアウト分類（`dayLayout`）、および休園日（`closure_days`）ストレージの仕様と契約をまとめたものです。

---

## 1. タイムゾーン不変条件と日付ユーティリティ（`src/shared/time/`）

Danran における日付・時刻・週・曜日の計算は、実行ホスト環境のタイムゾーン（ブラウザのローカル設定、Worker ランタイム、CI 環境等）に一切依存せず、**常に固定で `Asia/Tokyo`（JST: UTC+09:00）として実行**されます。

### 主要関数と型定義（`src/shared/time/date.ts`）

```typescript
// カノニカルな日付キー（YYYY-MM-DD形式、実在する暦日のみ検証）
export type DateKey = string; // e.g. "2026-10-05"

// タイムゾーン付き ISO 8601 文字列またはミリ秒エポックから Tokyo DateKey を取得
export function toTokyoDateKey(input: Date | number | string): DateKey;

// 今日の DateKey（テスト用に now の注入が可能）
export function getTodayDateKey(now?: number | Date): DateKey;

// 曜日インデックス（0 = 日曜, 1 = 月曜, ..., 6 = 土曜）
export function getWeekday(dateKey: DateKey): number;

// 暦日の加減算（月またぎ、閏年、年越し、負数に対応。非整数・NaNは TypeError）
export function addCalendarDays(dateKey: DateKey, days: number): DateKey;
export function addCalendarWeeks(dateKey: DateKey, weeks: number): DateKey;

// 日の開始・終了（排他）境界
export function getDayBounds(dateKey: DateKey): DayBounds;
```

#### 境界値検証（Zod）
- `dateKeySchema`: `z.string().date()` により、実在するグレゴリオ暦日（2024-02-29 や 2028-02-29 は通過、2026-02-29 や 2026-02-30 は拒否）を保証。
- `isoInstantStringSchema`: `z.string().datetime({ offset: true })` と RFC3339 オフセット範囲チェック（時 00..23、分 00..59）により、タイムゾーンのない文字列（例：`2026-10-05T00:00:00`）や異常なオフセット（例：`+99:99`）を拒否。

#### UTC ISO シリアライズの正確性
`TZDate.toISOString()` は `@date-fns/tz` の仕様上ローカルオフセット表現（例：`+09:00`）を返すため、UTC 境界（`startUtcIso` / `endExclusiveUtcIso`）は内部でエポックミリ秒から真の UTC 文字列（例：`2026-10-05` JST 00:00:00 → `2026-10-04T15:00:00.000Z`）を生成します。

---

## 2. 日本の祝日判定（`src/shared/time/holiday.ts`）

祝日判定にはコミュニティ主導の祝日ライブラリ `@holiday-jp/holiday_jp`（npm パッケージ）を採用しています。

### 仕様と制約
1. **ホストタイムゾーン非依存**: パッケージの `between(Date, Date)` はホストのローカルゲッターを使用するため Danran では使用せず、ISO 日付文字列をキーとする `isHoliday(dateKey)` および `holidays[dateKey]` のみを参照します。
2. **振替休日・国民の休日**: 振替休日（例：`2027-03-22 春分の日 振替休日`）や国民の休日（例：`2026-09-22 休日`。法律上のいわゆる「国民の休日」はライブラリ内で `'休日'` のラベルで返却されます）を含む日本語ラベルを返却します。
3. **データセット有効範囲（1970–2050）**: データセットの収録範囲は 1970 年から 2050 年までです。この範囲外の年が渡された場合は、誤って平日と判定することを防ぐため、明示的に `UnsupportedHolidayYearError`（RangeError）をスローします。
4. **暦要項の公表と年次更新**: 日本の国民の祝日は法律改正や、国立天文台が前年2月最初の官報で公表する「暦要項」（[国立天文台 暦要項](https://eco.mtk.nao.ac.jp/koyomi/yoko/)、[2027年暦要項の発表](https://www.nao.ac.jp/news/topics/2026/20260202-rekiyoko.html) 参照）に基づく春分・秋分の日の確定により定まります。ライブラリ収録の遠い未来の祝日日は暫定的なものであるため、年1回の依存パッケージ更新によって追従します。
5. **年末年始（12/29–1/3）と振替休日**: Danran のルーティンスキップ既定値である年末年始（12/29〜1/3）判定として `isYearEndBreak` を提供します。年末年始は法定国民の祝日とは独立したアプリ独自の休暇概念です（元日 1/1 を除く 12/29〜31 および 1/2〜3 は通常の祝日ではありません）。ただし、1/1 が日曜日の場合は 1/2 が振替休日（法定祝日、例：`2023-01-02`）となるため、1/2 や 1/3 が常に非祝日であるとは限らない点に留意してください。

---

## 3. 週の範囲計算（`src/shared/time/week.ts`）

週ビュー（S1）の表示単位および Google Calendar API（`timeMin` / `timeMax`）への問い合わせ範囲を計算します。

### ルール
- **月曜アンカー**: すべての週は月曜日を起点（`start`）とします。
- **基本範囲**: 通常は月曜日から日曜日までの 7 日間（`days`）。
- **連休延長（Continuous Holiday Extension）**: 日曜日の直後に連続する**法定国民の祝日**がある場合、その連休の最終日まで週の表示範囲を自動で延長します。
  - **例1（スポーツの日）**: 2026-10-05 週は、日曜日（10/11）の翌日である 10/12（スポーツの日）まで連続するため、2026-10-05〜2026-10-12（8日間、排他終了日: 2026-10-13）となります。
  - **例2（シルバーウィーク）**: 2026-09-14 週は、日曜日（09/20）に続く 09/21（敬老の日）・09/22（休日）・09/23（秋分の日）まで連続するため、2026-09-14〜2026-09-23（10日間、排他終了日: 2026-09-24）となります。
  - **平日での停止**: 途中に1日でも平日（通常の勤務日）が挟まる場合は延長を行いません。
  - **休園日の非延長**: 保育園・学校等の休園日（`closure_days`）は各日のカード表示（`dayLayout`）を `'weekend-card'` に分類しますが、週の表示境界（`getWeekRange`）を延長することはありません（週範囲の延長は法定国民の祝日のみが対象です）。
- **週ナビゲーションの安定性**: 前週・次週への遷移（`prevWeekStart` / `nextWeekStart`）は、表示されている週の長さに関わらず、常に起点月曜日の **±7 暦日** です。

---

## 4. 日ごとの表示レイアウト分類（`src/shared/domain/dayLayout.ts`）

週ビューにおいて各日のカード表示サイズ（`'weekend-card'` / `'expanded'` / `'compact'`）を判定する純粋ドメイン関数です。

### 判定順位（優先度順）
1. **`'weekend-card'`（週末・祝日・休園日カード）**:
   - 土曜日・日曜日
   - 日本の国民の祝日（振替休日・国民の休日を含む）
   - 当該家族の休園日（`closure_days` に一致、または `isClosure: true`）
   ※ 非ルーティン予定の有無に関わらず、週末・祝日・休園日判定が最優先されます。
2. **`'expanded'`（展開平日カード）**:
   - 平日において、**有効な（キャンセルされていない）非ルーティン家族予定が 1 件以上**ある場合。
3. **`'compact'`（畳み込み平日カード）**:
   - 上記以外（予定がない平日、ルーティン予定のみの平日、またはキャンセルされた予定のみの平日）。

※ 呼び出し側（API / サービス層）において、家族認可および対象日付・メンバーによる休園日の事前フィルタリングを行った上で `getDayLayout` を呼び出します。
※ TODO 締切チップや公開済み個人ブロックは、カード内に表示されますが、それら自体によって平日を `'expanded'` または `'weekend-card'` に拡張することはありません。

---

## 5. 休園日ストレージ（`src/worker/db/schema.ts`）

保育園・幼稚園の休園日や家族独自の学校行事・連休を記録するテーブルです。

```sql
CREATE TABLE closure_days (
  id TEXT PRIMARY KEY NOT NULL,
  family_id TEXT NOT NULL,
  date TEXT NOT NULL,
  label TEXT NOT NULL,
  member_ids TEXT NOT NULL -- JSON 文字列配列
);

CREATE INDEX closure_days_family_id_date_idx ON closure_days (family_id, date);
```

### 設計上の考慮事項（Task 1-4 との独立性）
- **外部キー制約の保留**: `families` テーブルは Task 1-4（家族の作成・参加）が所有・作成するため、本タスク（Task 1-5）ではスタブテーブルを作らず、`family_id` は論理参照として定義しています。Task 1-4 実装時に新しいマイグレーションで外部キー制約を追加し、API / サービス層でメンバー所有権・家族アクセス権を検証します。
- **対象メンバーのスコープ**: `member_ids` が空配列（`[]`）の場合は家族全員に適用される休園日、メンバー ID が指定されている場合はそのメンバー（大人・子ども問わず指定可能）のみに適用される休園日を表します。DB 保存レコードのスキーマ（`closureDaySchema`）では `memberIds` を必須としており、保存データの欠落による不用意な家族全体への拡大を防いでいます（作成用 `createClosureDaySchema` のみ省略時に空配列へデフォルト補完されます）。また、不透明な ID（`id`, `familyId`, `memberIds`）は先頭・末尾の空白文字を暗黙トリムせず厳格に拒否します。
