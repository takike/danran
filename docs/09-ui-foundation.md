# 09. デザイントークンと汎用 UI 部品（UI Foundation）

Phase 0（タスク 0-5）で整備したデザイントークン、Tailwind CSS v4 連携、汎用 UI コンポーネント、および開発専用ショーケース（`/dev/ui`）の仕様・利用ガイド。

## デザイントークン（`src/client/styles/tokens.css`）

CSS カスタムプロパティを単一の真実源（Single Source of Truth）とし、Tailwind CSS v4 の `@theme inline` を介して Tailwind ユーティリティクラス（`bg-bg`, `bg-surface`, `text-ink`, `border-line`, `text-accent` など）へマッピングしています。将来ポップな配色へ差し替える際も、CSS 変数の値の変更だけで全画面に反映されます。

### トークン一覧

| トークン | 初期値 | 用途 | Tailwind 例 |
|---|---|---|---|
| `--bg` | `#f6f3ee` | 画面全体の背景色 | `bg-bg` |
| `--surface` | `#ffffff` | カード・モーダル等の表面色 | `bg-surface` |
| `--ink` | `#1f1d1a` | 主要テキスト | `text-ink` |
| `--muted` | `#6b655c` | 補足テキスト（コントラスト比 4.5:1 以上） | `text-muted` |
| `--line` | `#e4ded4` | 罫線・区切り線 | `border-line` |
| `--chip` | `#eee9e1` | ルーティンチップ背景 | `bg-chip` |
| `--accent` | `#b8472f` | 主ボタン・週末・強調アクセント | `bg-accent`, `text-accent` |
| `--accent-tint` | `#f7e6e1` | アクセントの薄い背景 | `bg-accent-tint` |
| `--deadline` | `#8a5a12` | 締切強調テキスト | `text-deadline` |
| `--deadline-tint` | `#f3e9d6` | 締切チップ背景 | `bg-deadline-tint` |
| `--member-papa` | `#2e4b73` | パパ固有色（藍） | `bg-member-papa` |
| `--member-mama` | `#2d5a3f` | ママ固有色（深緑） | `bg-member-mama` |
| `--member-daughter` | `#a67c2e` | 長女固有色（黄土） | `bg-member-daughter` |
| `--member-son` | `#6b3e82` | 長男固有色（紫） | `bg-member-son` |
| `--tap-target-min` | `44px` | アクセシビリティ最小タップ領域（44px） | `w-[var(--tap-target-min)]` |
| `--capture-button-size`| `56px` | タブバー中央の撮影ボタンサイズ | `w-[var(--capture-button-size)]` |
| `--member-dot-size` | `10px` | メンバー色ドットサイズ | `w-[var(--member-dot-size)]` |
| `--icon-size-sm` | `14px` | チップ等小型アイコンサイズ | `w-[var(--icon-size-sm)]` |
| `--icon-size-md` | `20px` | ナビ・ボタン等標準アイコンサイズ | `w-[var(--icon-size-md)]` |
| `--icon-size-lg` | `24px` | 撮影等大型アイコンサイズ | `w-[var(--icon-size-lg)]` |
| `--focus-ring` | `#2e4b73` | フォーカスリング色（コントラスト確保） | `ring-[var(--focus-ring)]` |
| `--focus-offset` | `2px` | フォーカスリングオフセット | `ring-offset-[var(--focus-offset)]` |
| `--radius-sm` | `4px` | 小型部品角丸 | `rounded-[var(--radius-sm)]` |
| `--radius-md` | `8px` | カード・コンテナ角丸 | `rounded-[var(--radius-md)]` |
| `--radius-lg` | `12px` | 大枠角丸 | `rounded-[var(--radius-lg)]` |
| `--radius-full` | `9999px` | ピル・完全な丸角丸 | `rounded-[var(--radius-full)]` |
| `--spacing-2xs` | `2px` | 極小パディング | `py-[var(--spacing-2xs)]` |

※ 自閉的別名（`--radius-md: var(--radius-md)` 等）を避け、Tailwind の任意プロパティ構文 `rounded-[var(--radius-md)]` および `p-[var(--spacing-md)]` を利用することで動的な変数上書きに追従します。

