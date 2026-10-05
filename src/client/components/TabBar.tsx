import { Calendar, Camera, CheckSquare, Repeat, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { IconButton } from './IconButton';

export type TabId = 'week' | 'routines' | 'tasks' | 'family';

export interface TabBarProps {
  activeTab?: TabId;
  onCapture?: () => void;
  className?: string;
  links?: Partial<Record<TabId, string>>;
  showPreparingLabels?: boolean;
}

interface NavItem {
  id: TabId;
  label: string;
  icon: typeof Calendar;
  defaultHref: string;
}

const navItemsBeforeCapture: NavItem[] = [
  { id: 'week', label: '週', icon: Calendar, defaultHref: '/' },
  { id: 'routines', label: '繰り返し', icon: Repeat, defaultHref: '/routines' },
];

const navItemsAfterCapture: NavItem[] = [
  { id: 'tasks', label: 'やること', icon: CheckSquare, defaultHref: '/tasks' },
  { id: 'family', label: '家族', icon: Users, defaultHref: '/family' },
];

export function TabBar({
  activeTab,
  onCapture,
  className = '',
  links = {},
  showPreparingLabels = false,
}: TabBarProps) {
  const renderNavLink = (item: NavItem) => {
    const isActive = activeTab === item.id;
    const href = links[item.id] ?? item.defaultHref;
    const Icon = item.icon;

    return (
      <Link
        key={item.id}
        to={href}
        aria-current={isActive ? 'page' : undefined}
        className={`inline-flex flex-col items-center justify-center flex-1 min-h-[var(--tap-target-min)] min-w-[var(--tap-target-min)] py-[var(--spacing-xs)] text-[11px] transition-colors ${
          isActive ? 'text-accent font-semibold' : 'text-muted hover:text-ink font-normal'
        }`}
      >
        <Icon
          className="w-[var(--icon-size-md)] h-[var(--icon-size-md)] mb-[var(--spacing-2xs)] shrink-0"
          aria-hidden="true"
          size={20}
        />
        <span>{item.label}</span>
        {showPreparingLabels && item.id === 'tasks' && (
          <span className="text-[length:var(--nav-caption-size)] leading-tight text-muted">
            準備中
          </span>
        )}
      </Link>
    );
  };

  return (
    <nav
      aria-label="メインナビゲーション"
      className={`w-full border-t border-line bg-surface pb-[env(safe-area-inset-bottom,0px)] ${className}`.trim()}
    >
      <div className="mx-auto w-full max-w-[var(--app-max-width)] px-[var(--spacing-sm)]">
        <div className="relative flex min-h-[var(--capture-button-size)] items-center justify-between pt-[var(--spacing-xs)]">
          {navItemsBeforeCapture.map(renderNavLink)}

          <div className="-mt-[var(--spacing-md)] flex shrink-0 items-center justify-center px-[var(--spacing-xs)]">
            <div className="relative flex flex-col items-center">
              <IconButton
                label="プリントを撮影"
                icon={Camera}
                variant="accent"
                size="capture"
                onClick={onCapture}
              />
              {showPreparingLabels && (
                <span className="mt-[var(--spacing-2xs)] whitespace-nowrap text-[length:var(--nav-caption-size)] leading-tight text-muted">
                  準備中
                </span>
              )}
            </div>
          </div>

          {navItemsAfterCapture.map(renderNavLink)}
        </div>
      </div>
    </nav>
  );
}
