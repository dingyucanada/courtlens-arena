/**
 * Browser story recorder. Source overlays use decoded video-frame mediaTime
 * when available. MediaRecorder still encodes in real time: the encoded file
 * duration is not asserted to be identical to the requested edit duration.
 * Nothing is uploaded; failures and cancellation never return a partial film.
 */
export const EXPORT_LIMITS = Object.freeze({
  seconds: 180, clips: 2000, cuesPerPlay: 2000, width: 1280, height: 720,
  seekMs: 10000, readyMs: 10000, stallMs: 8000, finaliseMs: 5000,
  transitionMs: 3000, monitorMs: 100, extraWallMs: 60000,
});

const finite = n => typeof n === 'number' && Number.isFinite(n);
const EPS = 0.000001;
const error = (message, code) => Object.assign(new Error(message), { code });
const clock = () => globalThis.performance?.now?.() ?? Date.now();
const clone = value => structuredClone(value);

/** Pure edit-plan validation; duplicate source possessions are valid edits. */
export function validateStoryPlan(plan, project) {
  if (!plan || !Array.isArray(plan.clips) || !plan.clips.length) throw error('片单为空。', 'EMPTY_PLAN');
  if (plan.clips.length > EXPORT_LIMITS.clips || !finite(plan.duration) || plan.duration <= 0 || plan.duration > EXPORT_LIMITS.seconds) {
    throw error('浏览器录制最多 180 秒，请缩短片单。', 'PLAN_LIMIT');
  }
  if (!project || !Array.isArray(project.plays)) throw error('比赛项目无效。', 'INVALID_PROJECT');
  const plays = new Map(project.plays.map(play => [play.id, play]));
  if (plays.size !== project.plays.length) throw error('比赛回合 ID 重复。', 'INVALID_PROJECT');
  let offset = 0;
  for (const clip of plan.clips) {
    const play = plays.get(clip?.playId);
    if (!play || !finite(clip.start) || !finite(clip.end) || clip.start < play.start - EPS || clip.end > play.end + EPS || clip.end <= clip.start) {
      throw error('片段须在对应回合的有效视频区间内。', 'INVALID_CLIP');
    }
    if (!finite(clip.outputStart) || !finite(clip.outputEnd) || Math.abs(clip.outputStart - offset) > EPS || Math.abs(clip.outputEnd - (offset + clip.end - clip.start)) > EPS) {
      throw error('片段输出时间须按片单顺序连续拼接。', 'INVALID_OUTPUT_TIME');
    }
    if (play.reviewed !== true) throw error('请先核对片单中每一个回合。', 'UNREVIEWED_CLIP');
    offset = clip.outputEnd;
  }
  if (Math.abs(offset - plan.duration) > EPS) throw error('片单时长与片段总长度不一致。', 'INVALID_OUTPUT_TIME');
  return true;
}

function metricAvailableAt(record, play) {
  if (record && typeof record === 'object') {
    for (const key of ['availableAt', 'time', 't']) if (finite(record[key])) return record[key];
  }
  // Missing availability is conservatively the possession end, never its shot.
  return play.end;
}

/** Immutable playback view: hide future metrics/results and use snapshot calibration. */
export function storyPlayAt(play, t, project, viewPlay) {
  const metrics = Object.fromEntries(Object.entries(play.metrics || {}).map(([key, record]) => {
    if (record == null || t < metricAvailableAt(record, play)) return [key, record && typeof record === 'object' ? { ...record, value: null } : null];
    return [key, record];
  }));
  const safe = { ...play, metrics, outcome: finite(play.resultTime) && t >= play.resultTime ? play.outcome : 'unknown' };
  // A legacy callback may close over live UI state. Its calibration is always
  // replaced by the independent immutable project supplied to this recorder.
  const rendered = typeof viewPlay === 'function' ? viewPlay(safe, t, project) : safe;
  const calibration = project.calibrations?.find(c => c.playId === play.id && finite(c.start) && finite(c.end) && t >= c.start && t < c.end) ?? play.calibration ?? null;
  return { ...rendered, metrics, outcome: safe.outcome, calibration };
}

