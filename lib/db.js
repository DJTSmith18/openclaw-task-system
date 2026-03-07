'use strict';

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

class Database {
  constructor(opts = {}) {
    this._pool = new Pool({
      host:     opts.host     || 'localhost',
      port:     opts.port     || 5432,
      database: opts.database || 'openclaw_tasks',
      user:     opts.user     || 'openclaw',
      password: opts.password || '',
      max:      opts.maxConnections || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this._pool.on('error', (err) => {
      console.error('[task-system/db] unexpected pool error:', err.message);
    });

    const tz = opts.timezone || 'America/Toronto';
    this._pool.on('connect', (client) => {
      client.query(`SET timezone = '${tz}'`);
    });
  }

  // ── Raw query ──────────────────────────────────────────────────────────────

  async query(text, params) {
    return this._pool.query(text, params);
  }

  // ── Convenience helpers ────────────────────────────────────────────────────

  async getOne(text, params) {
    const { rows } = await this._pool.query(text, params);
    return rows[0] || null;
  }

  async getMany(text, params) {
    const { rows } = await this._pool.query(text, params);
    return rows;
  }

  async getCount(text, params) {
    const { rows } = await this._pool.query(text, params);
    return parseInt(rows[0]?.count ?? '0', 10);
  }

  /**
   * Insert a row and return the full inserted row.
   * @param {string} table - Table name
   * @param {object} data  - Column→value map
   * @returns {object} Inserted row
   */
  async insert(table, data) {
    const keys = Object.keys(data);
    const vals = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`);

    const text = `INSERT INTO ${table} (${keys.join(', ')})
                  VALUES (${placeholders.join(', ')})
                  RETURNING *`;
    const { rows } = await this._pool.query(text, vals);
    return rows[0];
  }

  /**
   * Update rows matching a WHERE clause.
   * @param {string} table   - Table name
   * @param {object} data    - Column→value map for SET
   * @param {string} where   - WHERE clause with $N placeholders starting after data params
   * @param {any[]}  wParams - Params for WHERE clause
   * @returns {object[]} Updated rows
   */
  async update(table, data, where, wParams = []) {
    const keys = Object.keys(data);
    const vals = Object.values(data);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const offset = keys.length;

    // Renumber WHERE params
    const adjustedWhere = where.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n, 10) + offset}`);

    const text = `UPDATE ${table}
                  SET ${setClauses.join(', ')}
                  WHERE ${adjustedWhere}
                  RETURNING *`;
    const { rows } = await this._pool.query(text, [...vals, ...wParams]);
    return rows;
  }

  /**
   * Delete rows matching a WHERE clause.
   * @param {string} table   - Table name
   * @param {string} where   - WHERE clause
   * @param {any[]}  params  - Params for WHERE clause
   * @returns {number} Number of deleted rows
   */
  async delete(table, where, params = []) {
    const { rowCount } = await this._pool.query(
      `DELETE FROM ${table} WHERE ${where}`,
      params
    );
    return rowCount;
  }

  // ── Transactions ───────────────────────────────────────────────────────────

  async transaction(fn) {
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Health check ───────────────────────────────────────────────────────────

  async ping() {
    try {
      const { rows } = await this._pool.query('SELECT 1 AS ok');
      return { ok: true, pool: { total: this._pool.totalCount, idle: this._pool.idleCount, waiting: this._pool.waitingCount } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── Schema migration ──────────────────────────────────────────────────────

  async runSchema() {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await this._pool.query(sql);
  }

  async runMigrations() {
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) return [];

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const applied = [];
    for (const file of files) {
      const version = parseInt(file.split('_')[0], 10);
      const exists = await this.getOne(
        'SELECT 1 FROM schema_version WHERE version = $1',
        [version]
      );
      if (exists) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await this._pool.query(sql);
      await this.insert('schema_version', {
        version,
        description: file,
      });
      applied.push(file);
    }
    return applied;
  }

  // ── Shutdown ───────────────────────────────────────────────────────────────

  async close() {
    await this._pool.end();
  }
}

module.exports = { Database };
