import { describe, expect, it } from 'vitest';
import { assertTestDatabase } from '../helpers/db.js';

describe('assertTestDatabase', () => {
  it('accepts names ending with _test', () => {
    expect(() => assertTestDatabase('store_test')).not.toThrow();
    expect(() => assertTestDatabase('store_migrator_test')).not.toThrow();
  });

  it.each(['store_dev', 'store', 'TEST_DB_STORE', 'store_test_old', '', 'production'])(
    'rejects %j',
    (name) => {
      expect(() => assertTestDatabase(name)).toThrow(/_test/);
    },
  );
});
