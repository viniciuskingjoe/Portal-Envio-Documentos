// Conexão com o SQL Server (KINGEJOE). Mesmo padrão de pool usado no
// Portal-Saldo: uma única ConnectionPool reaproveitada por todo o processo.
import sql from 'mssql';

let poolPromise;

function readEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function readBool(names, fallback) {
  const value = readEnv(...names).toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'sim'].includes(value);
}

function readInt(names, fallback) {
  const value = Number(readEnv(...names));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function buildConfig() {
  const server = readEnv('SQLSERVER_HOST');
  const database = readEnv('SQLSERVER_DATABASE');
  const user = readEnv('SQLSERVER_USER');
  const password = readEnv('SQLSERVER_PASSWORD');

  if (!server || !database || !user || !password) {
    throw new Error('Configure SQLSERVER_HOST/DATABASE/USER/PASSWORD no .env.');
  }

  return {
    server,
    database,
    user,
    password,
    port: readInt(['SQLSERVER_PORT'], 1433),
    pool: {
      max: readInt(['SQLSERVER_POOL_MAX'], 10),
      min: 0,
      idleTimeoutMillis: readInt(['SQLSERVER_POOL_IDLE_MS'], 30000),
    },
    options: {
      // Instância on-premise sem certificado válido: criptografa mas não valida.
      encrypt: readBool(['SQLSERVER_ENCRYPT'], false),
      trustServerCertificate: readBool(['SQLSERVER_TRUST_CERTIFICATE'], true),
    },
  };
}

export async function getPool() {
  if (!poolPromise) {
    const pool = new sql.ConnectionPool(buildConfig());
    pool.on('error', err => {
      console.error('Erro no pool do SQL Server:', err.message);
      poolPromise = undefined; // força reconexão na próxima chamada
    });
    poolPromise = pool.connect().catch(err => {
      poolPromise = undefined;
      throw err;
    });
  }
  return poolPromise;
}

/**
 * Executa uma query parametrizada.
 * Os parâmetros são sempre enviados como bind (nunca concatenados), o que
 * elimina injeção de SQL.
 *
 *   query('SELECT * FROM x WHERE ID = @id', { id: 10 })
 */
export async function query(text, params = {}) {
  const pool = await getPool();
  const request = pool.request();
  for (const [key, value] of Object.entries(params)) {
    request.input(key, value);
  }
  const result = await request.query(text);
  return result.recordset;
}

/** Primeira linha do resultado, ou undefined. */
export async function queryOne(text, params = {}) {
  const rows = await query(text, params);
  return rows[0];
}

/**
 * Roda fn dentro de uma transação. Recebe um helper com a mesma assinatura de
 * query, amarrado à transação. Commit no sucesso, rollback em erro.
 *
 *   await transaction(async run => {
 *     await run('UPDATE ...', { id });
 *     await run('INSERT ...', { ... });
 *   });
 */
export async function transaction(fn) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  const run = async (text, params = {}) => {
    const request = new sql.Request(tx);
    for (const [key, value] of Object.entries(params)) {
      request.input(key, value);
    }
    const result = await request.query(text);
    return result.recordset;
  };
  try {
    const out = await fn(run);
    await tx.commit();
    return out;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function closePool() {
  if (!poolPromise) return;
  const pool = await poolPromise.catch(() => null);
  poolPromise = undefined;
  if (pool) await pool.close();
}

export { sql };
