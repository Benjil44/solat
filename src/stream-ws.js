const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

// Shared state — only one DJ can broadcast at a time
let ffmpegProc    = null;
let djSocket      = null;
let streamTitle   = 'DJ Live Session';
let browserIsLive = false;
let broadcastMode = 'video';     // 'video' | 'audio'
let currentRecordingFile = null;
let sessionStartTime     = null;
let setlist              = [];   // [{ title, time }] — current session only

// ── Persistent session history ────────────────────────────────────────────────
const HISTORY_PATH = path.join(__dirname, '../data/session-history.json');

function loadSessionHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { return []; }
}

function saveSessionToHistory(start, tracks) {
  if (!tracks.length) return;   // skip empty sessions
  const history = loadSessionHistory();
  history.unshift({ start, tracks });             // newest first
  if (history.length > 100) history.length = 100; // keep last 100 sessions
  try {
    const tmp = HISTORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, HISTORY_PATH);
  } catch (e) { console.error('[HISTORY] Save failed:', e.message); }
}

function getSessionHistory() { return loadSessionHistory(); }

function getBroadcastMode()    { return broadcastMode; }
function isManifestReady() {
  if (!browserIsLive) return false;
  const streamKey = process.env.STREAM_KEY || 'djlive';
  const hlsDir    = path.join(__dirname, '../media/live', streamKey);
  try { return fs.existsSync(path.join(hlsDir, 'index.m3u8')); } catch { return false; }
}
function getStreamTitle()      { return streamTitle; }
function setStreamTitle(t) {
  streamTitle = String(t).slice(0, 120);
  setlist.push({ title: streamTitle, time: new Date().toISOString() });
}
function isDJConnected()       { return djSocket !== null; }
function isBrowserLive()       { return browserIsLive; }
function getCurrentRecording() { return currentRecordingFile; }
function getSessionStartTime() { return sessionStartTime; }
function getSetlist()          { return setlist; }
function clearSetlist()        { setlist = []; }

function setupStreamWS(wss) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const key  = url.searchParams.get('key');

    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Unauthorized' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    if (djSocket) {
      // readyState: 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
      if (djSocket.readyState <= 1) {
        // Genuinely live — reject
        ws.send(JSON.stringify({ type: 'error', msg: 'Another DJ is already live' }));
        ws.close(4002, 'Already broadcasting');
        return;
      }
      // Stale / closing socket from a previous session — clean it up and allow reconnect
      console.log('[DJ] Clearing stale djSocket (readyState=%d)', djSocket.readyState);
      stopFFmpeg();
      djSocket = null;
    }

    const mode = url.searchParams.get('mode') || 'video';
    broadcastMode = (mode === 'audio') ? 'audio' : 'video';

    djSocket = ws;
    console.log('[DJ] Browser stream connected (mode: %s)', broadcastMode);

    startFFmpeg(broadcastMode);

    ws.on('message', (chunk) => {
      if (!ffmpegProc || !ffmpegProc.stdin.writable) return;
      try {
        // write() returns false when the internal buffer is full (backpressure).
        // Pause WebSocket reads until FFmpeg drains its buffer to avoid unbounded memory growth.
        const ok = ffmpegProc.stdin.write(chunk);
        if (!ok) {
          ws.pause();
          ffmpegProc.stdin.once('drain', () => { try { ws.resume(); } catch (_) {} });
        }
      } catch (_) {}
    });

    ws.on('close', () => {
      console.log('[DJ] Browser stream disconnected');
      stopFFmpeg();
      djSocket = null;
    });

    ws.on('error', (err) => {
      console.error('[DJ] WS error:', err.message);
      stopFFmpeg();
      djSocket = null;
    });
  });
}

