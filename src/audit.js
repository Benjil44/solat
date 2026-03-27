const fs   = require('fs');
const path = require('path');

const AUDIT_PATH = path.join(__dirname, '../data/audit.json');
const MAX_ENTRIES = 500;

function logAudit(actor, action, details = {}) {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')); } catch {}
  log.push({ at: new Date().toISOString(), actor, action, ...details });
  if (log.length > MAX_ENTRIES) log = log.slice(-MAX_ENTRIES);
  try {
    const tmp = AUDIT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(log));
    fs.renameSync(tmp, AUDIT_PATH);
  } catch {}
}

function getAuditLog(limit = 200) {
  try {
    const log = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    return log.slice(-limit).reverse(); // newest first
  } catch { return []; }
}

module.exports = { logAudit, getAuditLog };
