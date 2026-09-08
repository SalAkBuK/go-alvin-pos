import { useCallback, useMemo, useState } from 'react';
import type {
  CheckoutReview,
  CompletedSaleResult,
  PaymentMethod,
} from '../../../../shared/checkout';
import { PAYMENT_METHODS } from '../../../../shared/checkout';
import { formatCents, MoneyParseError, parseCurrencyToCents } from '../../../../shared/money';
import type { CustomerRecord } from '../../../../shared/customers';
import type { AppErrorCode, IpcResult, ProductRecord } from '../../../../shared/products';
import type { ReceiptRepresentation } from '../../../../shared/receipt';
import {
  addProduct,
  canCompleteCash,
  cartPreview,
  clearCart,
  clearReview,
  EMPTY_CART,
  lineDiscountCents,
  lineTotalCents,
  previewValidationErrors,
  removeLine,
  setCustomer,
  setPaymentMethod,
  setQuantity,
  setSoldPrice,
  toCompleteCashRequest,
  toReviewRequest,
  withReview,
} from './cart';
import type { CartState } from './cart';
import { isRetryableCommitFailure, requiresReReview } from './checkoutCompletion';
import { ReceiptPreview } from './ReceiptPreview';
import { SaleSuccess } from './SaleSuccess';

/**
 * New Sale / Checkout screen (task `§16`; `POS_WORKFLOWS.md §16`-`§28`, `§33`,
 * `§37`, `§87`; `REQ-CUST-004`).
 *
 * The draft cart lives only in this component's state — no persistence until the
 * cashier completes the sale. All authoritative calculation happens in the
 * trusted `window.pos.checkout.*` calls; the numbers shown before Review are an
 * immediate local preview only.
 *
 * Phase 2E adds a real Cash `Complete sale` action (enabled only after a current
 * Cash review), Create Customer During Checkout, a Clear-cart confirmation, and
 * the sale-success screen. Card completion is deliberately still unavailable.
 */

function pos() {
  if (typeof window === 'undefined' || typeof window.pos === 'undefined') {
    return null;
  }
  return window.pos;
}

/** An error that carries the trusted layer's stable code, not just its message. */
class IpcResultError extends Error {
  readonly code: AppErrorCode;
  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) {
    return result.data;
  }
  throw new IpcResultError(result.error.code, result.error.message);
}

