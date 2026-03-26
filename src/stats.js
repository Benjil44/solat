// In-memory session stats — reset on each stream session start.
let _peakViewers   = 0;
let _totalMessages = 0;
let _totalRequests = 0;
let _sessionStart  = null;

function resetStats() {
  _peakViewers   = 0;
  _totalMessages = 0;
  _totalRequests = 0;
  _sessionStart  = new Date().toISOString();
}

function recordViewerCount(n) {
  if (n > _peakViewers) _peakViewers = n;
}

function incrementMessages() { _totalMessages++; }
function incrementRequests()  { _totalRequests++;  }

function getStats() {
  return {
    peakViewers:   _peakViewers,
    totalMessages: _totalMessages,
    totalRequests: _totalRequests,
    sessionStart:  _sessionStart,
  };
}

module.exports = { resetStats, recordViewerCount, incrementMessages, incrementRequests, getStats };
