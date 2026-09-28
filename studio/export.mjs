import { summarize, validateProject } from './domain.mjs';

const MAX_SECONDS = 180;
const activeVideos = new WeakSet();
const finite = value => typeof value === 'number' && Number.isFinite(value);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const percent = value => finite(value) ? `${(value * 100).toFixed(1)}%` : '—';
const number = value => finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
const singleLine = value => String(value ?? '').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
const vttText = value => singleLine(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const resultLabel = play => play.made === true ? '命中' : play.made === false ? '未中' : '结果未知';
const statusLabel = status => ({ approved: '已批准', review: '待复核', draft: '草稿' }[status] || '状态未知');

function stamp(seconds, milliseconds = false) {
  const total = Math.max(0, Math.round((finite(seconds) ? seconds : 0) * 1000));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const secs = Math.floor(total / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${milliseconds ? `.${String(total % 1000).padStart(3, '0')}` : ''}`;
}

const cueStamp = seconds => stamp(Math.ceil(seconds * 1000 - 1e-8) / 1000, true);

function resolveClips(project, strict = true) {
  if (!project || !Array.isArray(project.plays)) throw new Error('项目缺少回合数据。');
  const plays = new Map(project.plays.map(play => [play.id, play]));
  const selected = Array.isArray(project.playlist) && project.playlist.length > 0;
  const items = selected ? project.playlist : project.plays.map(play => ({ id: play.id, playId: play.id, in: play.start, out: play.end, title: '' }));
  const clips = [];
  for (const item of items) {
    const play = plays.get(item.playId);
    const valid = play && finite(item.in) && finite(item.out) && item.in >= 0 && item.out > item.in && finite(play.start) && finite(play.end) && item.in >= play.start && item.out <= play.end;
    if (!valid) {
      if (strict) throw new Error(`片段 ${singleLine(item.id || item.playId || clips.length + 1)} 的引用或时间范围无效。`);
      continue;
    }
    clips.push({ ...item, play: { ...play } });
  }
  return clips;
}

function currentOutcome(play, time) {
  if (play.made !== true && play.made !== false) return '结果未知';
  return finite(play.resultTime) && time >= play.resultTime ? resultLabel(play) : '结果待揭示';
}

/** Plain cues intentionally exclude free-text titles/notes, which may contain spoilers. */
export function makeVTT(project) {
  const clips = resolveClips(project);
  if (!clips.length) throw new Error('请先添加至少一个回合或有效片段。');
  const errors = validateProject(project).filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(`项目数据无效：${errors.map(issue => issue.message).join('；')}`);
  const cues = ['WEBVTT', ''];
  let offset = 0;
  let cue = 1;
  clips.forEach((clip, index) => {
    const boundaries = [clip.in];
    if (finite(clip.play.resultTime) && clip.play.resultTime > clip.in && clip.play.resultTime < clip.out && (clip.play.made === true || clip.play.made === false)) boundaries.push(clip.play.resultTime);
    boundaries.push(clip.out);
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const start = offset + boundaries[i] - clip.in;
      const end = offset + boundaries[i + 1] - clip.in;
      if (cueStamp(end) === cueStamp(start)) continue;
      cues.push(String(cue++), `${cueStamp(start)} --> ${cueStamp(end)}`, vttText(`片段 ${index + 1}/${clips.length} · ${clip.play.shooter || '未命名球员'}${clip.play.team ? ` · ${clip.play.team}` : ''} · ${clip.play.points === 3 ? '三分' : '两分'}出手`), vttText(currentOutcome(clip.play, boundaries[i])), '');
    }
    offset += clip.out - clip.in;
  });
  return `${cues.join('\n')}\n`;
}

function shotChart(plays) {
  const located = plays.filter(play => finite(play.x) && finite(play.y) && play.x >= 0 && play.x <= 1 && play.y >= 0 && play.y <= 1);
  if (!located.length) return '<p class="empty">没有提供有效的投篮坐标，因此未绘制投篮分布。</p>';
  const marks = located.map(play => {
    const x = 12 + play.x * 500;
    const y = 12 + play.y * 470;
    const label = escapeHTML(`${play.shooter || '未命名球员'} · ${resultLabel(play)} · (${play.x.toFixed(3)}, ${play.y.toFixed(3)})`);
    if (play.made === false) return `<g stroke="#c8102e" stroke-width="3"><title>${label}</title><path d="M${x - 5},${y - 5}l10,10m-10,0l10,-10"/></g>`;
    return `<circle cx="${x}" cy="${y}" r="5.5" fill="${play.made === true ? '#1762b3' : '#fff'}" stroke="${play.made === true ? '#1762b3' : '#596b82'}" stroke-width="2"><title>${label}</title></circle>`;
  }).join('');
  return `<div class="chart"><svg viewBox="0 0 524 494" role="img" aria-label="用户提供坐标的半场投篮分布"><rect x="12" y="12" width="500" height="470" fill="#f3f6fa" stroke="#98a9bd" stroke-width="2"/><g fill="none" stroke="#bdcad8" stroke-width="2"><path d="M182 12v190h160V12M202 12v190h120V12M42 12v138a237 237 0 0 0 440 0V12"/><circle cx="262" cy="202" r="60"/><path d="M202 482a60 60 0 0 1 120 0M232 52h60"/><circle cx="262" cy="64" r="8"/></g>${marks}</svg><div><p><b>${located.length} / ${plays.length}</b> 条回合提供了有效坐标。</p><p><span class="blue">●</span> 命中　<span class="red">×</span> 未中　<span class="gray">○</span> 结果未知</p><p class="muted">坐标来自人工填写或导入，范围为 0–1；横轴从左向右，纵轴从上向下。球场线仅为示意，不代表自动定位或官方场地测量。</p></div></div>`;
}

/** Self-contained, network-free HTML. A report may describe a draft without implying approval. */
export function makeReport(project) {
  if (!project || !Array.isArray(project.plays)) throw new Error('项目缺少回合数据。');
  const stats = summarize(project.plays);
  const issues = validateProject(project);
  const clips = resolveClips(project, false);
  const hasPlaylist = Array.isArray(project.playlist) && project.playlist.length > 0;
  const totalDuration = clips.reduce((sum, clip) => sum + clip.out - clip.in, 0);
  const sources = [...new Set([project.source, ...project.plays.map(play => play.source)].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  const playerRows = stats.players.map(player => `<tr><th scope="row">${escapeHTML(player.name || '未命名球员')}${player.team ? ` · ${escapeHTML(player.team)}` : ''}</th><td>${number(player.attempts)}</td><td>${number(player.made)}</td><td>${percent(player.fgPct)}</td><td>${number(player.points)}</td></tr>`).join('');
  const clipRows = clips.map((clip, index) => `<tr><td>${index + 1}</td><th scope="row">${escapeHTML(clip.title || clip.play.shooter || '未命名片段')}</th><td>${escapeHTML(clip.play.id)}</td><td class="mono">${stamp(clip.in, true)}–${stamp(clip.out, true)}</td><td>${number(clip.out - clip.in)} 秒</td><td>${clip.play.reviewed === true ? '已复核' : '待复核'}</td></tr>`).join('');
  const playRows = project.plays.map(play => `<tr><th scope="row">${escapeHTML(play.shooter || '未命名球员')}<small>${escapeHTML(play.team || '球队未填写')} · ${escapeHTML(play.id)}</small></th><td class="mono">${finite(play.start) ? stamp(play.start, true) : '—'}<br>${finite(play.end) ? stamp(play.end, true) : '—'}</td><td>${play.points === 2 || play.points === 3 ? `${play.points} 分` : '—'}<br>${resultLabel(play)}</td><td>${percent(play.xfg)}</td><td>${escapeHTML(play.tag || '—')}</td><td class="notes">${escapeHTML(play.notes || '—')}</td><td>${play.reviewed === true ? '已复核' : '待复核'}</td></tr>`).join('');
  const card = (label, value, detail) => `<div class="metric"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escapeHTML(project.name || 'CourtLens 项目')} · CourtLens 复盘报告</title>
<style>
:root{color-scheme:light;--navy:#081e3a;--blue:#1762b3;--red:#c8102e;--muted:#596b82;--line:#dde4ed}*{box-sizing:border-box}body{margin:0;background:#eaf0f6;color:var(--navy);font:14px/1.65 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}.page{max-width:1120px;margin:32px auto;background:white;box-shadow:0 16px 50px #081e3a14}header{background:var(--navy);color:white;padding:42px 48px;border-top:8px solid var(--red)}.brand{font-size:12px;font-weight:800;letter-spacing:3px;color:#9fc4ee}h1{font-size:32px;line-height:1.25;margin:14px 0 12px;overflow-wrap:anywhere}.subtitle{color:#c6d5e6}.badge{display:inline-block;padding:4px 12px;border:1px solid #9fc4ee;border-radius:20px;margin-top:12px}.content{padding:30px 48px 40px}h2{font-size:20px;margin:30px 0 14px;border-left:4px solid var(--red);padding-left:12px}p{margin:8px 0}.muted,small{color:var(--muted)}small{display:block;font-size:11px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.metric{border:1px solid var(--line);border-top:3px solid var(--blue);padding:16px}.metric span{color:var(--muted);font-size:12px}.metric strong{display:block;font-size:30px;line-height:1.4}.callout{border:1px solid var(--line);background:#f3f6fa;padding:16px 20px;margin:18px 0}.callout.warning{border-left:4px solid var(--red)}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12px}th,td{text-align:left;padding:10px 9px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}thead th{background:var(--navy);color:white;font-weight:600}tbody tr:nth-child(even){background:#f7f9fc}tbody th{font-weight:600}.mono{font-variant-numeric:tabular-nums;white-space:nowrap}.notes{white-space:pre-wrap;min-width:140px}.sources{padding-left:22px;white-space:pre-wrap;overflow-wrap:anywhere}.sources li{padding-bottom:8px}.chart{display:grid;grid-template-columns:minmax(220px,460px) 1fr;gap:30px;align-items:center}.chart svg{width:100%;height:auto;max-height:430px}.blue{color:var(--blue)}.red{color:var(--red)}.gray{color:var(--muted)}.empty{padding:24px;background:#f3f6fa;color:var(--muted)}footer{border-top:1px solid var(--line);padding:18px 48px;color:var(--muted);font-size:11px}.table-wrap{overflow-x:auto}ul{padding-left:21px}.metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 24px;overflow-wrap:anywhere}.metadata b{font-weight:600}section{break-inside:auto}@media(max-width:650px){.page{margin:0}header,.content,footer{padding:24px}.metrics{grid-template-columns:repeat(2,1fr)}.chart,.metadata{grid-template-columns:1fr}h1{font-size:26px}}@page{size:A4;margin:14mm}@media print{body{background:white;font-size:10px}.page{margin:0;box-shadow:none;max-width:none}header{padding:20px 24px;print-color-adjust:exact;-webkit-print-color-adjust:exact}.content{padding:12px 0}.metric{padding:10px}.metric strong{font-size:24px}h1{font-size:25px}h2{font-size:16px;break-after:avoid}table{font-size:9px}th,td{padding:6px}thead{display:table-header-group}tr,.metric,.callout,.chart{break-inside:avoid}.table-wrap{overflow:visible}.notes{min-width:70px}.chart svg{max-height:270px}footer{padding:12px 0}.metrics,thead{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
</style></head><body><article class="page"><header><div class="brand">COURTLENS / BASKETBALL REVIEW</div><h1>${escapeHTML(project.name || '未命名项目')}</h1><div class="subtitle">${escapeHTML(project.opponent ? `对手：${project.opponent}` : '对手未填写')} · ${escapeHTML(project.date || '比赛日期未填写')}</div><span class="badge">${statusLabel(project.status)} · 修订 ${escapeHTML(project.revision ?? '—')}</span></header>
<main class="content"><div class="metadata"><div><b>项目 ID：</b>${escapeHTML(project.id || '—')}</div><div><b>用途：</b>${project.scenario === 'editor' ? '剪辑复盘' : '教练复盘'}</div><div><b>视频：</b>${escapeHTML(project.video?.name || project.video?.id || '尚未绑定')}</div><div><b>数据更新：</b>${escapeHTML(project.updatedAt || '未记录')}</div></div>
<section><h2>项目概览</h2><div class="metrics">${card('回合条目', number(stats.total), `${number(stats.reviewed)} 条已人工复核`)}${card('投篮命中率 FG%', percent(stats.fgPct), `${number(stats.made)} 命中 / ${number(stats.attempts)} 次已知结果`)}${card('有效命中率 eFG%', percent(stats.efgPct), '三分命中按 1.5 次命中计权')}${card('实际投篮得分', number(stats.points), '仅统计已知命中的两分 / 三分球')}${card('期望投篮得分', number(stats.expectedPoints), `xFG 已提供 ${number(stats.xfgCount)} / ${number(stats.total)} 条`)}${card('未知结果', number(stats.total - stats.attempts), '未知结果不计作未中')}</div>
<div class="callout"><b>统计范围：</b>以上统计覆盖项目内全部回合；下方片段清单${hasPlaylist ? '遵循播放列表顺序，允许重复选取' : '按回合顺序生成'}，共 ${clips.length} 段 / ${number(totalDuration)} 秒。播放列表中的重复片段不会重复计入项目统计。</div>
${issues.length ? `<div class="callout warning"><b>数据检查：</b><ul>${issues.map(issue => `<li>${issue.severity === 'error' ? '错误' : '提示'}：${escapeHTML(issue.message)}</li>`).join('')}</ul></div>` : '<p class="muted">当前项目通过结构与时间范围检查。通过检查不等于来源已经被独立认证。</p>'}</section>
<section><h2>球员统计</h2><div class="table-wrap"><table><thead><tr><th>球员</th><th>已知结果出手</th><th>命中</th><th>FG%</th><th>得分</th></tr></thead><tbody>${playerRows || '<tr><td colspan="5">暂无球员统计。</td></tr>'}</tbody></table></div></section>
<section><h2>投篮位置</h2>${shotChart(project.plays)}</section>
<section><h2>片段清单</h2><div class="table-wrap"><table><thead><tr><th>顺序</th><th>片段标题</th><th>回合 ID</th><th>原视频时间</th><th>时长</th><th>复核</th></tr></thead><tbody>${clipRows || '<tr><td colspan="6">暂无有效片段。</td></tr>'}</tbody></table></div></section>
<section><h2>回合与复核笔记</h2><div class="table-wrap"><table><thead><tr><th>球员 / 回合</th><th>开始 / 结束</th><th>出手 / 结果</th><th>xFG</th><th>标签</th><th>笔记</th><th>复核</th></tr></thead><tbody>${playRows || '<tr><td colspan="7">暂无回合。</td></tr>'}</tbody></table></div></section>
<section><h2>来源与可追溯信息</h2>${sources.length ? `<ol class="sources">${sources.map(source => `<li>${escapeHTML(source)}</li>`).join('')}</ol>` : '<p class="empty">尚未提供来源说明。</p>'}<p class="muted">来源由项目用户填写；CourtLens 不会自动访问或认证上述来源。所有内容均以文本展示。</p>${project.video?.sha256 ? `<p class="muted">已记录视频 SHA-256：<span class="sources">${escapeHTML(project.video.sha256)}</span>。报告仅转录项目中的指纹，未重新校验视频文件。</p>` : ''}</section>
<section><h2>统计口径与使用限制</h2><ul><li>FG% = 命中数 ÷ 已知结果出手数；eFG% =（命中数 + 0.5 × 三分命中数）÷ 已知结果出手数。分母为零时显示「—」。</li><li>未知结果不进入命中率分母，也不计为未中；实际得分不包含罚球或未标注的比赛事件。</li><li>期望得分 = 各条已提供 xFG 的回合之「xFG × 出手分值」之和；缺失值不补零。该值只覆盖已提供 xFG 的子集，不能直接当作整场预测。</li><li>xFG 与坐标均来自用户填写或导入。本产品未声称自动追踪球员、训练预测模型或完成因果分析；合成演练数据不可当作真实 NBA 比赛证据。</li><li>报告展示完整回合结果，属于赛后复盘材料。VTT 与视频录制按结果时间逐步揭示；自由文本标题和笔记不写入提前展示的字幕。</li><li>浏览器录制为实时无声 WebM，单次最多 ${MAX_SECONDS} 秒，可能存在帧级时间误差；原视频音轨不导出。项目批准与回合复核是本地工作流状态。</li></ul></section></main><footer>COURTLENS STUDIO · 本地复盘报告 · 修订 ${escapeHTML(project.revision ?? '—')} · 本文档无需联网，可直接打印或另存为 PDF</footer></article></body></html>`;
}

function abortError() {
  const error = new Error('录制已取消。');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function checkSignal(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function waitFor(target, events, { signal, timeout = 12000, label = '等待媒体响应超时。', action } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const clean = () => {
      clearTimeout(timer);
      events.forEach(event => target.removeEventListener(event, success));
      target.removeEventListener('error', failure);
      signal?.removeEventListener('abort', aborted);
    };
    const finish = (callback, value) => { clean(); callback(value); };
    const success = event => finish(resolve, event);
    const failure = () => finish(reject, new Error('媒体处理失败；请检查视频是否可播放且允许画布读取。'));
    const aborted = () => finish(reject, signal.reason instanceof Error ? signal.reason : abortError());
    events.forEach(event => target.addEventListener(event, success));
    target.addEventListener('error', failure);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(reject, new Error(label)), timeout);
    if (signal?.aborted) { aborted(); return; }
    try { action?.(); } catch (error) { finish(reject, error); }
  });
}

async function seek(video, time, signal, timeout = 12000) {
  checkSignal(signal);
  if (Math.abs(video.currentTime - time) > 0.001 || video.seeking) {
    await waitFor(video, ['seeked'], { signal, timeout, label: '视频定位超时，请检查文件后重试。', action: () => { video.currentTime = time; } });
  }
  if (video.readyState < 2) await waitFor(video, ['loadeddata', 'canplay'], { signal, timeout, label: '视频帧载入超时。' });
  checkSignal(signal);
}

function bounded(promise, timeout, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
    const aborted = () => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : abortError()); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('等待视频编码结束超时。')); }, timeout);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function trimCanvasText(context, text, maxWidth) {
  let result = singleLine(text).slice(0, 500);
  if (context.measureText(result).width <= maxWidth) return result;
  const characters = Array.from(result);
  while (characters.length && context.measureText(`${characters.join('')}…`).width > maxWidth) characters.pop();
  return `${characters.join('')}…`;
}

function paint(context, canvas, video, clip, index, count) {
  const width = canvas.width;
  const height = canvas.height;
  context.fillStyle = '#081e3a';
  context.fillRect(0, 0, width, height);
  const frameHeight = height - 118;
  const scale = Math.min(width / video.videoWidth, frameHeight / video.videoHeight);
  const frameWidth = video.videoWidth * scale;
  const frameDrawHeight = video.videoHeight * scale;
  context.drawImage(video, (width - frameWidth) / 2, 42 + (frameHeight - frameDrawHeight) / 2, frameWidth, frameDrawHeight);
  context.fillStyle = '#c8102e';
  context.fillRect(0, 0, 8, height);
  context.fillStyle = '#ffffff';
  context.font = 'bold 17px system-ui, sans-serif';
  context.fillText('COURTLENS STUDIO', 28, 28);
  context.font = '15px system-ui, sans-serif';
  context.fillStyle = '#b9cde4';
  context.fillText(`片段 ${index + 1}/${count}  ·  无原声`, width - 236, 28);
  context.fillStyle = '#ffffff';
  context.font = 'bold 25px system-ui, sans-serif';
  context.fillText(trimCanvasText(context, `${clip.play.shooter || '未命名球员'}${clip.play.team ? ` · ${clip.play.team}` : ''}`, width - 420), 28, height - 44);
  context.font = '17px system-ui, sans-serif';
  context.fillStyle = '#b9cde4';
  context.fillText(`${clip.play.points === 3 ? '三分' : '两分'}出手 · 原视频 ${stamp(Math.max(clip.in, Math.min(video.currentTime, clip.out - 0.001)), true)}`, 28, height - 17);
  const outcome = currentOutcome(clip.play, Math.min(video.currentTime, clip.out - 0.001));
  context.textAlign = 'right';
  context.fillStyle = outcome === '命中' ? '#8cceff' : '#ffffff';
  context.font = 'bold 26px system-ui, sans-serif';
  context.fillText(outcome, width - 30, height - 31);
  context.textAlign = 'left';
}

function playClip({ video, clip, signal, draw, progress }) {
  return new Promise((resolve, reject) => {
    let frame;
    let watchdog;
    let settled = false;
    let lastTime = video.currentTime;
    let lastMotion = performance.now();
    const clean = () => {
      cancelAnimationFrame(frame);
      clearInterval(watchdog);
      signal.removeEventListener('abort', aborted);
      video.removeEventListener('error', failed);
      video.removeEventListener('ended', ended);
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      video.pause();
      clean();
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish(signal.reason instanceof Error ? signal.reason : abortError());
    const failed = () => finish(new Error('录制期间视频播放失败。'));
    const ended = () => finish(video.currentTime + 0.05 >= clip.out ? undefined : new Error('视频在所选片段结束前已终止。'));
    const tick = () => {
      if (settled) return;
      if (signal.aborted) { aborted(); return; }
      if (video.currentTime >= clip.out) { progress(clip.out); finish(); return; }
      try {
        if (video.currentTime > lastTime + 0.001) { lastTime = video.currentTime; lastMotion = performance.now(); }
        draw();
        progress(video.currentTime);
      } catch (error) { finish(error); return; }
      frame = requestAnimationFrame(tick);
    };
    video.addEventListener('error', failed);
    video.addEventListener('ended', ended);
    signal.addEventListener('abort', aborted, { once: true });
    watchdog = setInterval(() => {
      if (performance.now() - lastMotion > 8000) finish(new Error('视频播放停滞超过 8 秒，录制已停止。'));
    }, 500);
    try {
      checkSignal(signal);
      Promise.resolve(video.play()).then(() => {
        if (!settled) frame = requestAnimationFrame(tick);
      }, error => finish(new Error(`无法播放视频：${error?.message || '请先在页面中手动播放视频后重试。'}`)));
    } catch (error) { finish(error); }
  });
}

/** Real-time canvas recording. Never starts a download and never captures original audio. */
export async function recordPlaylist({ project, video, signal, onProgress } = {}) {
  if (signal?.aborted) throw abortError();
  if (!project || project.status !== 'approved') throw new Error('请先批准项目，再导出视频。');
  const issues = validateProject(project).filter(issue => issue.severity === 'error');
  if (issues.length) throw new Error(`项目尚未通过检查：${issues.map(issue => issue.message).join('；')}`);
  if (!project.plays.length || project.plays.some(play => play.reviewed !== true)) throw new Error('请完成所有回合的人工复核后再导出。');
  if (!project.source?.trim() || !project.video?.id || project.video.needsReattach) throw new Error('请填写来源并重新绑定项目视频。');
  const clips = resolveClips(project);
  const duration = clips.reduce((sum, clip) => sum + clip.out - clip.in, 0);
  if (!clips.length || !finite(duration) || duration <= 0) throw new Error('没有可录制的有效片段。');
  if (duration > MAX_SECONDS) throw new Error(`单次浏览器录制最多 ${MAX_SECONDS} 秒；当前片段共 ${number(duration)} 秒。请缩短播放列表。`);
  if (!video || typeof video.play !== 'function' || !(video.currentSrc || video.src)) throw new Error('请先为播放器载入该项目的视频。');
  if (video.dataset?.mediaId && video.dataset.mediaId !== project.video.id) throw new Error('播放器绑定的媒体不属于当前项目。');
  if (activeVideos.has(video)) throw new Error('该视频正在录制，请等待完成或取消。');
  if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined' || typeof requestAnimationFrame !== 'function') throw new Error('此浏览器不支持视频录制。请使用支持 Canvas 与 MediaRecorder 的桌面浏览器。');
  const mimeType = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find(type => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('此浏览器不支持 WebM 录制。仍可导出报告和 VTT 字幕。');
  if (document.hidden) throw new Error('请保持此页面可见后开始录制。');
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  if (typeof canvas.captureStream !== 'function') throw new Error('此浏览器不支持 Canvas 视频流录制。');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('无法建立视频画布。');
  const controller = new AbortController();
  const recordingSignal = controller.signal;
  const cancel = () => controller.abort(abortError());
  const hidden = () => { if (document.hidden) controller.abort(new Error('页面进入后台，录制已停止。请保持页面可见并重新录制。')); };
  const original = { time: video.currentTime, paused: video.paused, muted: video.muted, volume: video.volume, rate: video.playbackRate, loop: video.loop };
  const chunks = [];
  let stream;
  let recorder;
  let stopPromise;
  let started = false;
  let stopped = false;
  let stopping = false;
  let recordedMs = 0;
  let activeAt = null;
  const activeMilliseconds = () => recordedMs + (activeAt === null ? 0 : performance.now() - activeAt);
  const endActiveSegment = () => {
    recordedMs = activeMilliseconds();
    activeAt = null;
  };
  let progressValue = 0;
  const notify = (progress, stage) => {
    progressValue = Math.max(progressValue, Math.min(1, Math.max(0, progress)));
    if (typeof onProgress === 'function') { try { onProgress({ progress: progressValue, stage }); } catch { /* UI progress cannot invalidate a recording. */ } }
  };
  activeVideos.add(video);
  signal?.addEventListener('abort', cancel, { once: true });
  document.addEventListener('visibilitychange', hidden);
  const overallTimeout = setTimeout(() => controller.abort(new Error('录制超过允许时间，已停止。请检查播放状态后重试。')), duration * 1000 + 40000);
  try {
    checkSignal(recordingSignal);
    notify(0, '准备视频（无原声）');
    video.pause();
    video.muted = true;
    video.playbackRate = 1;
    video.loop = false;
    if (video.readyState < 1) await waitFor(video, ['loadedmetadata'], { signal: recordingSignal, label: '视频元信息读取超时。' });
    if (!finite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) throw new Error('视频时长或画面尺寸无效，无法录制。');
    if (!finite(project.video.duration) || Math.abs(project.video.duration - video.duration) > Math.max(0.25, video.duration * 0.001)) throw new Error('播放器时长与项目绑定视频不一致，请重新绑定正确的视频。');
    if (clips.some(clip => clip.out > video.duration + 0.001)) throw new Error('存在超出视频时长的片段。');
    await seek(video, clips[0].in, recordingSignal);
    paint(context, canvas, video, clips[0], 0, clips.length);
    // Reading a pixel fails early for cross-origin videos that taint the canvas.
    try { context.getImageData(0, 0, 1, 1); } catch { throw new Error('视频来源禁止画布读取；请使用本地文件或允许跨域读取的视频。'); }
    stream = canvas.captureStream(30);
    for (const track of stream.getAudioTracks()) { stream.removeTrack(track); track.stop(); }
    if (!stream.getVideoTracks().length) throw new Error('未能建立可录制的视频轨道。');
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4500000 });
    recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
    recorder.addEventListener('error', event => controller.abort(new Error(`视频编码失败：${event.error?.message || '浏览器录制器返回错误。'}`)));
    stopPromise = new Promise(resolve => recorder.addEventListener('stop', () => {
      stopped = true;
      if (!stopping) controller.abort(new Error('浏览器录制器意外停止，未导出不完整视频。'));
      resolve();
    }, { once: true }));
    await waitFor(recorder, ['start'], { signal: recordingSignal, label: '视频录制器启动超时。', action: () => { activeAt = performance.now(); recorder.start(250); started = true; } });
    let completed = 0;
    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index];
      checkSignal(recordingSignal);
      if (index > 0) {
        notify(completed / duration * 0.97, `定位片段 ${index + 1}/${clips.length}`);
        await seek(video, clip.in, recordingSignal);
        paint(context, canvas, video, clip, index, clips.length);
        await waitFor(recorder, ['resume'], { signal: recordingSignal, label: '无法继续录制。', action: () => { activeAt = performance.now(); recorder.resume(); } });
      }
      await playClip({ video, clip, signal: recordingSignal, draw: () => {
        if (activeMilliseconds() >= MAX_SECONDS * 1000) throw new Error('实际录制时间已达到 180 秒。请略微缩短播放列表后重试。');
        paint(context, canvas, video, clip, index, clips.length);
      }, progress: time => notify((completed + Math.max(0, Math.min(time, clip.out) - clip.in)) / duration * 0.97, `录制片段 ${index + 1}/${clips.length}（无原声）`) });
      completed += clip.out - clip.in;
      if (index < clips.length - 1) await waitFor(recorder, ['pause'], { signal: recordingSignal, label: '无法暂停片段间录制。', action: () => { recorder.pause(); endActiveSegment(); } });
    }
    checkSignal(recordingSignal);
    notify(0.98, '生成 WebM 文件');
    stopping = true;
    recorder.stop();
    endActiveSegment();
    await bounded(stopPromise, 12000, recordingSignal);
    checkSignal(recordingSignal);
    if (recordedMs > MAX_SECONDS * 1000) throw new Error('实际录制时间超过 180 秒。请略微缩短播放列表后重试。');
    const actualType = recorder.mimeType || mimeType;
    if (!/^video\/webm(?:;|$)/i.test(actualType)) throw new Error('浏览器返回了非 WebM 格式，未导出文件。');
    const blob = new Blob(chunks, { type: actualType });
    if (!blob.size) throw new Error('浏览器未生成任何视频数据，请重试。');
    const base = singleLine(project.name || 'courtlens').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || 'courtlens';
    notify(1, '视频已生成（无原声）');
    return { blob, mimeType: actualType, filename: `${base}-r${Number.isInteger(project.revision) ? project.revision : 0}.webm`, duration };
  } finally {
    clearTimeout(overallTimeout);
    signal?.removeEventListener('abort', cancel);
    document.removeEventListener('visibilitychange', hidden);
    video.pause();
    stopping = true;
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* Cleanup must preserve the original error. */ } }
    if (started && !stopped) await bounded(stopPromise, 4000).catch(() => {});
    stream?.getTracks().forEach(track => track.stop());
    try {
      if (finite(original.time) && video.readyState >= 1) await seek(video, original.time, undefined, 3000);
    } catch { /* A removed/broken source may no longer seek; other state is still restored. */ }
    video.muted = original.muted;
    video.volume = original.volume;
    video.playbackRate = original.rate;
    video.loop = original.loop;
    if (!original.paused) { try { await bounded(Promise.resolve(video.play()), 3000); } catch { /* Browser autoplay policy can require the user to resume. */ } }
    canvas.width = 0;
    canvas.height = 0;
    activeVideos.delete(video);
  }
}