function validateNarrations(project, narrations, plan) {
  for (const id of new Set(plan.clips.map(c => c.playId))) {
    const play = project.plays.find(p => p.id === id), cues = narrations?.[id]?.cues ?? [];
    if (!Array.isArray(cues) || cues.length > EXPORT_LIMITS.cuesPerPlay) throw error('字幕条数或格式无效。', 'INVALID_CUE');
    for (const cue of cues) {
      if (!finite(cue.start) || !finite(cue.end) || cue.start < play.start - EPS || cue.end > play.end + EPS || cue.end <= cue.start || typeof cue.text !== 'string' || cue.text.length > 10000) {
        throw error('字幕时间须在对应源回合内，且结束晚于开始。', 'INVALID_CUE');
      }
      for (const id of cue.evidenceIds || []) {
        if (id === `${play.id}:outcome` && (!finite(play.resultTime) || cue.start < play.resultTime - EPS)) {
          throw error('结果字幕不能早于独立结果时间。', 'EARLY_RESULT');
        }
        const canonical = String(id).startsWith(`${play.id}:metric:`) ? String(id).slice(`${play.id}:metric:`.length) : null;
        if (canonical) {
          const keys = canonical === 'difficulty' ? ['difficulty', 'xfg', 'xfg_pct', 'shotDifficulty'] : [canonical];
          const key = keys.find(key => Object.hasOwn(play.metrics || {}, key));
          if (!key || cue.start < metricAvailableAt(play.metrics[key], play) - EPS) throw error('指标字幕不能早于指标可用时间。', 'EARLY_METRIC');
        }
      }
    }
  }
}

export function wrapStoryCaption(ctx, text, width = 1080, limit = 3) {
  const lines = []; let line = '';
  for (const character of String(text).replace(/[\r\n]+/g, ' ')) {
    if (line && ctx.measureText(line + character).width > width) { lines.push(line); line = character; }
    else line += character;
    if (lines.length >= limit) break;
  }
  if (line && lines.length < limit) lines.push(line);
  return lines;
}

/**
 * recordStory({ video, plan, project, narrations, layers, onProgress,
 *   shouldCancel, sourceBadge, renderOverlay, viewPlay }) -> Promise<film>
 * viewPlay receives (play, decodedMediaTime, immutableProject).
 * onProgress receives {clipIndex,clips,fraction,sourceTime,outputTime,frameClock}.
 */
