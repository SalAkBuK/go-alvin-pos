import { GO_PHONES_LOGO_URL } from '../assets/logo';

/**
 * The Go Phones - Alvin store logo (Phase 2E.2). Presentation only — see
 * `assets/logo.ts` for why this is store branding rather than transaction data.
 *
 * The image is a bundled static asset, so it effectively never fails to load;
 * the `onError` handler is a defensive fallback that removes a broken image so
 * the surrounding text (app title, or the receipt's business snapshot) always
 * stands on its own.
 *
 * Accessibility: pass `decorative` where adjacent text already states the
 * business name (e.g. the receipt header, which renders the business-name
 * snapshot right below). Otherwise the logo carries the accessible name.
 */

export interface BrandLogoProps {
  readonly className: string;
  /** `true` → `alt=""` (adjacent text names the business); otherwise the store name is the alt text. */
  readonly decorative?: boolean;
}

export function BrandLogo({ className, decorative = false }: BrandLogoProps) {
  return (
    <img
      className={className}
      src={GO_PHONES_LOGO_URL}
      alt={decorative ? '' : 'Go Phones - Alvin'}
      onError={(event) => {
        event.currentTarget.style.display = 'none';
      }}
    />
  );
}
