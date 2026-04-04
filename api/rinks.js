// api/rinks.js
// Serves rinks.json as a JSON endpoint
// CommonJS (module.exports) — required for Vercel without "type":"module"

const fs   = require('fs');
const path = require('path');

module.exports = function handler(req, res) {
  try {
    const data = fs.readFileSync(path.join(__dirname, '../data/rinks.json'), 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(data);
  } catch (err) {
    res.status(500).json({ error: 'Could not load rinks.json', details: err.message });
  }
};