export async function recordStory({ video, plan, project, narrations = {}, layers = {}, onProgress = () => {}, shouldCancel = () => false, sourceBadge = kind => kind || '用户提供', renderOverlay, viewPlay } = {}) {
  validateStoryPlan(plan, project);
  const snapshot = clone(project), edit = clone(plan), captions = clone(narrations), selectedLayers = clone(layers);
  validateNarrations(snapshot, captions, edit);
  if (!video || typeof video.play !== 'function' || typeof video.pause !== 'function' || typeof video.addEventListener !== 'function') throw error('未绑定可播放视频。', 'INVALID_VIDEO');
  const doc = globalThis.document, Recorder = globalThis.MediaRecorder;
  if (!doc?.createElement || !Recorder || typeof Recorder.isTypeSupported !== 'function') throw error('浏览器不支持成片录制。', 'UNSUPPORTED');
  if (doc.visibilityState !== 'visible') throw error('录制需保持页面在前台。', 'NOT_FOREGROUND');
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => Recorder.isTypeSupported(type));
  if (!mime) throw error('浏览器未提供 WebM 编码器。', 'UNSUPPORTED');
  const decoded = typeof video.requestVideoFrameCallback === 'function' && typeof video.cancelVideoFrameCallback === 'function';
  if (!decoded && (typeof globalThis.requestAnimationFrame !== 'function' || typeof globalThis.cancelAnimationFrame !== 'function')) throw error('浏览器没有可用的视频帧调度。', 'UNSUPPORTED');
  const frameClock = decoded ? 'decoded-media-time' : 'raf-approximate';
  const warnings = ['浏览器实时编码可能产生片长偏差；返回 duration 是片单计划时长，成片仍须复核。', '当前成片不包含原视频声音。'];
  if (!decoded) warnings.push('当前浏览器未提供解码帧回调；叠加依据播放器时间近似同步，未声称逐帧准确。');
  const canvas = doc.createElement('canvas'); canvas.width = EXPORT_LIMITS.width; canvas.height = EXPORT_LIMITS.height;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof canvas.captureStream !== 'function') throw error('浏览器不支持画面录制。', 'UNSUPPORTED');
  const resources = new Set(), startedWall = clock(), wallLimit = edit.duration * 1000 + EXPORT_LIMITS.extraWallMs;
  let stream = null, recorder = null, track = null, failure = null, closed = false, phase = 'preparing', lastProgressWall = startedWall, lastMediaTime = null;
  let rejectFailure, stoppedPromise, recordingStartedWall = null, recordedWallMs = 0, frameCount = 0, captureMode = null;
  const failurePromise = new Promise((_, reject) => { rejectFailure = reject; });
  // Rejections are also observed while a stage is between its own awaits.
  failurePromise.catch(() => {});
  const dispose = cleanup => { resources.delete(cleanup); cleanup(); };
  const abort = reason => {
    if (failure || closed) return;
    failure = reason instanceof Error ? reason : error('录制失败，未生成成片。', 'EXPORT_FAILED');
    video.pause(); for (const cleanup of [...resources]) dispose(cleanup); rejectFailure(failure);
  };
  const check = () => {
    if (failure) throw failure;
    if (shouldCancel()) throw error('录制已取消，未生成成片。', 'CANCELLED');
    if (doc.visibilityState !== 'visible') throw error('页面离开前台，录制已中止。', 'NOT_FOREGROUND');
    if (clock() - startedWall > wallLimit) throw error('录制超过总时限，未生成成片。', 'EXPORT_TIMEOUT');
  };
  const race = promise => Promise.race([promise, failurePromise]);
  const listen = (target, name, fn) => {
    target.addEventListener(name, fn); const cleanup = () => target.removeEventListener(name, fn); resources.add(cleanup); return cleanup;
  };
  const monitor = setInterval(() => {
    try { check(); if (phase === 'playing' && clock() - lastProgressWall > EXPORT_LIMITS.stallMs) throw error('视频播放或解码停滞，录制已中止。', 'VIDEO_STALLED'); }
    catch (cause) { abort(cause); }
  }, EXPORT_LIMITS.monitorMs);
  const originalRate = video.playbackRate;
  const chunks = [], clipMetadata = [];
  function schedule(callback) {
    let active = true;
    const id = decoded ? video.requestVideoFrameCallback((_, metadata) => {
      if (!active || closed || failure) return;
      resources.delete(cancel); active = false;
      const t = metadata?.mediaTime;
      if (!finite(t)) { abort(error('解码帧没有有效媒体时间。', 'INVALID_FRAME_TIME')); return; }
      callback({ mediaTime: t, presentedFrames: metadata.presentedFrames ?? null });
    }) : requestAnimationFrame(() => {
      if (!active || closed || failure) return;
      resources.delete(cancel); active = false;
      if (!finite(video.currentTime)) { abort(error('播放器时间无效。', 'INVALID_FRAME_TIME')); return; }
      callback({ mediaTime: video.currentTime, presentedFrames: null });
    });
    const cancel = () => { if (!active) return; active = false; if (decoded) video.cancelVideoFrameCallback(id); else cancelAnimationFrame(id); };
    resources.add(cancel); return cancel;
  }
  async function ready() {
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && finite(video.duration)) return;
    let cleanup;
    const promise = new Promise((resolve, reject) => {
      const handlers = [];
      const inspect = () => { if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && finite(video.duration)) resolve(); };
      for (const name of ['loadedmetadata', 'loadeddata', 'canplay']) { video.addEventListener(name, inspect); handlers.push([name, inspect]); }
      const timer = setTimeout(() => reject(error('读取视频信息超时。', 'VIDEO_READY_TIMEOUT')), EXPORT_LIMITS.readyMs);
      cleanup = () => { clearTimeout(timer); for (const [name, fn] of handlers) video.removeEventListener(name, fn); }; resources.add(cleanup); inspect();
    });
    try { await race(promise); } finally { if (cleanup) dispose(cleanup); }
  }
  async function seek(target, obtainFrame = true) {
    check(); phase = 'seeking'; video.pause();
    let cleanup;
    const promise = new Promise((resolve, reject) => {
      let seeked = false, frame = null, cancelFrame = null;
      const inspect = () => { if (seeked && (!obtainFrame || frame)) resolve(frame); };
      const onSeek = () => {
        seeked = true; frame = null;
        if (cancelFrame) dispose(cancelFrame);
        // Reusing a callback queued before seeking can pair an old clock with new pixels.
        // Register only after this seek completes; schedule's active guard rejects cancelled callbacks.
        if (obtainFrame) {
          cancelFrame = schedule(value => { video.pause(); frame = value; inspect(); });
          // Paused seek frames may already have been submitted before seeked.
          // Advance to the first fresh frame and record its real mediaTime.
          try { Promise.resolve(video.play()).catch(() => reject(error('视频无法提交定位后的新帧。', 'VIDEO_PLAY_FAILED'))); }
          catch { reject(error('视频无法播放定位后的新帧。', 'VIDEO_PLAY_FAILED')); }
        }
        else inspect();
      };
      video.addEventListener('seeked', onSeek);
      const timer = setTimeout(() => reject(error('视频定位或解码超时。', 'SEEK_TIMEOUT')), EXPORT_LIMITS.seekMs);
      cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', onSeek); if (cancelFrame) dispose(cancelFrame); }; resources.add(cleanup);
      try { video.currentTime = target; } catch (cause) { reject(error('视频无法定位到片段时间。', 'SEEK_FAILED')); }
    });
    try { return await race(promise); } finally { if (cleanup) dispose(cleanup); }
  }
  async function firstInside(clip) {
    // A paused element need not submit a new compositor frame for a no-op seek.
    // Prime a different position while the recorder is stopped/paused.
    if (Math.abs(video.currentTime - clip.start) < .001) {
      const prime = clip.start + .08 < video.duration ? clip.start + .08 : Math.max(0, clip.start - .08);
      if (prime !== clip.start) await seek(prime, false);
    }
    const frame = await seek(clip.start);
    if (frame.mediaTime >= clip.end - EPS) throw error('片段内没有可录制的解码帧，请调整裁剪时间。', 'NO_CLIP_FRAME');
    if (frame.mediaTime >= clip.start - EPS) return frame;
    return playback(clip, null, true);
  }
  function draw(play, clip, frame, index) {
    check(); const t = frame.mediaTime;
    if (t < clip.start - EPS || t >= clip.end - EPS) return false;
    const width = canvas.width, height = canvas.height, ratio = Math.min(width / video.videoWidth, height / video.videoHeight);
    const w = video.videoWidth * ratio, hh = video.videoHeight * ratio, x = (width - w) / 2, y = (height - hh) / 2;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#030912'; ctx.fillRect(0, 0, width, height); ctx.drawImage(video, x, y, w, hh);
    if (typeof renderOverlay === 'function') {
      ctx.save(); ctx.translate(x, y);
      try { renderOverlay(ctx, storyPlayAt(play, t, snapshot, viewPlay), t, { width: w, height: hh, layers: selectedLayers }); }
      finally { ctx.restore(); }
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#071326e8'; ctx.fillRect(24, 22, 530, 62);
    ctx.font = 'bold 19px system-ui'; ctx.fillStyle = 'white'; ctx.fillText(String(play.title ?? '').slice(0, 28), 40, 50);
    ctx.font = '12px system-ui'; ctx.fillStyle = '#b0c5e4'; ctx.fillText(`COURTLENS ARENA · ${sourceBadge(snapshot.provenance?.kind)} · ${play.id}`, 40, 72);
    const cue = (captions[play.id]?.cues || []).find(cue => t >= cue.start && t < cue.end);
    if (cue) {
      ctx.font = '22px system-ui'; const lines = wrapStoryCaption(ctx, cue.text);
      ctx.fillStyle = '#050a16ed'; ctx.fillRect(65, 680 - lines.length * 34, 1150, lines.length * 34 + 15); ctx.fillStyle = 'white'; ctx.textAlign = 'center';
      lines.forEach((line, i) => ctx.fillText(line, 640, 700 - (lines.length - i) * 34));
    }
    ctx.restore();
    const outputTime = clip.outputStart + t - clip.start;
    onProgress({ clipIndex: index, clips: edit.clips.length, fraction: Math.max(0, Math.min(1, outputTime / edit.duration)), sourceTime: t, outputTime, frameClock });
    return true;
  }
  function requestCapture() { if (captureMode === 'manual-frame-request' && track && recorder?.state === 'recording') track.requestFrame(); }
  async function playback(clip, consume, firstOnly = false) {
    phase = 'playing'; lastProgressWall = clock(); lastMediaTime = null;
    let cleanup;
    const promise = new Promise((resolve, reject) => {
      let pendingFrame = null, finished = false;
      const finish = frame => { if (finished) return; finished = true; video.pause(); resolve(frame); };
      const onEnded = () => { if (finite(video.currentTime) && video.currentTime >= clip.end - EPS && !firstOnly) finish(null); else reject(error('源视频提前结束，未生成完整片段。', 'VIDEO_ENDED_EARLY')); };
      video.addEventListener('ended', onEnded);
      cleanup = () => { finished = true; video.removeEventListener('ended', onEnded); if (pendingFrame) dispose(pendingFrame); }; resources.add(cleanup);
      const receive = frame => {
        if (finished) return;
        try {
          check(); const t = frame.mediaTime;
          if (t >= clip.end - EPS) { if (firstOnly) reject(error('片段内没有可录制的解码帧。', 'NO_CLIP_FRAME')); else finish(null); return; }
          if (lastMediaTime == null || t > lastMediaTime + EPS) { lastProgressWall = clock(); lastMediaTime = t; }
          if (t >= clip.start - EPS && (firstOnly || !consume || t > consume.lastTime + EPS)) {
            if (firstOnly) { finish(frame); return; }
            consume(frame); consume.lastTime = t;
          }
          pendingFrame = schedule(receive);
        } catch (cause) { reject(cause); }
      };
      pendingFrame = schedule(receive);
      try { Promise.resolve(video.play()).catch(() => reject(error('视频播放失败，未生成成片。', 'VIDEO_PLAY_FAILED'))); }
      catch { reject(error('视频播放失败，未生成成片。', 'VIDEO_PLAY_FAILED')); }
    });
    try { return await race(promise); } finally { video.pause(); phase = 'between-clips'; if (cleanup) dispose(cleanup); }
  }
  async function recorderTransition(name, operation) {
    let cleanup;
    const promise = new Promise((resolve, reject) => {
      const handler = () => resolve(); recorder.addEventListener(name, handler);
      const timer = setTimeout(() => reject(error('编码器状态转换超时。', 'ENCODER_TIMEOUT')), EXPORT_LIMITS.transitionMs);
      cleanup = () => { clearTimeout(timer); recorder.removeEventListener(name, handler); }; resources.add(cleanup);
      try { operation(); } catch { reject(error('编码器无法开始或继续录制。', 'ENCODER_FAILED')); }
    });
    try { await race(promise); } finally { if (cleanup) dispose(cleanup); }
    if (name === 'start' || name === 'resume') recordingStartedWall = clock();
    else if (name === 'pause' && recordingStartedWall != null) { recordedWallMs += clock() - recordingStartedWall; recordingStartedWall = null; }
  }
  try {
    listen(video, 'error', () => abort(error('视频解码失败，未生成成片。', 'VIDEO_ERROR')));
    listen(video, 'emptied', () => abort(error('录制素材已改变，录制已中止。', 'VIDEO_CHANGED')));
    listen(doc, 'visibilitychange', () => { if (doc.visibilityState !== 'visible') abort(error('页面离开前台，录制已中止。', 'NOT_FOREGROUND')); });
    check(); video.pause(); video.playbackRate = 1; await ready();
    if (!finite(video.duration) || video.duration <= 0 || edit.clips.some(c => c.end > video.duration + EPS)) throw error('片段超出可播放的源视频时长。', 'VIDEO_BOUNDS');
    for (let index = 0; index < edit.clips.length; index++) {
      const clip = edit.clips[index], play = snapshot.plays.find(p => p.id === clip.playId);
      if (recorder && recorder.state === 'recording') await recorderTransition('pause', () => recorder.pause());
      const initial = await firstInside(clip); draw(play, clip, initial, index);
      if (!recorder) {
        // Create the stream only after a valid first source frame is drawn.
        stream = canvas.captureStream(0); track = stream.getVideoTracks()[0];
        if (!track) throw error('没有可录制的视频图层。', 'NO_CAPTURE_TRACK');
        if (typeof track.requestFrame === 'function') captureMode = 'manual-frame-request';
        else { stream.getTracks().forEach(t => t.stop()); stream = canvas.captureStream(30); track = stream.getVideoTracks()[0]; captureMode = 'automatic-30fps'; warnings.push('浏览器不支持主动采集帧；使用 30 fps 画布流，帧间隔由浏览器决定。'); }
        if (!track) throw error('没有可录制的视频图层。', 'NO_CAPTURE_TRACK');
        try { recorder = new Recorder(stream, { mimeType: mime, videoBitsPerSecond: 4500000 }); }
        catch { throw error('浏览器无法创建视频编码器。', 'ENCODER_CONSTRUCTION_FAILED'); }
        stoppedPromise = new Promise(resolve => { listen(recorder, 'stop', resolve); });
        listen(recorder, 'dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
        listen(recorder, 'error', () => abort(error('视频编码失败，未生成成片。', 'ENCODER_FAILED')));
        await recorderTransition('start', () => recorder.start(500));
      } else await recorderTransition('resume', () => recorder.resume());
      requestCapture();
      const metadata = { playId: play.id, outputStart: clip.outputStart, outputEnd: clip.outputEnd, requestedStart: clip.start, requestedEnd: clip.end, firstFrameTime: initial.mediaTime, lastFrameTime: initial.mediaTime, frameCount: 1, maxObservedFrameGap: 0 };
      clipMetadata.push(metadata); frameCount++;
      const consume = frame => {
        if (!draw(play, clip, frame, index)) return;
        metadata.maxObservedFrameGap = Math.max(metadata.maxObservedFrameGap, frame.mediaTime - metadata.lastFrameTime);
        metadata.lastFrameTime = frame.mediaTime; metadata.frameCount++; frameCount++; requestCapture();
      };
      consume.lastTime = initial.mediaTime; await playback(clip, consume);
      check(); onProgress({ clipIndex: index, clips: edit.clips.length, fraction: clip.outputEnd / edit.duration, sourceTime: clip.end, outputTime: clip.outputEnd, frameClock });
    }
    phase = 'finalising'; check();
    if (recordingStartedWall != null) { recordedWallMs += clock() - recordingStartedWall; recordingStartedWall = null; }
    recorder.stop();
    let timer;
    try { await race(Promise.race([stoppedPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(error('编码器没有完成文件写入。', 'ENCODER_FINALISE_TIMEOUT')), EXPORT_LIMITS.finaliseMs); })])); }
    finally { clearTimeout(timer); }
    check(); const blob = new Blob(chunks, { type: recorder.mimeType || mime });
    if (!blob.size || !frameCount || clipMetadata.length !== edit.clips.length) throw error('没有获得完整有效的编码数据。', 'EMPTY_ENCODING');
    return { blob, mime: recorder.mimeType || mime, duration: edit.duration, durationBasis: 'playlist-plan', recordedWallSeconds: recordedWallMs / 1000, frameClock, captureMode, frameCount, clips: clipMetadata, width: canvas.width, height: canvas.height, audioIncluded: false, warnings };
  } finally {
    closed = true; clearInterval(monitor); video.pause();
    for (const cleanup of [...resources]) dispose(cleanup);
    // Inactive / failed constructor guards also preserve the original error.
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
    if (stream) for (const item of stream.getTracks()) { try { item.stop(); } catch {} }
    if (finite(originalRate) && originalRate > 0) video.playbackRate = originalRate;
  }
}
