import {
  Card,
  Chip,
  IconButton,
  MemberDot,
  Segmented,
  TabBar,
  type TabId,
} from '@client/components';
import { Calendar, Clock, Flag, Plus, Repeat, Settings, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

type TaskFilter = 'all' | 'due' | 'mine' | 'archived';

const segmentOptions: { value: TaskFilter; label: string; disabled?: boolean }[] = [
  { value: 'all', label: '予定ごと' },
  { value: 'due', label: '期限順' },
  { value: 'mine', label: '自分の担当' },
  { value: 'archived', label: '無効', disabled: true },
];

const segmentLabels: Record<TaskFilter, string> = {
  all: '予定ごと',
  due: '期限順',
  mine: '自分の担当',
  archived: '無効',
};

const validTabs: readonly TabId[] = ['week', 'routines', 'tasks', 'family'] as const;

export default function DevUiPage() {
  const [searchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const activeTab: TabId =
    rawTab !== null && (validTabs as readonly string[]).includes(rawTab)
      ? (rawTab as TabId)
      : 'week';

  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');
  const [iconActionStatus, setIconActionStatus] = useState<string>('未選択');
  const [captureStatus, setCaptureStatus] = useState<string>('未撮影');

  return (
    <main
      data-testid="dev-ui-screen"
      className="mx-auto min-h-screen w-full max-w-[var(--app-max-width)] px-[var(--spacing-md)] py-[var(--spacing-lg)] bg-bg text-ink box-border"
    >
      <header className="border-b border-line pb-[var(--spacing-md)] mb-[var(--spacing-lg)]">
        <h1 className="text-xl font-bold text-ink">部品一覧</h1>
        <p className="text-xs text-muted mt-[var(--spacing-xs)]">
          Danran のデザイントークンおよび汎用 UI 部品の開発用ショーケースです。
        </p>
      </header>

      {/* 1. Card */}
      <section className="mb-[var(--spacing-lg)]" aria-labelledby="heading-card">
        <h2 id="heading-card" className="text-sm font-semibold text-ink mb-[var(--spacing-xs)]">
          カード (Card)
        </h2>
        <Card data-testid="showcase-card">
          <h3 className="text-sm font-semibold text-ink">家族の予定</h3>
          <p className="text-xs text-muted mt-[var(--spacing-xs)] leading-relaxed">
            カードはトークンの背景色・罫線・角丸・余白を持つコンテナです。
          </p>
        </Card>
      </section>

      {/* 2. Chip */}
      <section className="mb-[var(--spacing-lg)]" aria-labelledby="heading-chip">
        <h2 id="heading-chip" className="text-sm font-semibold text-ink mb-[var(--spacing-xs)]">
          チップ (Chip)
        </h2>
        <div className="flex flex-wrap gap-[var(--spacing-sm)] items-center">
          <Chip variant="routine" icon={Repeat} label="ルーティン" />
          <Chip variant="accent" icon={Sparkles} label="週末の予定" />
          <Chip variant="deadline" icon={Flag} label="締切 10/10" />
          <Chip variant="tentative" icon={Clock} label="候補" />
        </div>
      </section>

      {/* 3. MemberDot */}
      <section className="mb-[var(--spacing-lg)]" aria-labelledby="heading-member-dot">
        <h2
          id="heading-member-dot"
          className="text-sm font-semibold text-ink mb-[var(--spacing-xs)]"
        >
          メンバー色ドット (MemberDot)
        </h2>
        <div className="flex flex-wrap gap-[var(--spacing-md)] items-center">
          <MemberDot name="藍" color="var(--member-indigo)" />
          <MemberDot name="深緑" color="var(--member-green)" />
          <MemberDot name="黄土" color="var(--member-ochre)" />
          <MemberDot name="紫" color="var(--member-purple)" />
          <MemberDot name="珊瑚" color="var(--member-coral)" />
          <MemberDot name="青緑" color="var(--member-teal)" />
          <MemberDot name="薔薇" color="var(--member-rose)" />
          <MemberDot name="石板" color="var(--member-slate)" />
        </div>
      </section>

      {/* 4. Segmented */}
      <section className="mb-[var(--spacing-lg)]" aria-labelledby="heading-segmented">
        <h2
          id="heading-segmented"
          className="text-sm font-semibold text-ink mb-[var(--spacing-xs)]"
        >
          セグメント切り替え (Segmented)
        </h2>
        <Segmented<TaskFilter>
          name="task-filter-showcase"
          label="やることの表示順切り替え"
          options={segmentOptions}
          value={taskFilter}
          onChange={setTaskFilter}
        />
        <p data-testid="segment-status" className="text-xs text-muted mt-[var(--spacing-xs)]">
          選択中: {segmentLabels[taskFilter]}
        </p>
      </section>

      {/* 5. IconButton */}
      <section className="mb-[var(--spacing-lg)]" aria-labelledby="heading-icon-button">
        <h2
          id="heading-icon-button"
          className="text-sm font-semibold text-ink mb-[var(--spacing-xs)]"
        >
          アイコンボタン (IconButton)
        </h2>
        <div className="flex flex-wrap items-center gap-[var(--spacing-sm)]">
          <IconButton
            label="カレンダーを開く"
            icon={Calendar}
            variant="default"
            onClick={() => setIconActionStatus('カレンダーを開きました')}
          />
          <IconButton
            label="予定を追加"
            icon={Plus}
            variant="accent"
            onClick={() => setIconActionStatus('予定追加を開きました')}
          />
          <IconButton
            label="設定"
            icon={Settings}
            variant="outline"
            onClick={() => setIconActionStatus('設定を開きました')}
          />
          <IconButton
            label="削除（無効）"
            icon={Trash2}
            variant="ghost"
            disabled
            onClick={() => setIconActionStatus('無効なボタンが押されました')}
          />
        </div>
        <p data-testid="icon-click-status" className="text-xs text-muted mt-[var(--spacing-xs)]">
          操作結果: {iconActionStatus}
        </p>
      </section>

      {/* 6. TabBar */}
      <section className="mb-[var(--spacing-xl)]" aria-labelledby="heading-tab-bar">
        <h2 id="heading-tab-bar" className="text-sm font-semibold text-ink mb-[var(--spacing-xs)]">
          タブバー (TabBar)
        </h2>
        <div className="border border-line rounded-[var(--radius-md)] bg-surface pt-[var(--spacing-md)]">
          <TabBar
            activeTab={activeTab}
            onCapture={() => setCaptureStatus('プリント撮影が要求されました')}
            links={{
              week: '/dev/ui?tab=week',
              routines: '/dev/ui?tab=routines',
              tasks: '/dev/ui?tab=tasks',
              family: '/dev/ui?tab=family',
            }}
          />
        </div>
        <p data-testid="capture-status" className="text-xs text-muted mt-[var(--spacing-xs)]">
          撮影ステータス: {captureStatus}
        </p>
      </section>
    </main>
  );
}
