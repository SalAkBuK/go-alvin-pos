import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/src/App';
import { ProductForm } from '../../src/renderer/src/features/products/ProductForm';

describe('<App />', () => {
  it('renders the POS shell with the Products & Inventory area and a Customers nav', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('Go Phones POS');
    expect(html).toContain('Products &amp; Inventory');
    // Customers nav button is present; Products is the default area.
    expect(html).toContain('Customers');
  });

  it('renders the create-product form with every canonical create field', () => {
    const html = renderToStaticMarkup(
      <ProductForm mode="create" onCreate={async () => null} onCancel={() => {}} />,
    );
    for (const label of [
      'Name',
      'Brand',
      'Model',
      'Condition',
      'Selling price',
      'Starting quantity',
      'Cost price',
      'SKU',
      'Barcode',
      'Low-stock threshold',
    ]) {
      expect(html).toContain(label);
    }
  });

  it('omits the quantity field when editing (stock changes go through Adjust Stock)', () => {
    const html = renderToStaticMarkup(
      <ProductForm
        mode="edit"
        product={{
          id: 'p1',
          sku: null,
          barcode: null,
          name: 'iPhone 15',
          brand: 'Apple',
          model: 'iPhone 15',
          condition: 'NEW',
          costPriceCents: null,
          sellingPriceCents: 59900,
          quantityOnHand: 3,
          lowStockThreshold: null,
          isActive: true,
          lowStock: false,
          zeroStock: false,
          createdAt: '2026-09-07T00:00:00.000Z',
          updatedAt: '2026-09-07T00:00:00.000Z',
        }}
        onUpdate={async () => null}
        onCancel={() => {}}
      />,
    );
    expect(html).not.toContain('Starting quantity');
  });
});