---

## 汎用 UI コンポーネント（`src/client/components/`）

すべての部品は docs/02 のアクセシビリティ要件（本物の要素、`aria-*` 属性、タップ領域 44px 以上、線画アイコンのみで絵文字不使用）に準拠しています。

### 1. `Card` (`src/client/components/Card.tsx`)
トークン（`--surface`, `--line`, `--radius-md`, `--spacing-md`）に基づく非対話サーフェスコンテナ。標準 HTML 属性および children を透過的に受け入れます。クリック不可な `div` に無理な役割を付与しません。

```tsx
<Card>
  <h3>タイトル</h3>
  <p>本文コンテンツ</p>
</Card>
```

### 2. `Chip` (`src/client/components/Chip.tsx`)
テキストと任意の Lucide アイコンを持つ非対話の `<span>`。バリアントは `routine`, `accent`, `deadline`, `tentative`。

```tsx
<Chip variant="routine" icon={Repeat} label="ルーティン" />
<Chip variant="deadline" icon={Flag} label="締切 10/10" />
```

### 3. `MemberDot` (`src/client/components/MemberDot.tsx`)
色ドット（`aria-hidden="true"`）と視認可能なメンバー名テキストのセット。色のみによる情報伝達を防止します。

```tsx
<MemberDot name="メンバーA" color="var(--member-papa)" />
```

### 4. `Segmented` (`src/client/components/Segmented.tsx`)
ネイティブ `<input type="radio">` と `<label>` によるアクセシブルな選択切り替え。
- 44px 以上のタップ領域とフォーカスリング。
- 矢印キー（ArrowLeft / ArrowRight）による完全なキーボード操作をブラウザ標準動作でサポート。
- `disabled` オプションの活性化を防止。

```tsx
<Segmented
  name="task-filter"
  label="やることの表示順切り替え"
  options={[
    { value: 'all', label: '予定ごと' },
    { value: 'due', label: '期限順' },
    { value: 'mine', label: '自分の担当' },
  ]}
  value={filter}
  onChange={setFilter}
/>
```

### 5. `IconButton` (`src/client/components/IconButton.tsx`)
本物の `<button type="button">`。アクセシビリティのため空でない `label` プロパティ（`aria-label` にマッピング）が必須です。
- タップ領域は最低 44px × 44px（`size="capture"` 時は 56px × 56px）。
- Lucide アイコンは `aria-hidden="true"`。
- フォーカスリング（`focus-visible`）および無効状態（`disabled`）に対応。

```tsx
<IconButton
  label="予定を追加"
  icon={Plus}
  variant="accent"
  onClick={() => handleAdd()}
/>
```

### 6. `TabBar` (`src/client/components/TabBar.tsx`)
docs/02 に準拠した 5 ポジション（週, 繰り返し, 撮影［中央の大型丸ボタン］, やること, 家族）のフッターナビゲーション。
- ナビゲーション項目は実アンカー（React Router の `Link`）、現在地は `aria-current="page"` で表現。
- 中央の撮影ボタンは `aria-label="プリントを撮影"` を持つ実ボタンで、コールバック `onCapture` をトリガー。
- すべての項目で 44px 以上のタップ領域を維持し、iOS セーフエリア（`safe-area-inset-bottom`）に対応。

```tsx
<TabBar
  activeTab="week"
  onCapture={() => handleCameraCapture()}
/>
```

---

## 開発専用部品一覧（`/dev/ui`）と本番ビルド除外

開発環境（`pnpm dev`）でのみ利用可能な部品カタログです。
- `App.tsx` 内で `import.meta.env.DEV` による静的条件分岐と `React.lazy` 動的インポート境界を配置。
- 本番ビルド（`vite build`）時には Dead Code Elimination（DCE）により `/dev/ui` のルート定義およびページチャンクが本番バンドルから完全に除外されます。
- 本番ビルドのプレビュー環境で `/dev/ui` にアクセスした場合は、ワイルドカードにより通常の `Home` 画面が表示されることが E2E テストで検証されています。