function priceInputValue(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function CheckoutPage() {
  const [cart, setCart] = useState<CartState>(EMPTY_CART);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [saleResult, setSaleResult] = useState<CompletedSaleResult | null>(null);

  // Post-sale receipt preview (Phase 2E.1) — reachable only from the success
  // screen, retrieved by the committed Sale ID, never from the checkout cart.
  const [showReceipt, setShowReceipt] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptRepresentation | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);

  // Product search / add
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly ProductRecord[]>([]);
  const [barcode, setBarcode] = useState('');

  // Customer search / attach / create
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState<readonly CustomerRecord[]>([]);
  const [attachedCustomer, setAttachedCustomer] = useState<CustomerRecord | null>(null);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [addCustomerError, setAddCustomerError] = useState<string | null>(null);
  const [savingCustomer, setSavingCustomer] = useState(false);

  const preview = useMemo(() => cartPreview(cart), [cart]);
  const previewErrors = useMemo(() => previewValidationErrors(cart), [cart]);

  const mutate = useCallback((next: CartState) => {
    setCart(next);
    setNotice(null);
  }, []);

  const runSearch = useCallback(async () => {
    const api = pos();
    if (!api || query.trim() === '') {
      setResults([]);
      return;
    }
    try {
      setResults(await unwrap(api.products.search({ query })));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [query]);

  const addFromResult = useCallback(
    (product: ProductRecord) => {
      if (product.zeroStock) {
        setError(`“${product.name}” is out of stock and cannot be added.`);
        return;
      }
      if (!product.isActive) {
        setError(`“${product.name}” is archived and cannot be added.`);
        return;
      }
      setError(null);
      mutate(addProduct(cart, product));
    },
    [cart, mutate],
  );

  const addFromBarcode = useCallback(async () => {
    const api = pos();
    if (!api || barcode.trim() === '') {
      return;
    }
    try {
      const lookup = await unwrap(api.products.findByBarcode(barcode));
      if (!lookup.found) {
        setError('No active product matches that barcode.');
        return;
      }
      addFromResult(lookup.product);
      setBarcode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [barcode, addFromResult]);

  const onQuantityInput = useCallback(
    (key: string, raw: string) => {
      const trimmed = raw.trim();
      if (trimmed === '' || !/^\d+$/.test(trimmed)) {
        setError('Quantity must be a whole number.');
        return;
      }
      const value = Number(trimmed);
      setError(null);
      mutate(setQuantity(cart, key, value));
    },
    [cart, mutate],
  );

  const onPriceInput = useCallback(
    (key: string, raw: string) => {
      try {
        const cents = parseCurrencyToCents(raw);
        setError(null);
        mutate(setSoldPrice(cart, key, cents));
      } catch (err) {
        setError(err instanceof MoneyParseError ? err.message : String(err));
      }
    },
    [cart, mutate],
  );

  const runCustomerSearch = useCallback(async () => {
    const api = pos();
    if (!api || customerQuery.trim() === '') {
      setCustomerResults([]);
      return;
    }
    try {
      setCustomerResults(await unwrap(api.customers.search({ query: customerQuery })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [customerQuery]);

  const attachCustomer = useCallback(
    (customer: CustomerRecord) => {
      setAttachedCustomer(customer);
      setCustomerResults([]);
      setCustomerQuery('');
      mutate(setCustomer(cart, customer.id));
    },
    [cart, mutate],
  );

  const detachCustomer = useCallback(() => {
    setAttachedCustomer(null);
    mutate(setCustomer(cart, null));
  }, [cart, mutate]);

  const saveNewCustomer = useCallback(async () => {
    const api = pos();
    if (!api) {
      setAddCustomerError('Customer creation is unavailable in this context.');
      return;
    }
    const name = newCustomerName.trim();
    if (name === '') {
      setAddCustomerError('Enter the customer name.');
      return;
    }
    setSavingCustomer(true);
    try {
      const phone = newCustomerPhone.trim();
      const created = await unwrap(api.customers.create(phone === '' ? { name } : { name, phone }));
      // Reuses the existing customer-create path; only then attach + continue.
      attachCustomer(created);
      setShowAddCustomer(false);
      setNewCustomerName('');
      setNewCustomerPhone('');
      setAddCustomerError(null);
      setNotice(`Customer “${created.name}” created and attached.`);
    } catch (err) {
      // Cart and any existing customer selection are untouched; no sale occurs.
      setAddCustomerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingCustomer(false);
    }
  }, [newCustomerName, newCustomerPhone, attachCustomer]);

  const choosePayment = useCallback(
    (method: PaymentMethod) => {
      mutate(setPaymentMethod(cart, cart.paymentMethod === method ? null : method));
    },
    [cart, mutate],
  );

  const resetForNewSale = useCallback(() => {
    setCart(clearCart());
    setSaleResult(null);
    setShowReceipt(false);
    setReceipt(null);
    setReceiptError(null);
    setReceiptLoading(false);
    setAttachedCustomer(null);
    setResults([]);
    setCustomerResults([]);
    setShowAddCustomer(false);
    setNewCustomerName('');
    setNewCustomerPhone('');
    setAddCustomerError(null);
    setNotice(null);
    setError(null);
  }, []);

  const onViewReceipt = useCallback(async () => {
    if (!saleResult) {
      return;
    }
    setShowReceipt(true);
    setReceiptError(null);
    const api = pos();
    if (!api) {
      setReceipt(null);
      setReceiptError('Receipt preview is unavailable in this context.');
      return;
    }
    setReceiptLoading(true);
    try {
      setReceipt(await unwrap(api.receipts.getBySaleId(saleResult.saleId)));
    } catch (err) {
      setReceipt(null);
      setReceiptError(err instanceof Error ? err.message : String(err));
    } finally {
      setReceiptLoading(false);
    }
  }, [saleResult]);

  const onBackFromReceipt = useCallback(() => {
    setShowReceipt(false);
  }, []);

  const onClearCart = useCallback(() => {
    if (
      cart.lines.length > 0 &&
      typeof window !== 'undefined' &&
      !window.confirm('Clear the cart? The current sale is not saved.')
    ) {
      return;
    }
    setCart(clearCart());
    setAttachedCustomer(null);
    setResults([]);
    setCustomerResults([]);
    setShowAddCustomer(false);
    setNotice('Cart cleared.');
    setError(null);
  }, [cart.lines.length]);

  const runReview = useCallback(async () => {
    const api = pos();
    if (!api) {
      setError('Checkout is unavailable in this context.');
      return;
    }
    setReviewing(true);
    try {
      const review = await unwrap(api.checkout.review(toReviewRequest(cart)));
      setCart((current) => withReview(current, review));
      setError(null);
      setNotice('Checkout reviewed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewing(false);
    }
  }, [cart]);

  const onCompleteCash = useCallback(async () => {
    if (completing || saleResult !== null) {
      return;
    }
    const api = pos();
    if (!api) {
      setError('Checkout is unavailable in this context.');
      return;
    }
    let request;
    try {
      request = toCompleteCashRequest(cart);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setCompleting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await unwrap(api.checkout.completeCash(request));
      setSaleResult(result);
      setNotice(null);
    } catch (err) {
      if (err instanceof IpcResultError && requiresReReview(err.code)) {
        setCart((current) => clearReview(current));
        setError(`${err.message} The cart is still here — Review it again to continue.`);
      } else if (err instanceof IpcResultError && isRetryableCommitFailure(err.code)) {
        setError(`${err.message} You can try Complete sale again.`);
      } else if (err instanceof IpcResultError && err.code === 'BUSINESS_NOT_CONFIGURED') {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setCompleting(false);
    }
  }, [cart, completing, saleResult]);

  const review: CheckoutReview | null = cart.review;
  const canReview =
    cart.lines.length > 0 && previewErrors.length === 0 && !reviewing && !saleResult;
  const cashReady = canCompleteCash(cart) && !completing && !saleResult;

  if (saleResult) {
    if (showReceipt) {
      return (
        <ReceiptPreview
          representation={receipt}
          loading={receiptLoading}
          error={receiptError}
          saleReceiptNumber={saleResult.receiptNumber}
          onBack={onBackFromReceipt}
          onNewSale={resetForNewSale}
        />
      );
    }
    return (
      <SaleSuccess
        result={saleResult}
        onViewReceipt={() => void onViewReceipt()}
        onNewSale={resetForNewSale}
      />
    );
  }

  return (
    <section className="checkout-page">
      <div className="checkout-add">
        <div className="products-toolbar">
          <input
            type="search"
            placeholder="Search products to add"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void runSearch();
              }
            }}
          />
          <button type="button" onClick={() => void runSearch()}>
            Search
          </button>
        </div>
        <div className="barcode-lookup">
          <input
            placeholder="Scan or type a barcode"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addFromBarcode();
              }
            }}
          />
          <button type="button" onClick={() => void addFromBarcode()}>
            Add by barcode
          </button>
        </div>
        {results.length > 0 && (
          <ul className="checkout-results">
            {results.map((product) => (
              <li key={product.id}>
                <span>
                  {product.name} — {formatCents(product.sellingPriceCents)} — stock{' '}
                  {product.quantityOnHand}
                </span>
                <button
                  type="button"
                  disabled={product.zeroStock || !product.isActive}
                  onClick={() => addFromResult(product)}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {notice && (
        <p className="products-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="product-form-error" role="alert">
          {error}
        </p>
      )}

      <table className="checkout-cart">
        <thead>
          <tr>
            <th>Product</th>
            <th>Condition</th>
            <th>Qty</th>
            <th>Listed</th>
            <th>Sold price</th>
            <th>Discount</th>
            <th>Line total</th>
            <th aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {cart.lines.map((line) => (
            <tr key={line.key}>
              <td>
                {line.name}
                <br />
                <span className="muted">
                  {line.brand} {line.model}
                </span>
              </td>
              <td>{line.condition}</td>
              <td>
                <input
                  key={`${line.key}-q-${line.quantity}`}
                  className="checkout-qty"
                  inputMode="numeric"
                  defaultValue={String(line.quantity)}
                  aria-label={`Quantity for ${line.name}`}
                  onBlur={(e) => onQuantityInput(line.key, e.target.value)}
                />
              </td>
              <td>{formatCents(line.listedPriceCents)}</td>
              <td>
                <input
                  key={`${line.key}-p-${line.soldPriceCents}`}
                  className="checkout-price"
                  inputMode="decimal"
                  defaultValue={priceInputValue(line.soldPriceCents)}
                  aria-label={`Sold price for ${line.name}`}
                  onBlur={(e) => onPriceInput(line.key, e.target.value)}
                />
              </td>
              <td>{formatCents(lineDiscountCents(line))}</td>
              <td>{formatCents(lineTotalCents(line))}</td>
              <td className="row-actions">
                <button type="button" onClick={() => mutate(removeLine(cart, line.key))}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {cart.lines.length === 0 && (
            <tr>
              <td colSpan={8}>The cart is empty. Search or scan a product to begin.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="checkout-meta">
        <section className="checkout-customer">
          <h4>Customer (optional)</h4>
          {attachedCustomer ? (
            <p>
              {attachedCustomer.name}
              {attachedCustomer.phone ? ` · ${attachedCustomer.phone}` : ''}{' '}
              <button type="button" onClick={detachCustomer}>
                Remove
              </button>
            </p>
          ) : (
            <>
              <div className="products-toolbar">
                <input
                  type="search"
                  placeholder="Search customers by name or phone"
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void runCustomerSearch();
                    }
                  }}
                />
                <button type="button" onClick={() => void runCustomerSearch()}>
                  Find
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddCustomer((v) => !v);
                    setAddCustomerError(null);
                  }}
                >
                  {showAddCustomer ? 'Cancel' : 'Add customer'}
                </button>
              </div>
              {showAddCustomer && (
                <div className="checkout-add-customer">
                  <label>
                    Name
                    <input
                      value={newCustomerName}
                      onChange={(e) => setNewCustomerName(e.target.value)}
                      aria-label="New customer name"
                    />
                  </label>
                  <label>
                    Phone (optional)
                    <input
                      value={newCustomerPhone}
                      onChange={(e) => setNewCustomerPhone(e.target.value)}
                      aria-label="New customer phone"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={savingCustomer}
                    onClick={() => void saveNewCustomer()}
                  >
                    {savingCustomer ? 'Saving…' : 'Save customer'}
                  </button>
                  {addCustomerError && (
                    <p className="product-form-error" role="alert">
                      {addCustomerError}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {customerResults.length > 0 && (
            <ul className="checkout-results">
              {customerResults.map((customer) => (
                <li key={customer.id}>
                  <span>
                    {customer.name}
                    {customer.phone ? ` · ${customer.phone}` : ''}
                  </span>
                  <button type="button" onClick={() => attachCustomer(customer)}>
                    Attach
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="checkout-payment">
          <h4>Payment method</h4>
          {PAYMENT_METHODS.map((method) => (
            <label key={method}>
              <input
                type="radio"
                name="checkout-payment-method"
                checked={cart.paymentMethod === method}
                onChange={() => choosePayment(method)}
              />
              {method === 'CASH' ? 'Cash' : 'Card'}
            </label>
          ))}
          <p className="field-hint">
            Cash sales complete here. Card checkout arrives in a later version.
          </p>
        </section>
      </div>

      <dl className="checkout-totals">
        <div>
          <dt>Subtotal (listed)</dt>
          <dd>{formatCents(preview.subtotalCents)}</dd>
        </div>
        <div>
          <dt>Discount</dt>
          <dd>{formatCents(preview.discountCents)}</dd>
        </div>
        <div>
          <dt>Taxable amount</dt>
          <dd>{formatCents(preview.taxableAmountCents)}</dd>
        </div>
        <div>
          <dt>Tax</dt>
          <dd>{review ? formatCents(review.taxCents) : 'reviewed at checkout'}</dd>
        </div>
        <div>
          <dt>Final total</dt>
          <dd>{review ? formatCents(review.totalCents) : 'reviewed at checkout'}</dd>
        </div>
      </dl>

      {previewErrors.length > 0 && (
        <ul className="checkout-preview-errors">
          {previewErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      <div className="checkout-actions">
        <button type="button" onClick={onClearCart} disabled={cart.lines.length === 0}>
          Clear cart
        </button>
        <button type="button" onClick={() => void runReview()} disabled={!canReview}>
          {reviewing ? 'Reviewing…' : 'Review checkout'}
        </button>
        {review && review.paymentMethod === 'CASH' ? (
          <button type="button" onClick={() => void onCompleteCash()} disabled={!cashReady}>
            {completing ? 'Completing…' : 'Complete sale (cash)'}
          </button>
        ) : (
          <button type="button" disabled title="Card checkout arrives in a later version">
            Complete sale (card — not available yet)
          </button>
        )}
      </div>

      {review && (
        <section className="checkout-review" role="status">
          <h4>Checkout reviewed{review.paymentMethod === 'CASH' ? ' — ready to complete' : ''}</h4>
          {review.paymentMethod === 'CARD' && (
            <p>Card completion is not available yet. No sale has been recorded.</p>
          )}
          <dl className="checkout-totals">
            <div>
              <dt>Subtotal</dt>
              <dd>{formatCents(review.subtotalCents)}</dd>
            </div>
            <div>
              <dt>Discount</dt>
              <dd>{formatCents(review.discountCents)}</dd>
            </div>
            <div>
              <dt>Taxable amount</dt>
              <dd>{formatCents(review.taxableAmountCents)}</dd>
            </div>
            <div>
              <dt>Tax ({(review.taxRateBps / 100).toFixed(2)}%)</dt>
              <dd>{formatCents(review.taxCents)}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{formatCents(review.totalCents)}</dd>
            </div>
            <div>
              <dt>Payment</dt>
              <dd>{review.paymentMethod === 'CASH' ? 'Cash' : 'Card'}</dd>
            </div>
            <div>
              <dt>Customer</dt>
              <dd>{review.customer ? review.customer.name : 'None'}</dd>
            </div>
          </dl>
          <p className="field-hint">
            Review fingerprint: <code>{review.fingerprint}</code>
          </p>
        </section>
      )}
    </section>
  );
}
