const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

// Shared state — only one DJ can broadcast at a time
let ffmpegProc    = null;
let djSocket      = null;
let streamTitle   = 'DJ Live Session';
let browserIsLive = false;
let currentRecordingFile = null;
let sessionStartTime     = null;
let setlist              = [];   // [{ title, time }]

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
      ws.send(JSON.stringify({ type: 'error', msg: 'Another DJ is already live' }));
      ws.close(4002, 'Already broadcasting');
      return;
    }

    djSocket = ws;
    console.log('[DJ] Browser stream connected (mode: video)');

    startFFmpeg();

    ws.on('message', (chunk) => {
      if (ffmpegProc && ffmpegProc.stdin.writable) {
        try { ffmpegProc.stdin.write(chunk); } catch (_) {}
      }
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

function startFFmpeg() {
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

  // Recording filename: session_2026-03-24_1730.webm
  const now   = new Date();
  const stamp = now.getFullYear() + '-' +
    String(now.getMonth()+1).padStart(2,'0') + '-' +
    String(now.getDate()).padStart(2,'0') + '_' +
    String(now.getHours()).padStart(2,'0') +
    String(now.getMinutes()).padStart(2,'0');
  const recFile = path.join(recDir, `session_${stamp}.webm`).replace(/\\/g, '/');

  currentRecordingFile = recFile;
  sessionStartTime     = now.toISOString();
  setlist              = [];   // fresh setlist each session

  const args = [
    '-loglevel', 'warning',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-f', 'webm',
    '-i', 'pipe:0',
    // Video — force keyframe every 2s so HLS segments always start cleanly
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-b:v', '1500k', '-maxrate', '1800k', '-bufsize', '3600k',
    '-g', '50', '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    // Audio
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k',
    // HLS output
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '12',
    '-hls_flags', 'delete_segments+split_by_time',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', hlsSegment,
    hlsIndex,
    // Recording output — copy encoded stream to webm file
    '-c', 'copy',
    '-f', 'webm',
    recFile
  ];

  ffmpegProc = spawn(ffmpeg, args);
  browserIsLive = true;
  console.log('[REC] Recording to:', recFile);

  ffmpegProc.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log('[FFmpeg]', line.slice(0, 200));
  });

  ffmpegProc.on('close', (code) => {
    console.log(`[FFmpeg] exited (code ${code})`);
    ffmpegProc = null;
    browserIsLive = false;
  });

  ffmpegProc.stdin.on('error', () => {});
}

function stopFFmpeg() {
  if (ffmpegProc) {
    try { ffmpegProc.stdin.end(); } catch (_) {}
    const proc = ffmpegProc;
    setTimeout(() => { try { proc.kill('SIGTERM'); } catch (_) {} }, 2000);
    ffmpegProc = null;
  }
  browserIsLive = false;
  if (currentRecordingFile) {
    console.log('[REC] Session saved:', currentRecordingFile);
    currentRecordingFile = null;
  }
}

// Called by server graceful-shutdown — stops FFmpeg cleanly before process exits
function stopFFmpegOnExit() { stopFFmpeg(); }

module.exports = {
  setupStreamWS, getStreamTitle, setStreamTitle,
  isDJConnected, isBrowserLive,
  getCurrentRecording, getSessionStartTime,
  getSetlist, clearSetlist, stopFFmpegOnExit,
};
