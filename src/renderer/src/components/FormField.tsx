/**
 * A labelled text input with inline, accessible field-level error display.
 * Shared by the product and customer forms (Phase 2B UX polish, reused in 2C).
 *
 * - `aria-invalid` is set only while an error is showing.
 * - the error text is linked with `aria-describedby` (plus an optional hint).
 * - the error is rendered only when `error` is a non-empty string; the parent
 *   decides when that is (on blur / on submit, never on an untouched field).
 */

export interface FormFieldProps {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onBlur: () => void;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly inputMode?: 'text' | 'decimal' | 'numeric';
  readonly placeholder?: string;
  readonly autoComplete?: string;
  /** Render a multi-line `<textarea>` instead of a single-line `<input>`. */
  readonly multiline?: boolean;
  readonly rows?: number;
}

export function FormField({
  label,
  name,
  value,
  onChange,
  onBlur,
  error,
  hint,
  inputMode,
  placeholder,
  autoComplete,
  multiline,
  rows,
}: FormFieldProps) {
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`form-field${error ? ' form-field-invalid' : ''}`}>
      <label htmlFor={name}>{label}</label>
      {multiline ? (
        <textarea
          id={name}
          name={name}
          value={value}
          placeholder={placeholder}
          rows={rows ?? 3}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
      ) : (
        <input
          id={name}
          name={name}
          value={value}
          placeholder={placeholder}
          {...(inputMode ? { inputMode } : {})}
          {...(autoComplete ? { autoComplete } : {})}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
      )}
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
