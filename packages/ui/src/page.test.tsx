import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Page } from './page.js';

describe('Page', () => {
  it('renders the title and children', () => {
    const html = renderToStaticMarkup(<Page title="سپهر سلامتی">محتوا</Page>);
    expect(html).toBe('<main><h1>سپهر سلامتی</h1>محتوا</main>');
  });
});
