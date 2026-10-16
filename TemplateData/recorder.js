// Think-aloud session recorder: captures the game tab, webcam and microphone in sync
// while the Unity WebGL build runs underneath, plus a JSON log of markers and events.
(() => {
  'use strict';

  // MP4 first: MediaRecorder WebM files often lack a duration, which breaks seeking
  // in analysis tools. isTypeSupported picks the first one this browser can do.
  const VIDEO_TYPES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  // For streams with no audio track (e.g. screen only, without tab audio). Naming an audio codec
  // for a video-only stream can leave the recorder waiting for audio that never arrives.
  const VIDEO_ONLY_TYPES = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const AUDIO_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm'];
  const BITRATES = { screen: 3000000, webcam: 1000000, audio: 128000 };
  const CHUNK_MS = 1000;
  // How long to wait for a recorder to report it has stopped before saving what it has
  const STOP_TIMEOUT_MS = 8000;
  // Not used by the game's controls, so it can be pressed without leaving pointer lock
  const MARK_KEY = 'Backquote';

  const $ = (id) => document.getElementById(id);
  const ui = {
    canvas: $('unity-canvas'),
    setup: $('setup'),
    form: $('setup-form'),
    useScreen: $('use-screen'),
    useCamera: $('use-camera'),
    useMic: $('use-mic'),
    showPreview: $('show-preview'),
    folderOption: $('folder-option'),
    folderRow: $('folder-row'),
    saveFolder: $('save-folder'),
    saveDownload: $('save-download'),
    chooseFolder: $('choose-folder'),
    folderName: $('folder-name'),
    consent: $('consent'),
    error: $('setup-error'),
    start: $('start-btn'),
    playOnly: $('play-only'),
    loadStatus: $('load-status'),
    bar: $('bar'),
    elapsed: $('elapsed'),
    mark: $('mark-btn'),
    markCount: $('mark-count'),
    stop: $('stop-btn'),
    preview: $('webcam-preview'),
    done: $('done'),
    doneTitle: $('done-title'),
    summary: $('done-summary'),
    files: $('done-files'),
    downloadAll: $('download-all'),
    newSession: $('new-session'),
  };

  // Unity captures every key event on the page and cancels it, so nothing could be typed
  // into the setup form. This runs before Unity registers its own listeners, so stopping
  // events aimed at the panels here keeps them away from Unity while typing still works.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(type, (event) => {
      if (event.target instanceof Element && event.target.closest('.overlay')) event.stopImmediatePropagation();
    }, true);
  }

  const canSaveToFolder = typeof window.showDirectoryPicker === 'function';
  let folder = null; // FileSystemDirectoryHandle chosen during setup
  let session = null; // the active or finished session
  let gameLoadedAt = null; // Date the Unity instance finished loading

  // ---------- setup ----------

  if (canSaveToFolder) {
    ui.saveFolder.checked = true;
  } else {
    ui.folderOption.hidden = true;
    ui.folderRow.hidden = true;
    ui.saveDownload.checked = true;
  }

  const unsupported = !window.isSecureContext
    ? 'This page must be served from https:// or http://localhost for the browser to allow recording.'
    : !navigator.mediaDevices || typeof window.MediaRecorder !== 'function'
      ? 'This browser cannot record media. Use a recent version of Chrome or Edge.'
      : null;
  if (unsupported) {
    showError(unsupported);
    ui.start.disabled = true;
  }

  // Neither start button works until the game has loaded, so nobody lands on an empty canvas
  ui.start.disabled = true;
  ui.start.textContent = 'Loading game…';
  ui.playOnly.disabled = true;

  ui.saveFolder.addEventListener('change', updateFolderRow);
  ui.saveDownload.addEventListener('change', updateFolderRow);
  function updateFolderRow() {
    ui.folderRow.classList.toggle('disabled', !ui.saveFolder.checked);
  }
  updateFolderRow();

  ui.chooseFolder.addEventListener('click', async () => {
    try {
      folder = await window.showDirectoryPicker({ id: 'think-aloud', mode: 'readwrite' });
      ui.folderName.textContent = folder.name;
      ui.folderName.classList.remove('muted');
      ui.saveFolder.checked = true;
      updateFolderRow();
    } catch (err) {
      if (err.name !== 'AbortError') showError(`Couldn't open that folder: ${err.message}`);
    }
  });

  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    if (!gameLoadedAt) return showError('The game is still loading. Please wait for it to finish.');

    const problem = !ui.useScreen.checked && !ui.useCamera.checked && !ui.useMic.checked ? 'Choose at least one thing to record.'
      : ui.saveFolder.checked && !folder ? 'Choose a folder to save to, or switch to downloading at the end.'
      : !ui.consent.checked ? "Confirm the participant's consent before recording."
      : null;
    if (problem) return showError(problem);

    ui.start.disabled = true;
    ui.start.textContent = 'Waiting for permissions…';
    const acquired = [];
    try {
      // getDisplayMedia needs the click's user activation, so ask for it first
      let screen = null;
      if (ui.useScreen.checked) {
        screen = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30 }, displaySurface: 'browser' },
          audio: { suppressLocalAudioPlayback: false },
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
          surfaceSwitching: 'exclude',
          systemAudio: 'include',
        });
        acquired.push(screen);
      }

      let camMic = null;
      if (ui.useCamera.checked || ui.useMic.checked) {
        camMic = await navigator.mediaDevices.getUserMedia({
          video: ui.useCamera.checked
            ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
            : false,
          // Echo cancellation keeps the game's own sound out of the voice track
          audio: ui.useMic.checked ? { echoCancellation: true, noiseSuppression: true } : false,
        });
        acquired.push(camMic);
      }

      await startSession(screen, camMic);
    } catch (err) {
      acquired.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      showError(describeError(err));
      ui.start.disabled = false;
      ui.start.textContent = 'Start recording';
    }
  });

  // Just play: no consent, permissions or files, and no REC bar
  ui.playOnly.addEventListener('click', () => {
    if (!gameLoadedAt) return;
    ui.setup.hidden = true;
    ui.canvas.focus();
  });

  // ---------- recording ----------

  async function startSession(screen, camMic) {
    const base = `session_${fileStamp(new Date())}`;
    const dir = ui.saveFolder.checked ? await folder.getDirectoryHandle(base, { create: true }) : null;
    const micTrack = camMic ? camMic.getAudioTracks()[0] || null : null;
    const camTrack = camMic ? camMic.getVideoTracks()[0] || null : null;

    // The screen file carries game audio and the participant's voice mixed together;
    // the webcam file carries the voice alone, so either can be reviewed on its own.
    const parts = [];
    let audioContext = null;
    if (screen) {
      const tabAudio = screen.getAudioTracks()[0] || null;
      let audio = tabAudio || micTrack;
      if (tabAudio && micTrack) {
        audioContext = new AudioContext();
        const mix = audioContext.createMediaStreamDestination();
        for (const track of [tabAudio, micTrack])
          audioContext.createMediaStreamSource(new MediaStream([track])).connect(mix);
        audio = mix.stream.getAudioTracks()[0];
      }
      parts.push({ kind: 'screen', tracks: [screen.getVideoTracks()[0], audio] });
    }
    if (camTrack) parts.push({ kind: 'webcam', tracks: [camTrack, micTrack] });
    else if (micTrack && !screen) parts.push({ kind: 'audio', tracks: [micTrack] });

    const recorders = [];
    for (const part of parts) {
      const stream = new MediaStream(part.tracks.filter(Boolean));
      const hasVideo = stream.getVideoTracks().length > 0;
      const hasAudio = stream.getAudioTracks().length > 0;
      const mimeType = pickType(hasVideo ? (hasAudio ? VIDEO_TYPES : VIDEO_ONLY_TYPES) : AUDIO_TYPES);
      const filename = `${base}_${part.kind}.${extensionFor(mimeType, hasVideo)}`;
      const sink = dir ? await folderSink(dir, filename) : memorySink(filename, mimeType);
      recorders.push(createRecorder(part.kind, stream, mimeType, sink));
    }

    session = {
      base,
      dir,
      recorders,
      streams: [screen, camMic].filter(Boolean),
      audioContext,
      markers: [],
      events: [],
      warnings: [],
      startedAt: new Date(),
      t0: performance.now(),
      timer: null,
      stopping: false,
      finished: false,
      downloaded: new Set(),
    };
    // Start every recorder in the same tick so the files line up
    recorders.forEach((r) => r.recorder.start(CHUNK_MS));
    logEvent('session-started', { gameLoaded: gameLoadedAt !== null });

    if (screen) {
      screen.getVideoTracks()[0].addEventListener('ended', () => {
        logEvent('screen-share-ended');
        stopSession('Screen sharing was stopped from the browser, so the session ended.');
      });
    }
    if (camTrack) camTrack.addEventListener('ended', () => logEvent('camera-disconnected'));
    if (micTrack) micTrack.addEventListener('ended', () => logEvent('microphone-disconnected'));

    ui.setup.hidden = true;
    ui.bar.hidden = false;
    if (camTrack && ui.showPreview.checked) {
      ui.preview.srcObject = new MediaStream([camTrack]);
      ui.preview.hidden = false;
    }
    session.timer = setInterval(updateElapsed, 500);
    updateElapsed();
    ui.canvas.focus();
  }

  function createRecorder(kind, stream, mimeType, sink) {
    const options = {};
    if (stream.getAudioTracks().length) options.audioBitsPerSecond = BITRATES.audio;
    if (mimeType) options.mimeType = mimeType;
    if (stream.getVideoTracks().length) options.videoBitsPerSecond = BITRATES[kind] || BITRATES.webcam;
    const recorder = new MediaRecorder(stream, options);

    // Chunks are written in order; a failed write is logged rather than ending the session
    let writes = Promise.resolve();
    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data.size) return;
      const chunk = event.data;
      writes = writes.then(() => sink.write(chunk)).catch((err) => {
        session.warnings.push(`Writing ${sink.filename} failed: ${err.message}`);
        logEvent('write-error', { kind, message: err.message });
      });
    });
    recorder.addEventListener('error', (event) => {
      const message = event.error ? event.error.message : 'unknown error';
      session.warnings.push(`The ${kind} recorder stopped: ${message}`);
      logEvent('recorder-error', { kind, message });
    });
    // The last dataavailable fires before stop, so every chunk is queued by then
    const stopped = new Promise((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
    });
    // Closes the file once queued writes finish; safe to call more than once
    let closing = null;
    const close = () => (closing ||= writes.then(() => sink.close()));
    return { kind, recorder, mimeType: recorder.mimeType || mimeType, stopped, close };
  }

  async function stopSession(reason) {
    if (!session || session.stopping) return;
    session.stopping = true;
    clearInterval(session.timer);
    ui.mark.disabled = true;
    ui.stop.disabled = true;
    ui.stop.textContent = 'Saving…';

    const endedAt = new Date();
    const duration = elapsedSeconds();
    logEvent('session-stopped', reason ? { reason } : undefined);
    session.recorders.forEach((r) => { if (r.recorder.state !== 'inactive') r.recorder.stop(); });

    const files = [];
    for (const r of session.recorders) {
      try {
        // A recorder that never reports back must not leave the page stuck on "Saving…"
        const reported = await Promise.race([
          r.stopped.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
        ]);
        if (!reported) {
          session.warnings.push(`The ${r.kind} recorder didn't finish cleanly, so the end of its file may be missing.`);
          logEvent('recorder-stop-timeout', { kind: r.kind });
        }
        files.push({ kind: r.kind, mimeType: r.mimeType, ...(await r.close()) });
      } catch (err) {
        session.warnings.push(`Saving the ${r.kind} recording failed: ${err.message}`);
      }
    }
    session.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    if (session.audioContext) session.audioContext.close();
    if (document.pointerLockElement) document.exitPointerLock();

    const log = {
      game: document.title,
      startedAt: session.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSeconds: round(duration),
      gameLoadedAt: gameLoadedAt ? gameLoadedAt.toISOString() : null,
      timesAreSecondsFromStart: true,
      files: files.map(({ filename, kind, mimeType, bytes }) => ({ filename, kind, mimeType, bytes })),
      markers: session.markers,
      events: session.events,
      warnings: session.warnings,
      userAgent: navigator.userAgent,
    };
    try {
      const logName = `${session.base}_session.json`;
      const sink = session.dir ? await folderSink(session.dir, logName) : memorySink(logName, 'application/json');
      await sink.write(new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' }));
      files.push({ kind: 'log', ...(await sink.close()) });
    } catch (err) {
      session.warnings.push(`Saving the session log failed: ${err.message}`);
    }

    session.finished = true;
    showDone(files, duration, reason);
  }

  // ---------- storage ----------

  // Writes chunks to disk as they arrive, so long sessions don't sit in memory.
  // Chrome stages the file as "<name>.crswap" until it's closed; if the tab crashes,
  // renaming that file back to its real name recovers what was recorded.
  async function folderSink(dir, filename) {
    const handle = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    let bytes = 0;
    return {
      filename,
      async write(blob) { await writable.write(blob); bytes += blob.size; },
      async close() { await writable.close(); return { filename, bytes }; },
    };
  }

  function memorySink(filename, type) {
    const chunks = [];
    let bytes = 0;
    return {
      filename,
      async write(blob) { chunks.push(blob); bytes += blob.size; },
      async close() {
        return { filename, bytes, url: URL.createObjectURL(new Blob(chunks, { type: type || undefined })) };
      },
    };
  }

  // ---------- markers, events, timer ----------

  function addMarker() {
    if (!session || session.stopping) return;
    session.markers.push({ n: session.markers.length + 1, t: round(elapsedSeconds()), at: new Date().toISOString() });
    ui.markCount.textContent = String(session.markers.length);
    ui.mark.classList.remove('flash');
    void ui.mark.offsetWidth; // restart the flash animation
    ui.mark.classList.add('flash');
  }

  ui.mark.addEventListener('click', () => { addMarker(); ui.canvas.focus(); });
  ui.stop.addEventListener('click', () => stopSession());
  // Capture phase so the marker still registers while Unity holds keyboard focus
  window.addEventListener('keydown', (event) => {
    if (event.code === MARK_KEY && !event.repeat && session && !session.stopping) addMarker();
  }, true);

  function logEvent(type, details) {
    if (!session) return;
    session.events.push({ t: round(elapsedSeconds()), type, ...details });
  }

  // Context for the analysis: when the participant was in-game, tabbed away, or fullscreen
  document.addEventListener('pointerlockchange', () => logEvent('pointer-lock', { locked: !!document.pointerLockElement }));
  document.addEventListener('visibilitychange', () => logEvent('tab-visibility', { visible: document.visibilityState === 'visible' }));
  document.addEventListener('fullscreenchange', () => logEvent('fullscreen', { on: !!document.fullscreenElement }));

  function elapsedSeconds() {
    return session ? (performance.now() - session.t0) / 1000 : 0;
  }

  function updateElapsed() {
    ui.elapsed.textContent = formatDuration(elapsedSeconds());
  }

  // ---------- finished screen ----------

  function showDone(files, duration, reason) {
    ui.bar.hidden = true;
    ui.preview.hidden = true;
    ui.preview.srcObject = null;

    const markers = session.markers.length;
    const where = session.dir ? ` Saved to the folder ${folder.name}/${session.base}.` : '';
    ui.summary.textContent = `${formatDuration(duration)} recorded, ${markers} marker${markers === 1 ? '' : 's'}.${where}`
      + (reason ? ` ${reason}` : '');
    ui.doneTitle.textContent = session.warnings.length ? 'Session saved with problems' : 'Session saved';

    ui.files.replaceChildren();
    for (const file of files) {
      const item = document.createElement('li');
      const name = document.createElement(file.url ? 'a' : 'span');
      name.textContent = file.filename;
      if (file.url) {
        name.href = file.url;
        name.download = file.filename;
        name.addEventListener('click', () => session.downloaded.add(file.filename));
      }
      const size = document.createElement('span');
      size.className = 'muted';
      size.textContent = formatBytes(file.bytes);
      item.append(name, size);
      ui.files.append(item);
    }
    for (const warning of session.warnings) {
      const item = document.createElement('li');
      item.className = 'error';
      item.textContent = warning;
      ui.files.append(item);
    }

    const downloads = files.filter((file) => file.url);
    session.pendingDownloads = downloads.map((file) => file.filename);
    ui.downloadAll.hidden = downloads.length === 0;
    ui.downloadAll.onclick = async () => {
      for (const link of ui.files.querySelectorAll('a[download]')) {
        link.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    };
    ui.done.hidden = false;
  }

  ui.newSession.addEventListener('click', () => {
    if (hasUnsavedRecordings() && !confirm('Some recordings have not been downloaded yet. Start a new session anyway?')) return;
    session = null; // skip the unload warning
    location.reload();
  });

  function hasUnsavedRecordings() {
    if (!session) return false;
    if (!session.finished) return true;
    return (session.pendingDownloads || []).some((name) => !session.downloaded.has(name));
  }

  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedRecordings()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // ---------- Unity loader hooks ----------

  window.ThinkAloud = {
    loadProgress(progress) {
      ui.loadStatus.textContent = `Loading game… ${Math.round(progress * 100)}%`;
    },
    gameLoaded(instance) {
      gameLoadedAt = new Date();
      ui.loadStatus.textContent = 'Game loaded.';
      ui.start.textContent = 'Start recording';
      ui.start.disabled = Boolean(unsupported);
      ui.playOnly.disabled = false;
      logEvent('game-loaded');
      window.unityInstance = instance;
    },
    gameFailed(message) {
      ui.loadStatus.textContent = 'The game failed to load.';
      ui.loadStatus.classList.add('error');
      logEvent('game-load-failed', { message: String(message) });
      console.error(message);
    },
  };

  // ---------- helpers ----------

  function pickType(types) {
    return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  function extensionFor(mimeType, hasVideo) {
    if (mimeType.includes('mp4')) return hasVideo ? 'mp4' : 'm4a';
    return 'webm';
  }

  function describeError(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
        return 'Recording was blocked because a permission prompt was dismissed or denied. Allow access and try again.';
      case 'NotFoundError':
        return 'No camera or microphone was found. Untick the missing device, or plug one in and try again.';
      case 'NotReadableError':
        return 'The camera or microphone is being used by another app.';
      default:
        return `Couldn't start recording: ${(err && err.message) || err}`;
    }
  }

  function showError(message) {
    ui.error.textContent = message;
    ui.error.hidden = false;
  }

  function clearError() {
    ui.error.hidden = true;
    ui.error.textContent = '';
  }

  function round(seconds) {
    return Math.round(seconds * 1000) / 1000;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function fileStamp(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  }

  function formatDuration(seconds) {
    const s = Math.floor(seconds);
    return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }

  function formatBytes(bytes) {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  }
})();
