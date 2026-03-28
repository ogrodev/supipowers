/**
 * Minimal ambient type declarations for bun:sqlite.
 *
 * We don't use the full bun-types package because it defines global test
 * runner types (describe, test, expect) that conflict with vitest.
 * This file provides just enough for EventStore and the doctor check.
 */
declare module "bun:sqlite" {
  type SQLQueryBindings = string | number | bigint | boolean | null | undefined | Buffer;

  interface Statement<Params extends SQLQueryBindings[] = SQLQueryBindings[]> {
    run(...params: Params): void;
    get(...params: Params): unknown;
    all(...params: Params): unknown[];
  }

  export class Database {
    constructor(filename: string);
    exec(sql: string): void;
    prepare<Params extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<Params>;
    transaction<T>(fn: () => T): () => T;
    close(): void;
  }
}
