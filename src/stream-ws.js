const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

// Shared state — only one DJ can broadcast at a time
let ffmpegProc   = null;
let djSocket     = null;
let streamTitle  = 'DJ Live Session';
let browserIsLive = false;

function getStreamTitle()   { return streamTitle; }
function setStreamTitle(t)  { streamTitle = String(t).slice(0, 120); }
function isDJConnected()    { return djSocket !== null; }
function isBrowserLive()    { return browserIsLive; }

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

  fs.mkdirSync(hlsDir, { recursive: true });
  // Wipe stale segments from previous session so viewer doesn't load old content
  for (const f of fs.readdirSync(hlsDir)) {
    if (f.endsWith('.ts') || f.endsWith('.m3u8')) {
      try { fs.unlinkSync(path.join(hlsDir, f)); } catch (_) {}
    }
  }

  const hlsIndex   = path.join(hlsDir, 'index.m3u8').replace(/\\/g, '/');
  const hlsSegment = path.join(hlsDir, 'seg%03d.ts').replace(/\\/g, '/');

  const args = [
    '-loglevel', 'warning',
    // Robust timestamp handling — regenerate PTS, ignore DTS, skip corrupt packets
    '-fflags', '+genpts+discardcorrupt+igndts',
    '-err_detect', 'ignore_err',
    '-avoid_negative_ts', 'make_zero',     // reset negative timestamps to 0
    '-f', 'webm',
    '-i', 'pipe:0',
    // Video — force keyframe every 2s so HLS segments start cleanly at keyframes
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-b:v', '1500k', '-maxrate', '1800k', '-bufsize', '3600k',
    '-g', '50',
    '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    // Audio — resample asynchronously so timestamp gaps don't stall the encoder
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k',
    '-async', '1',                         // fix audio drift / small gaps silently
    // HLS — cut at keyframes (not wall clock), keep 8 segments for a bigger server buffer
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list',   // removed split_by_time: cuts at keyframes only
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', hlsSegment,
    hlsIndex
  ];

  ffmpegProc = spawn(ffmpeg, args);
  browserIsLive = true;

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
    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
    }, 2000);
    ffmpegProc = null;
  }
  browserIsLive = false;
}

module.exports = { setupStreamWS, getStreamTitle, setStreamTitle, isDJConnected, isBrowserLive };
