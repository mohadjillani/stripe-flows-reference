import pg from 'pg';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/stripedemo';
}

/**
 * Amounts come back from Postgres as strings, because a bigint does not fit in
 * a JavaScript number.
 *
 * node-postgres parses `bigint` (OID 20) to a string by default and it is right
 * to: `Number.MAX_SAFE_INTEGER` is about 9 quadrillion, and a currency with two
 * decimal places uses those digits faster than it looks. Converting through
 * `BigInt` keeps the value exact and makes the choice explicit at the boundary
 * rather than leaving a silent precision loss in the middle of a ledger.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => BigInt(value).toString());

export function createPool(url = databaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 8 });
}

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/**
 * Runs a function inside one transaction.
 *
 * Every webhook is processed inside one of these. The alternative — several
 * statements without a transaction — leaves an event marked processed whose
 * effects were only half applied, and nothing anywhere records which half.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
