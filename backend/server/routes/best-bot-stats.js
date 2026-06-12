const express = require('express');
const { pool } = require('../db');
const router = express.Router();

// GET best bot statistics
router.get('/', async (req, res, next) => {
    try {
        const result = await pool.query(`
      SELECT 
        bot_id,
        total_runs,
        profits,
        losses,
        profit_amount,
        loss_amount,
        CASE 
          WHEN total_runs > 0 THEN ROUND((profits::numeric / total_runs) * 100, 2)
          ELSE 0 
        END as win_rate,
        CASE 
          WHEN total_runs > 0 THEN ROUND((losses::numeric / total_runs) * 100, 2)
          ELSE 0 
        END as loss_rate
      FROM bot_stats
      ORDER BY profits DESC, total_runs DESC
      LIMIT 20
    `);

        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// GET single bot stats
router.get('/:botId', async (req, res, next) => {
    try {
        const result = await pool.query(
            `SELECT 
        bot_id,
        total_runs,
        profits,
        losses,
        profit_amount,
        loss_amount,
        CASE 
          WHEN total_runs > 0 THEN ROUND((profits::numeric / total_runs) * 100, 2)
          ELSE 0 
        END as win_rate
      FROM bot_stats
      WHERE bot_id = $1`,
            [req.params.botId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Bot stats not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        next(error);
    }
});

// POST update bot stats (internal use)
router.post('/:botId', async (req, res, next) => {
    try {
        const { total_runs, profits, losses, profit_amount, loss_amount } = req.body;

        const result = await pool.query(
            `INSERT INTO bot_stats (bot_id, total_runs, profits, losses, profit_amount, loss_amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (bot_id) DO UPDATE SET
         total_runs = $2,
         profits = $3,
         losses = $4,
         profit_amount = $5,
         loss_amount = $6,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
            [req.params.botId, total_runs || 0, profits || 0, losses || 0, profit_amount, loss_amount]
        );

        res.json(result.rows[0]);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
