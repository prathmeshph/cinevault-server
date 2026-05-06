/**
 * CineVault Server
 * ─────────────────
 * Proxies Google Drive video files through FFmpeg,
 * transcoding any codec (H.265, HEVC, AV1, etc.)
 * to H.264/AAC MP4 on-the-fly so any browser can play it.
 *
 * Routes:
 *   GET /stream?fileId=XXX&token=YYY   → transcoded video stream
 *   GET /info?fileId=XXX&token=YYY     → file metadata (size, name, mime)
 *   GET /health                         → server health check
 */

const express  = require('express');
const cors     = require('cors');
const ffmpeg   = require('fluent-ffmpeg');
const ffmpegBin = require('ffmpeg-static');
const fetch    = require('node-fetch');

ffmpeg.setFfmpegPath(ffmpegBin);

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS: allow your GitHub Pages origin ──
const allowedOrigins = [
  'https://prathmeshph.github.io',
  'http://localhost',
  'http://127.0.0.1',
  /\.github\.io$/,
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow server-to-server / curl
    const ok = allowedOrigins.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    cb(ok ? null : new Error('CORS blocked: ' + origin), ok);
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// ══════════════════════════════════════════
//  Health check
// ══════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: ffmpegBin, time: new Date().toISOString() });
});

// ══════════════════════════════════════════
//  File metadata
// ══════════════════════════════════════════
app.get('/info', async (req, res) => {
  const { fileId, token } = req.query;
  if (!fileId || !token) return res.status(400).json({ error: 'fileId and token required' });

  try {
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,mimeType`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
//  Main streaming + transcoding endpoint
// ══════════════════════════════════════════
app.get('/stream', async (req, res) => {
  const { fileId, token } = req.query;
  if (!fileId || !token) return res.status(400).json({ error: 'fileId and token required' });

  // Validate token with a quick metadata check
  let fileMeta;
  try {
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,mimeType`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    fileMeta = await metaRes.json();
    if (fileMeta.error) return res.status(401).json({ error: 'Invalid token or file access denied' });
  } catch(e) {
    return res.status(500).json({ error: 'Could not reach Google Drive: ' + e.message });
  }

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  console.log(`[stream] Starting: ${fileMeta.name} (${formatSize(fileMeta.size)})`);

  // Set response headers for streaming video
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Allow seeking via byte-range (browser will request ranges)
  res.setHeader('Accept-Ranges', 'bytes');

  // ── FFmpeg transcode pipeline ──
  const command = ffmpeg()
    .input(driveUrl)
    .inputOptions([
      '-headers', `Authorization: Bearer ${token}`,
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
    ])
    // Video: transcode to H.264 baseline (universal browser support)
    .videoCodec('libx264')
    .outputOptions([
      '-preset', 'veryfast',     // Fast encode — low latency start
      '-crf', '23',              // Quality (18=high, 28=low, 23=balanced)
      '-profile:v', 'high',      // H.264 High profile
      '-level', '4.1',           // Compatibility level
      '-pix_fmt', 'yuv420p',     // Universal pixel format
      // Audio: transcode to AAC stereo
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',                // Stereo
      // MP4 streaming optimizations
      '-movflags', 'frag_keyframe+empty_moov+faststart+default_base_moof',
      '-frag_duration', '2000000', // 2 second fragments
      // Output format
      '-f', 'mp4',
    ])
    .on('start', cmd => console.log('[ffmpeg] started:', cmd.slice(0, 120) + '...'))
    .on('progress', p => {
      if (p.timemark) process.stdout.write(`\r[ffmpeg] ${p.timemark} | ${p.currentKbps || 0} kb/s`);
    })
    .on('error', (err, stdout, stderr) => {
      console.error('\n[ffmpeg] Error:', err.message);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    })
    .on('end', () => {
      console.log('\n[ffmpeg] Done:', fileMeta.name);
    });

  // Pipe FFmpeg output directly to HTTP response
  command.pipe(res, { end: true });

  // If client disconnects, kill FFmpeg
  req.on('close', () => {
    console.log('\n[stream] Client disconnected, killing FFmpeg');
    command.kill('SIGKILL');
  });
});

// ══════════════════════════════════════════
//  Start server
// ══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║       CineVault Server               ║
  ║  Listening on port ${String(PORT).padEnd(16)}║
  ║  FFmpeg: ${ffmpegBin ? 'found ✓' : 'NOT FOUND ✗'}                  ║
  ╚══════════════════════════════════════╝
  `);
});

function formatSize(bytes) {
  if (!bytes) return '?';
  const gb = bytes / 1073741824;
  return gb >= 1 ? gb.toFixed(2) + ' GB' : (bytes / 1048576).toFixed(0) + ' MB';
}
