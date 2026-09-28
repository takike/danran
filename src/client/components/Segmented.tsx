export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string = string> {
  name: string;
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

export function Segmented<T extends string = string>({
  name,
  label,
  options,
  value,
  onChange,
  disabled = false,
  className = '',
}: SegmentedProps<T>) {
  return (
    <fieldset
      aria-label={label}
      disabled={disabled}
      className={`inline-flex items-center p-[var(--spacing-xs)] bg-chip rounded-[var(--radius-md)] border-0 m-0 ${className}`.trim()}
    >
      <legend className="sr-only">{label}</legend>
      <div className="inline-flex items-center gap-[var(--spacing-xs)] w-full">
        {options.map((option) => {
          const isSelected = option.value === value;
          const isOptionDisabled = disabled || Boolean(option.disabled);
          const inputId = `${name}-${option.value}`;

          return (
            <label
              key={option.value}
              htmlFor={inputId}
              className={`relative flex-auto inline-flex items-center justify-center min-h-[var(--tap-target-min)] min-w-[var(--tap-target-min)] px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs font-semibold whitespace-nowrap rounded-[var(--radius-sm)] transition-colors select-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus-ring)] has-[:focus-visible]:ring-offset-[var(--focus-offset)] has-[:focus-visible]:ring-offset-chip ${
                isOptionDisabled
                  ? 'opacity-40 cursor-not-allowed text-muted'
                  : isSelected
                    ? 'bg-surface text-ink cursor-default'
                    : 'text-muted hover:text-ink cursor-pointer'
              }`.trim()}
            >
              <input
                id={inputId}
                type="radio"
                name={name}
                value={option.value}
                checked={isSelected}
                disabled={isOptionDisabled}
                onChange={() => {
                  if (!isOptionDisabled) {
                    onChange(option.value);
                  }
                }}
                className="sr-only"
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
