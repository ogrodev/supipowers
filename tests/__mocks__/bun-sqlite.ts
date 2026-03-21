/**
 * Shim that exposes better-sqlite3 with the bun:sqlite API surface.
 *
 * bun:sqlite has `db.run(sql, params)` which better-sqlite3 lacks — we add it
 * by delegating to `db.prepare(sql).run(...params)`.
 */
import BetterSqlite3 from "better-sqlite3";

export class Database {
  private db: BetterSqlite3.Database;

  constructor(path: string) {
    this.db = new BetterSqlite3(path);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params?: unknown[]): void {
    const stmt = this.db.prepare(sql);
    if (params) {
      stmt.run(...params);
    } else {
      stmt.run();
    }
  }

  prepare(sql: string) {
    const stmt = this.db.prepare(sql);
    return {
      all(...params: unknown[]) {
        return stmt.all(...params);
      },
      get(...params: unknown[]) {
        return stmt.get(...params);
      },
      run(...params: unknown[]) {
        return stmt.run(...params);
      },
    };
  }

  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn) as () => T;
  }

  close(): void {
    this.db.close();
  }
}
