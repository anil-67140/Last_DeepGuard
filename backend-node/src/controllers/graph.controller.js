const Transaction = require('../models/Transaction.model');

/**
 * Get network graph for a specific transaction
 * Uses MongoDB $graphLookup to trace money trails
 */
const getTransactionGraph = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const maxDepth = parseInt(req.query.depth) || 3;
    const { jobId } = req.query;

    // Find the starting transaction. transactionId is only unique within a
    // job (see Transaction.model.js), so scope by jobId when the caller
    // supplies it — otherwise fall back to "first match" for old links.
    const startTx = await Transaction.findOne(jobId ? { transactionId, jobId } : { transactionId });
    if (!startTx) return res.status(404).json({ error: 'Transaction not found' });

    // $graphLookup: trace all accounts connected from the sender
    const pipeline = [
      { $match: { account: startTx.account } },
      {
        $graphLookup: {
          from: 'transactions',
          startWith: '$account',
          connectFromField: 'account',
          connectToField: 'toAccount',
          as: 'connectedTransactions',
          maxDepth: maxDepth,
          depthField: 'depth',
          restrictSearchWithMatch: {
            jobId: startTx.jobId
          }
        }
      },
      { $limit: 1 }
    ];

    const result = await Transaction.aggregate(pipeline);
    const connected = result[0]?.connectedTransactions || [];

    // Build Cytoscape-compatible nodes and edges
    const nodesMap = new Map();
    const edges = [];

    // Add origin node
    nodesMap.set(startTx.account, {
      id: startTx.account,
      label: startTx.account,
      type: 'origin',
      bank: startTx.fromBank,
      riskScore: startTx.riskScore,
      riskLevel: startTx.riskLevel,
      txCount: 1,
      totalAmount: startTx.amountPaid,
      isFraud: startTx.isFraud
    });

    // Process connected transactions
    connected.forEach((tx) => {
      // Source node
      if (!nodesMap.has(tx.account)) {
        nodesMap.set(tx.account, {
          id: tx.account,
          label: tx.account,
          type: tx.isFraud ? 'suspicious' : 'normal',
          bank: tx.fromBank,
          riskScore: tx.riskScore,
          riskLevel: tx.riskLevel,
          txCount: 1,
          totalAmount: tx.amountPaid,
          isFraud: tx.isFraud,
          depth: tx.depth
        });
      } else {
        // Accumulate stats
        const existing = nodesMap.get(tx.account);
        existing.txCount += 1;
        existing.totalAmount += tx.amountPaid;
        if (tx.riskScore > existing.riskScore) {
          existing.riskScore = tx.riskScore;
          existing.riskLevel = tx.riskLevel;
          existing.isFraud = tx.isFraud;
        }
      }

      // Target node
      if (tx.toAccount && !nodesMap.has(tx.toAccount)) {
        nodesMap.set(tx.toAccount, {
          id: tx.toAccount,
          label: tx.toAccount,
          type: 'receiver',
          bank: tx.toBank,
          riskScore: 0,
          riskLevel: 'Low',
          txCount: 0,
          totalAmount: 0,
          isFraud: false,
          depth: (tx.depth || 0) + 1
        });
      }

      // Edge
      if (tx.account && tx.toAccount) {
        edges.push({
          id: tx.transactionId,
          source: tx.account,
          target: tx.toAccount,
          amount: tx.amountPaid,
          currency: tx.paymentCurrency,
          format: tx.paymentFormat,
          timestamp: tx.timestamp,
          riskScore: tx.riskScore,
          isFraud: tx.isFraud,
          fraudCategory: tx.fraudCategory,
          depth: tx.depth
        });
      }
    });

    const nodes = Array.from(nodesMap.values());

    // Detect circular flows using the AI Engine's own per-transaction
    // classification (fraudCategory === "Circular Transaction"), not a naive
    // self-loop check. A real circular flow is a multi-hop cycle
    // (A -> B -> C -> A), which never produces an edge where source===target
    // — the old check here effectively never fired, so the "Circular Flow"
    // legend entry was dead: every fraud node just fell through to plain red.
    const circularAccounts = new Set();
    edges.forEach(e => {
      if (e.fraudCategory === 'Circular Transaction') {
        if (e.source) circularAccounts.add(e.source);
        if (e.target) circularAccounts.add(e.target);
      }
    });
    nodes.forEach(n => {
      // Keep the origin node visually identifiable as the origin even if
      // it's also part of a circular flow — the stats bar's "Circular Flows"
      // count and the purple edges already surface that.
      if (circularAccounts.has(n.id) && n.type !== 'origin') n.type = 'circular';
    });

    res.json({
      originAccount: startTx.account,
      originBank: startTx.fromBank,
      depth: maxDepth,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      circularFlowCount: circularAccounts.size,
      nodes: nodes.slice(0, 500),    // Limit for rendering
      edges: edges.slice(0, 1000),
      riskSummary: {
        maxRisk: Math.max(...nodes.map(n => n.riskScore), 0),
        fraudNodes: nodes.filter(n => n.isFraud).length,
        totalAmount: edges.reduce((s, e) => s + (e.amount || 0), 0)
      }
    });

  } catch (err) {
    console.error('Graph error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Get top suspicious networks across a job
 */
const getJobNetworks = async (req, res) => {
  try {
    const { jobId } = req.params;

    // Aggregate top suspicious accounts
    const suspiciousAccounts = await Transaction.aggregate([
      { $match: { jobId, isFraud: true } },
      {
        $group: {
          _id: '$account',
          txCount: { $sum: 1 },
          totalAmount: { $sum: '$amountPaid' },
          maxRiskScore: { $max: '$riskScore' },
          fraudCategories: { $addToSet: '$fraudCategory' },
          banks: { $addToSet: '$fromBank' }
        }
      },
      { $sort: { maxRiskScore: -1 } },
      { $limit: 20 },
      {
        $project: {
          account: '$_id',
          txCount: 1,
          totalAmount: { $round: ['$totalAmount', 2] },
          maxRiskScore: 1,
          fraudCategories: 1,
          banks: 1,
          _id: 0
        }
      }
    ]);

    res.json({
      jobId,
      suspiciousAccounts,
      count: suspiciousAccounts.length
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getTransactionGraph, getJobNetworks };
