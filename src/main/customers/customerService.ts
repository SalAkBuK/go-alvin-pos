import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  CustomerPurchase,
  CustomerRecord,
  CustomerSearchOptions,
} from '../../shared/customers';
import { appErrors } from '../shared/appError';
import * as repo from './customerRepository';
import {
  normalizePhone,
  validateCreateCustomer,
  validateCustomerId,
  validateCustomerSearchQuery,
  validateUpdateCustomer,
} from './customerValidation';

/**
 * Customer business behaviour (`ARCHITECTURE.md §10-11`, `POS_WORKFLOWS.md §24-25`,
 * `REQ-CUST-*`).
 *
 * Validates every payload through `customerValidation`, owns the create/update
 * writes, and exposes read-only list/search/get/purchase-history. It never
 * touches Electron, IPC, or the renderer and has no network dependency, so it
 * is unit-testable against a real SQLite connection with nothing else running.
 * V1 has no customer deletion.
 */

export interface CustomerServiceDeps {
  readonly db: Database.Database;
  /** ISO-8601 UTC clock; injectable for deterministic tests. */
  readonly now?: () => string;
}

export interface CustomerService {
  create(raw: unknown): CustomerRecord;
  update(idRaw: unknown, raw: unknown): CustomerRecord;
  list(): readonly CustomerRecord[];
  search(options: CustomerSearchOptions): readonly CustomerRecord[];
  get(idRaw: unknown): CustomerRecord;
  purchaseHistory(idRaw: unknown): readonly CustomerPurchase[];
}

export function createCustomerService(deps: CustomerServiceDeps): CustomerService {
  const { db } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  function requireCustomer(id: string): CustomerRecord {
    const customer = repo.findCustomerById(db, id);
    if (!customer) {
      throw appErrors.customerNotFound();
    }
    return customer;
  }

  return {
    create(raw: unknown): CustomerRecord {
      const fields = validateCreateCustomer(raw);
      const id = randomUUID();
      const createdAt = now();
      db.transaction(() => {
        repo.insertCustomer(db, {
          id,
          name: fields.name,
          phone: fields.phone,
          phoneNormalized: fields.phoneNormalized,
          createdAt,
        });
      }).immediate();
      return requireCustomer(id);
    },

    update(idRaw: unknown, raw: unknown): CustomerRecord {
      const id = validateCustomerId(idRaw);
      const fields = validateUpdateCustomer(raw);
      const updatedAt = now();
      db.transaction(() => {
        requireCustomer(id);
        repo.updateCustomer(db, {
          id,
          name: fields.name,
          // `phone_normalized` is always recomputed from the new phone value.
          phone: fields.phone,
          phoneNormalized: fields.phoneNormalized,
          updatedAt,
        });
      }).immediate();
      return requireCustomer(id);
    },

    list(): readonly CustomerRecord[] {
      return repo.listCustomers(db);
    },

    search(options: CustomerSearchOptions): readonly CustomerRecord[] {
      const query = validateCustomerSearchQuery(options.query);
      return repo.searchCustomers(db, {
        nameQuery: query,
        phoneDigits: normalizePhone(query),
      });
    },

    get(idRaw: unknown): CustomerRecord {
      return requireCustomer(validateCustomerId(idRaw));
    },

    purchaseHistory(idRaw: unknown): readonly CustomerPurchase[] {
      const id = validateCustomerId(idRaw);
      requireCustomer(id);
      return repo.listPurchaseHistory(db, id);
    },
  };
}
