// A switch: a setting that takes effect the moment it flips (no Save). In a form that is submitted, use a checkbox.
export function Switch({ checked, onChange, label, labelledBy, describedBy, disabled, id, className, testId, title }: {
  checked: boolean
  onChange: (next: boolean) => void
  /** The accessible name, when no visible label names it (`labelledBy`). */
  label?: string
  labelledBy?: string
  describedBy?: string
  disabled?: boolean
  id?: string
  className?: string
  testId?: string
  title?: string
}) {
  return (
    <button
      type="button"
      id={id}
      className={`switch ${checked ? 'on' : ''} ${className ?? ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={label ? undefined : labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      title={title}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden />
    </button>
  )
}
