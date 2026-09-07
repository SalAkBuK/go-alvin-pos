import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/src/App';

describe('<App />', () => {
  it('renders the minimal foundation message', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('Go Phones POS');
    expect(html).toContain('Application foundation initialized.');
  });
});
