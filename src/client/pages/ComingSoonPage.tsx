import { AuthenticatedShell } from '@client/components/AuthenticatedShell';
import { ArrowLeft, Camera, CheckSquare, Repeat } from 'lucide-react';
import type React from 'react';
import { Link, useNavigate } from 'react-router-dom';

const pageContent = {
  routines: {
    title: '繰り返し予定',
    description: '繰り返し予定の管理は準備中です。',
    Icon: Repeat,
  },
  tasks: {
    title: 'やること',
    description: '予定に紐づくやることの管理は準備中です。',
    Icon: CheckSquare,
  },
  capture: {
    title: 'プリント取り込み',
    description: 'プリントの撮影と取り込みは準備中です。',
    Icon: Camera,
  },
} as const;

type ComingSoonKey = keyof typeof pageContent;

interface ComingSoonPageProps {
  feature: ComingSoonKey;
}

export default function ComingSoonPage({ feature }: ComingSoonPageProps): React.ReactElement {
  const navigate = useNavigate();
  const { title, description, Icon } = pageContent[feature];
  const activeTab = feature === 'routines' ? 'routines' : feature === 'tasks' ? 'tasks' : undefined;

  return (
    <AuthenticatedShell activeTab={activeTab ?? 'week'} onCapture={() => navigate('/import')}>
      <header className="mb-[var(--spacing-lg)]">
        <Link
          to="/"
          className="inline-flex min-h-[var(--tap-target-min)] items-center gap-[var(--spacing-xs)] text-sm text-muted rounded-[var(--radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ArrowLeft size={18} aria-hidden="true" />
          週に戻る
        </Link>
        <h1 className="mt-[var(--spacing-md)] mb-0 text-2xl font-bold">{title}</h1>
      </header>
      <section className="rounded-[var(--radius-lg)] border border-line bg-surface px-[var(--spacing-lg)] py-[var(--spacing-xl)] text-center">
        <div className="mx-auto mb-[var(--spacing-md)] flex h-12 w-12 items-center justify-center rounded-[var(--radius-full)] bg-chip text-muted">
          <Icon size={24} aria-hidden="true" />
        </div>
        <h2 className="m-0 text-base font-semibold">準備中</h2>
        <p className="mt-[var(--spacing-sm)] mb-0 text-sm text-muted leading-relaxed">
          {description}
        </p>
      </section>
    </AuthenticatedShell>
  );
}
