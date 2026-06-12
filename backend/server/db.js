const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
    },
});

pool.on('error', err => {
    console.error('[DB] Unexpected error on idle client', err);
    process.exit(-1);
});

// Initialize database tables
async function initializeDatabase() {
    try {
        // Bot Ideas table
        await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_ideas (
        id SERIAL PRIMARY KEY,
        bot_name VARCHAR(255) NOT NULL,
        strategy_description TEXT NOT NULL,
        submitted_by VARCHAR(255) NOT NULL,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_runs INTEGER DEFAULT 0,
        profits INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        profit_amount DECIMAL(15, 2),
        loss_amount DECIMAL(15, 2),
        bot_xml TEXT,
        bot_xml_filename VARCHAR(255),
        developed_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // Scanner signals table
        await pool.query(`
      CREATE TABLE IF NOT EXISTS scanner_signals (
        id SERIAL PRIMARY KEY,
        scan_time TIMESTAMP NOT NULL,
        next_scan_time TIMESTAMP,
        market_symbol VARCHAR(50) NOT NULL,
        market_label VARCHAR(100),
        group_name VARCHAR(100),
        trade_type VARCHAR(50),
        contract_type VARCHAR(50),
        direction VARCHAR(50),
        barrier INTEGER,
        confidence DECIMAL(5, 2),
        edge DECIMAL(10, 4),
        z_score DECIMAL(10, 4),
        recommended_runs INTEGER,
        signal_label VARCHAR(255),
        tick_count INTEGER,
        is_valid BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // Bot statistics table
        await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_stats (
        id SERIAL PRIMARY KEY,
        bot_id VARCHAR(255) NOT NULL UNIQUE,
        total_runs INTEGER DEFAULT 0,
        profits INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        profit_amount DECIMAL(15, 2),
        loss_amount DECIMAL(15, 2),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        console.log('[DB] Database connection successful');
        console.log('[DB] Database tables verified / created.');
    } catch (err) {
        console.error('[DB] Error initializing database:', err);
        throw err;
    }
}

module.exports = { pool, initializeDatabase };