function startFFmpeg(mode = 'video') {
  const streamKey = process.env.STREAM_KEY || 'djlive';
  const ffmpeg    = process.env.FFMPEG_PATH || 'ffmpeg';
  const hlsDir    = path.join(__dirname, '../media/live', streamKey);
  const recDir    = path.join(__dirname, '../media/recordings');

  fs.mkdirSync(hlsDir, { recursive: true });
  fs.mkdirSync(recDir, { recursive: true });

  // Wipe stale segments from previous session so viewer doesn't load old content
  for (const f of fs.readdirSync(hlsDir)) {
    if (f.endsWith('.ts') || f.endsWith('.m3u8')) {
      try { fs.unlinkSync(path.join(hlsDir, f)); } catch (_) {}
    }
  }

  const hlsIndex   = path.join(hlsDir, 'index.m3u8').replace(/\\/g, '/');
  const hlsSegment = path.join(hlsDir, 'seg%03d.ts').replace(/\\/g, '/');

  // Recording filename: session_2026-03-24_1730.mkv
  const now   = new Date();
  const stamp = now.getFullYear() + '-' +
    String(now.getMonth()+1).padStart(2,'0') + '-' +
    String(now.getDate()).padStart(2,'0') + '_' +
    String(now.getHours()).padStart(2,'0') +
    String(now.getMinutes()).padStart(2,'0');
  const recFile = path.join(recDir, `session_${stamp}.mkv`).replace(/\\/g, '/');

  currentRecordingFile = recFile;
  sessionStartTime     = now.toISOString();
  setlist              = [];   // fresh setlist each session

  const hlsCommon = [
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '30',          // keep 60s of segments so late-joiners don't miss them
    '-hls_flags', 'delete_segments+split_by_time',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', hlsSegment,
    hlsIndex,
  ];

  let args;
  if (mode === 'audio') {
    args = [
      '-loglevel', 'warning',
      '-fflags', '+genpts+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-f', 'webm',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k',
      ...hlsCommon,
      '-vn', '-c:a', 'copy',
      '-f', 'matroska',
      recFile,
    ];
  } else {
    // Use NVENC (GPU) if explicitly requested via env, otherwise libx264 (CPU, always available)
    const useNvenc = (process.env.FFMPEG_ENCODER || '').toLowerCase() === 'nvenc';
    const videoArgs = useNvenc
      ? ['-c:v', 'h264_nvenc', '-preset', 'll', '-rc', 'cbr', '-bf', '0',
         '-b:v', '1500k', '-maxrate', '1800k', '-bufsize', '3600k', '-g', '50']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
         '-sc_threshold', '0', '-bf', '0',
         '-b:v', '1500k', '-maxrate', '1800k', '-bufsize', '3600k', '-g', '50'];
    args = [
      '-loglevel', 'warning',
      '-fflags', '+genpts+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-f', 'webm',
      '-i', 'pipe:0',
      ...videoArgs,
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k',
      ...hlsCommon,
      '-c', 'copy', '-f', 'matroska', recFile,
    ];
  }

  ffmpegProc = spawn(ffmpeg, args, { windowsHide: true });
  browserIsLive = true;
  console.log('[REC] Recording to:', recFile);

  let stderrBuf = '';
  ffmpegProc.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line) { console.log('[FFmpeg]', line.slice(0, 200)); stderrBuf += line + '\n'; }
  });

  ffmpegProc.on('close', (code) => {
    console.log(`[FFmpeg] exited (code ${code})`);
    const wasLive    = browserIsLive;
    const savedStderr = stderrBuf;
    ffmpegProc    = null;
    browserIsLive = false;
    stderrBuf     = '';

    // Unexpected crash while DJ is still connected — tell the client so the button resets
    if (code !== 0 && wasLive && djSocket && djSocket.readyState === 1 /*OPEN*/) {
      try { djSocket.send(JSON.stringify({ type: 'error', msg: `Stream encoder crashed (exit ${code}) — check server logs` })); } catch (_) {}
      try { djSocket.close(1011, 'Encoder failure'); } catch (_) {}
      djSocket = null;
    }
  });

  ffmpegProc.stdin.on('error', () => {});
}

function stopFFmpeg() {
  if (ffmpegProc) {
    try { ffmpegProc.stdin.end(); } catch (_) {}
    const proc = ffmpegProc;
    // Give FFmpeg 3s to flush + finalize the recording, then force-kill if still running
    const killTimer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch (_) {} }, 3000);
    // Cancel the force-kill if FFmpeg exits cleanly on its own
    proc.once('close', () => clearTimeout(killTimer));
    ffmpegProc = null;
  }
  browserIsLive = false;
  if (currentRecordingFile) {
    console.log('[REC] Session saved:', currentRecordingFile);
    currentRecordingFile = null;
  }
  // Persist this session's setlist to history
  if (sessionStartTime && setlist.length) {
    saveSessionToHistory(sessionStartTime, [...setlist]);
  }
  sessionStartTime = null;
  setlist = [];
}

// Called by server graceful-shutdown — stops FFmpeg cleanly before process exits
function stopFFmpegOnExit() { stopFFmpeg(); }

module.exports = {
  setupStreamWS, getStreamTitle, setStreamTitle,
  isDJConnected, isBrowserLive, getBroadcastMode, isManifestReady,
  getCurrentRecording, getSessionStartTime,
  getSetlist, clearSetlist, stopFFmpegOnExit,
  getSessionHistory,
};
