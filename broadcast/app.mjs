import {api, BroadcastApiError} from './api.mjs';
import {initCloudAuth, cloudEnabled, apiToken, signIn} from './auth.mjs';
import {maxAnalysisWindow, providerName, validateAnalysisScope, visualChoices, writingProviders} from './capability_ui.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const num = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const time = value => { const n = Math.max(0, num(value)); return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toFixed(1).padStart(4, '0')}`; };
const date = value => { try { return new Date(value).toLocaleString('zh-CN', {year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); } catch { return ''; } };
const id = () => crypto.randomUUID();
const stepNames = ['选片','看懂','讲清','出片'];
const obsNames = {pass:'传球',shot:'出手',catch:'接球',movement:'跑动',screen:'掩护',result:'结果',other:'其他'};
const beatLabel = value => obsNames[value] || value || '关键一刻';
const statusNames = {queued:'排队中',running:'正在处理',needs_review:'等待人工确认',succeeded:'已完成',failed:'失败',cancelled:'已取消',blocked:'暂不可用'};
const stageNames = {queued:'等待开始',probe:'检查素材',frames:'提取画面',infer:'理解画面',bind:'关联记录',draft:'组织解说',voice:'生成配音',render:'生成影片',verify:'验证成片',done:'已完成'};
const state = {project:null, projects:[], capabilities:null, step:0, view:'library', busy:false, offline:false, job:null, jobTimer:null, jobDeadline:0,
  frames:[], chosenFrameIds:new Set(), currentTime:0, selectedObservationId:null, selectedBeatId:null, createProject:false, annotation:false, annotationPoints:[], annotationActor:'',annotationFrame:null,frameJobId:null,frameRefreshAttempts:0,frameRequestTimes:null,
  release:null, manifest:null, watchOriginal:false, evidenceOpen:false, activeChapter:0,pendingUploadSource:null,analysisScope:null,analysisMediaSha:null};
let noticeTimer=null;

function notify(message, kind = 'info', retry = null) {
  clearTimeout(noticeTimer);
  const el = $('#notice');
  el.className = `notice ${kind}`;
  el.innerHTML = `<span>${esc(message)}</span>${retry ? `<button class="button small secondary" data-action="${esc(retry)}" type="button">重试</button>` : '<button class="button small quiet" data-action="dismiss-notice" type="button">关闭</button>'}`;
  el.hidden = false;
  if(kind!=='error'&&!retry)noticeTimer=setTimeout(()=>{if(el.textContent.includes(message))el.hidden=true;},kind==='success'?3800:6500);
}
function clearNotice() { $('#notice').hidden = true; }
function handleError(error) {
  console.error(error);
  if (error instanceof BroadcastApiError && error.code === 'revision_conflict' && state.project) {
    notify('这个项目刚被其他操作更新。请重新载入后再保存。', 'error', 'reload-project');
  } else if (error instanceof BroadcastApiError && error.code === 'auth_required') {
    state.view='auth';render();notify(error.message,'error');
  } else if (error instanceof BroadcastApiError && error.code === 'frames_timeout' && state.frameJobId) {
    notify('画面取证仍在后台运行。可以稍后查看同一任务的结果。','error','retry-frames');
  } else {
    const extra = error?.fields?.length ? ` ${error.fields.map(f => f.message).join('；')}` : '';
    notify(`${error?.message || '操作没有完成。'}${extra}`, 'error', error?.retryable ? 'retry-current' : null);
  }
}
async function run(action, {message = null, rerender = true} = {}) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add('is-busy');
  try {
    const result = await action();
    if (message) notify(message, 'success');
    if (rerender) render();
    return result;
  } catch (error) { handleError(error); }
  finally { state.busy = false; document.body.classList.remove('is-busy'); }
}
async function bootstrap() {
  const releaseId = new URLSearchParams(location.search).get('release');
  state.offline = false;
  try {
    await initCloudAuth();
    if (cloudEnabled() && !releaseId && !(await apiToken())) {state.view='auth';render();return;}
    if (releaseId) {
      const result = await fetchRelease(releaseId);
      state.release = result?.summary || result?.release || result;
      state.manifest = result?.manifest || null;
      state.view = 'watch';
    } else {
      const [capabilities, listing] = await Promise.all([api.capabilities(), api.projects()]);
      state.capabilities = capabilities;
      state.projects = listing.projects || [];
      const recent = localStorage.getItem('courtlens.broadcast.recentProject');
      if (recent && state.projects.some(project => project.id === recent)) {
        state.project = await api.project(recent);
        state.view = 'studio';
        state.step = state.project.media ? (state.project.story ? 2 : 1) : 0;
      } else state.view = 'library';
    }
  } catch (error) {
    state.offline = true;
    state.view = 'offline';
    handleError(error);
  }
  render();
}
async function fetchRelease(releaseId) {
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(releaseId)) throw new Error('成片链接无效。');
  if(!cloudEnabled()) return api.release(releaseId);
  const prefix=`/releases/${encodeURIComponent(releaseId)}`;
  const [summaryResponse,manifestResponse]=await Promise.all([fetch(`${prefix}/summary.json`,{cache:'no-store'}),fetch(`${prefix}/manifest.json`,{cache:'no-store'})]);
  if(!summaryResponse.ok||!manifestResponse.ok) throw new Error('这版成片暂时无法读取，请核对链接或稍后重试。');
  const summary=await summaryResponse.json(),manifest=await manifestResponse.json();
  if(summary.id!==releaseId||manifest.schema!=='courtlens-broadcast-release/1')throw new Error('成片记录与链接不匹配。');
  return {summary:{...summary,videoUrl:`${prefix}/film.mp4`,captionsUrl:`${prefix}/captions.vtt`,manifestUrl:`${prefix}/manifest.json`},manifest};
}
function setProject(project, preferredStep = null) {
  state.project = project;
  state.view = 'studio';
  state.frames = [];state.annotationFrame=null;state.annotation=false;state.frameJobId=null;state.frameRefreshAttempts=0;state.frameRequestTimes=null;
  state.chosenFrameIds.clear();
  state.selectedObservationId = null;
  state.selectedBeatId = project?.story?.beats?.[0]?.id || null;
  state.currentTime = 0;
  state.analysisScope=null;state.analysisMediaSha=project?.media?.sha256||null;
  state.step = preferredStep ?? (project.media ? 1 : 0);
  localStorage.setItem('courtlens.broadcast.recentProject', project.id);
  history.replaceState(null, '', '/broadcast/');
  render();
}
async function refreshProject() {
  if (!state.project) return;
  state.project = await api.project(state.project.id);
  render();
}
function saveProject(result) {
  state.project = result;
  state.selectedBeatId = result?.story?.beats?.find(b => b.id === state.selectedBeatId)?.id || result?.story?.beats?.[0]?.id || null;
  render();
}
function safeSourceKind(media) { return media?.source?.kind === 'synthetic' ? '合成演练素材' : media?.source?.kind === 'official-provided' ? '官方提供素材 · 来源待核' : '用户提供素材'; }
function modeLabel(project) { return project?.mode === 'manual' ? '人工辅助制作' : '计划使用自动辅助 · 结果须人工确认'; }
function validReview(project) { return !!(project?.review?.result === 'approved' && project.review.projectRevision === project.revision); }
function latestRelease(project) { return project?.releases?.at(-1) || null; }
function mediaDuration() { return num(state.project?.media?.duration); }
function analysisWindow() {
  const mediaSha=state.project?.media?.sha256||null;
  if(state.analysisMediaSha!==mediaSha){state.analysisMediaSha=mediaSha;state.analysisScope=null;}
  return state.analysisScope || {start:0,end:Math.min(48,mediaDuration())};
}
function updateAnalysisHint() {
  const form=$('[data-form="analyze"]'),hint=$('#analysis-window-hint');
  if(!form||!hint)return;
  const option=form.querySelector('[name="analysisChoice"]')?.selectedOptions[0];
  const provider=visualChoices(state.capabilities).find(choice=>choice.provider.id===option?.dataset.provider&&choice.strategy===option?.dataset.strategy);
  if(!provider)return;
  const start=Number(form.elements.scopeStart.value),end=Number(form.elements.scopeEnd.value);
  hint.textContent=`仅分析所选 ${Number.isFinite(start)?time(start):'—'}—${Number.isFinite(end)?time(end):'—'}；此方式单次最多 ${maxAnalysisWindow(provider.provider,provider.strategy)} 秒。源片和成片范围不变。`;
}
function videoRange() { return state.manifest?.story?.sourceRange || state.manifest?.sourceRange || {start:0,end:state.release?.duration || 0}; }
function originalUrl() { return state.manifest?.source?.mediaUrl || null; }
function chapterBeats() { return state.manifest?.story?.beats || state.manifest?.beats || []; }
function compiledBeatText(beat) { return state.manifest?.compiledBeats?.find(item => item.beatId === beat?.id)?.compiledText || (beat?.text?.includes('{{metric:') ? '这一段引用的数字请查看发布记录。' : beat?.text || ''); }
function draftMetric(beat) {
  const bundle=state.project?.metrics, record=bundle?.records?.find(row=>row.id===beat?.metricRecordId);
  const entry=record && bundle?.dictionary?.metrics?.[record.metricId];
  if(!record||!entry||!finite(record.value))return null;
  const value=entry.unit==='probability' ? `${(record.value*100).toFixed(1)}%` : entry.unit==='percent' ? `${record.value.toFixed(1)}%` : `${record.value} ${entry.unit}`;
  const provenance=record.provenance||entry.provenance||bundle.provenance||bundle.dictionary?.provenance||{};
  return {label:entry.label,value,source:provenance.source||'来源未核验',granularity:record.scope?.granularity||''};
}
function draftBeat() {
  const form=$('[data-form="story"]');
  const rows=(state.project?.story?.beats||[]).map(beat=>{
    if(beat.id!==state.selectedBeatId||!form)return beat;
    const fd=new FormData(form);
    return {...beat,sourceStart:num(fd.get('beatStart'),beat.sourceStart),sourceEnd:num(fd.get('beatEnd'),beat.sourceEnd),text:String(fd.get('beatText')||''),metricRecordId:String(fd.get('metricRecordId')||'')||null,secondaryLabel:String(fd.get('secondaryLabel')||'')};
  });
  return rows.find(row=>state.currentTime>=row.sourceStart&&state.currentTime<row.sourceEnd)||null;
}
function updateDraftOverlay() {
  const layer=$('#draft-overlay');if(!layer)return;
  const beat=draftBeat(), t=state.currentTime;
  layer.hidden=!beat||t<beat.sourceStart||t>=beat.sourceEnd;
  if(layer.hidden)return;
  const metric=draftMetric(beat);
  const phrase=metric ? beat.text.replace(`{{metric:${beat.metricRecordId}}`,metric.value) : beat.text;
  $('#draft-caption').textContent=phrase;
  const card=$('#draft-metric');card.hidden=!metric;
  if(metric)card.innerHTML=`<span>${esc(metric.label)}</span><strong>${esc(metric.value)}</strong><small>${esc(`${metric.granularity} · ${metric.source}`)}</small>`;
  const arrow=$('#draft-arrow'), annotation=beat.annotation;
  const observation=annotation&&state.project.observations?.find(row=>row.id===annotation.sourceObservationId);
  const geometry=observation?.geometry;
  const visible=!!(geometry&&observation.segmentId===geometry.segmentId&&t>=Math.max(geometry.validFrom,beat.sourceStart)&&t<Math.min(geometry.validTo,beat.sourceEnd));
  arrow.hidden=!visible;
  if(visible&&annotation.points?.length===2){const [a,b]=annotation.points;arrow.innerHTML=`<svg aria-hidden="true"><defs><marker id="draft-arrow-head" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#ff992b"/></marker></defs><line x1="${a.x*100}%" y1="${a.y*100}%" x2="${b.x*100}%" y2="${b.y*100}%" stroke="#ff992b" stroke-width="4" marker-end="url(#draft-arrow-head)"/></svg>`;}
}
function sourceTimeOfVideo(video) { return state.view === 'watch' && !state.watchOriginal ? video.currentTime + num(videoRange().start) : video.currentTime; }
function playbackTimeForSource(t) { return state.view === 'watch' && !state.watchOriginal ? Math.max(0, t - num(videoRange().start)) : t; }
function beforeRender() {
  const video = $('#broadcast-video');
  if (!video) return null;
  if (Number.isFinite(video.currentTime)) state.currentTime = sourceTimeOfVideo(video);
  return {playing: !video.paused, volume: video.volume, muted: video.muted};
}
function afterRender(playback) {
  const video = $('#broadcast-video');
  if (!video) return;
  const restore = () => {
    const target = playbackTimeForSource(state.currentTime);
    if (Number.isFinite(target) && Math.abs(video.currentTime - target) > .08) video.currentTime = clamp(target, 0, Number.isFinite(video.duration) ? video.duration : 99999);
    if (playback) { video.volume = playback.volume; video.muted = playback.muted; if (playback.playing) video.play().catch(() => {}); }
  };
  if (video.readyState >= 1) restore(); else video.addEventListener('loadedmetadata', restore, {once:true});
}
function render() {
  const playback = beforeRender();
  const workspace = $('#workspace');
  if (state.view === 'offline') workspace.innerHTML = renderOffline();
  else if (state.view === 'auth') workspace.innerHTML = renderAuth();
  else if (state.view === 'watch') workspace.innerHTML = renderWatch();
  else if (state.view === 'studio' && state.project) workspace.innerHTML = renderStudio();
  else workspace.innerHTML = renderLibrary();
  $('#topbar-context').textContent = state.view === 'studio' ? state.project?.title || '制作台' : state.view === 'watch' ? '成片观赏' : '一次进攻，讲清一个选择';
  $('#project-picker-button').hidden = state.view === 'watch';
  afterRender(playback);
  updateTimeUI();
  updateAnalysisHint();
}
function renderOffline() {
  return `<section class="offline"><span class="eyebrow">连接中断</span><h1>制作台暂时无法连接</h1><p>请启动本机 CourtLens 服务，再点击重新连接。已保存的项目和成片仍在原工作目录。</p><button class="button" data-action="reconnect" type="button">重新连接</button></section>`;
}
function renderAuth() {
  return `<section class="offline"><span class="eyebrow">BROADCAST / SECURE STUDIO</span><h1>登录后继续制作</h1><p>制作项目、调用画面理解与导出影片需要你的制作账号。已公开的成片仍可通过专属链接观看。</p><button class="button" data-action="sign-in" type="button">登录制作台</button></section>`;
}
function renderLibrary() {
  const tiles = state.projects.map(project => `<button class="project-tile" data-action="open-project" data-id="${esc(project.id)}" type="button"><span class="eyebrow">${project.latestReleaseId ? '已有成片' : project.hasMedia ? '制作中' : '等待选片'}</span><strong>${esc(project.title)}</strong><small>更新于 ${esc(date(project.updatedAt))}</small><span class="tile-foot">打开制作台 <span aria-hidden="true">↗</span></span></button>`).join('');
  return `<section class="hero"><span class="eyebrow">COURTLENS / BROADCAST STUDIO</span><h1>让一个回合，<br>值得再看一遍。</h1><p>放入真实视频。停在关键画面。只讲有依据的选择，做成可以回看的解说短片。</p><div class="hero-line"></div></section><section class="library"><div class="library-head"><h2>制作项目</h2><span class="status-pill">${state.projects.length} 个项目</span></div><div class="library-list"><button class="project-tile new-project" data-action="new-project" type="button"><span class="plus" aria-hidden="true">＋</span><strong>开始一个新回合</strong><small>上传视频后即可进入制作台</small></button>${tiles}</div>${state.createProject ? `<form class="new-project-form" data-form="create-project"><label class="field"><span>项目名称</span><input name="title" maxlength="100" required placeholder="例如：第四节最后一次进攻"></label><label class="field"><span>制作方式</span><select name="mode"><option value="manual">人工辅助制作</option><option value="assisted">自动辅助理解</option></select></label><button class="button" type="submit">创建项目</button></form>` : ''}${!state.projects.length ? `<p class="empty-copy" style="margin-top:20px">这里还没有项目。创建后可上传自己的授权片段；本页不会把演练视频当成真实 NBA 比赛。</p>` : ''}</section>`;
}
function renderStudio() {
  const p = state.project;
  const pill = validReview(p) ? '<span class="status-pill good">已人工审核</span>' : p.review || (p.releases?.length && p.story) ? '<span class="status-pill warn">内容已修改 · 需重新审核</span>' : '<span class="status-pill">制作中</span>';
  const steps = stepNames.map((name, index) => `<button data-action="step" data-step="${index}" type="button" class="${state.step === index ? 'active' : ''}" ${index && !p.media ? 'disabled' : ''}><span class="number">0${index + 1}</span><b>${name}</b><small>${['上传与来源','观察与证据','三段以内解说','审核与真实成片'][index]}</small></button>`).join('');
  return `<div class="studio-header"><div class="project-meta"><div><span class="eyebrow">BROADCAST / PRODUCTION</span><h1>${esc(p.title)}</h1><p>${esc(modeLabel(p))} · 修订 ${p.revision} · 最近保存 ${esc(date(p.updatedAt))}</p></div>${pill}</div><nav class="step-nav" aria-label="制作步骤">${steps}</nav></div><div class="studio-layout"><div class="stage-column">${renderStage()}${p.media ? renderTimeline() : ''}</div><aside class="work-panel" aria-label="当前制作步骤">${renderPanel()}</aside></div>`;
}
function renderStage() {
  const p = state.project;
  if (!p.media) return `<div class="stage empty"><div class="stage-placeholder"><div class="court-lines" aria-hidden="true"></div><h2>从真实画面开始</h2><p>先上传一个你有权使用的回合片段。画面会在这里播放，之后每条观察都能跳回源片核对。</p></div></div><div class="stage-caption"><strong>源片画面</strong><span>上传后显示真实时长与分辨率</span></div>`;
  const points = state.annotationPoints;
  const aspect = num(p.media.width,16) / Math.max(1,num(p.media.height,9));
  const layerStyle = aspect >= 16/9 ? `width:100%;height:${100*(16/9)/aspect}%;` : `height:100%;width:${100*aspect/(16/9)}%;`;
  const arrow = points.length === 2 ? `<line x1="${points[0].x * 100}%" y1="${points[0].y * 100}%" x2="${points[1].x * 100}%" y2="${points[1].y * 100}%" stroke="#ff985b" stroke-width="4" marker-end="url(#arrow-head)"/>` : points.length === 1 ? `<circle cx="${points[0].x * 100}%" cy="${points[0].y * 100}%" r="6" fill="#ff985b"/>` : '';
  return `<div class="stage"><video id="broadcast-video" controls preload="metadata" playsinline src="${esc(p.media.mediaUrl)}" ${p.media.posterUrl ? `poster="${esc(p.media.posterUrl)}"` : ''} aria-label="源片视频"></video>${state.annotationFrame ? `<img class="annotation-reference" src="${esc(state.annotationFrame.url)}" alt="源片 ${time(state.annotationFrame.actualTime)} 的实际取证画面">` : ''}${state.step===2&&p.story&&!state.annotation ? `<div id="draft-overlay" class="draft-overlay" hidden><div id="draft-arrow" class="draft-arrow" style="${layerStyle}" hidden></div><span class="draft-provenance">${p.mode==='manual'?'人工辅助制作':'人工复核故事'} · 草稿预览</span><div id="draft-metric" class="draft-metric" hidden></div><div id="draft-caption" class="draft-caption"></div></div>` : ''}${state.step===2&&p.story&&!state.annotation ? '' : `<div class="stage-badge">${state.annotationFrame ? `FRAME · ${time(state.annotationFrame.actualTime)} · 人工标注` : `SOURCE · ${esc(safeSourceKind(p.media))}`}</div>`}${state.annotation ? `<div class="annotation-layer" style="${layerStyle}" data-action="annotation-point" aria-label="在视频画面中依次选箭头起点和终点"><svg aria-hidden="true"><defs><marker id="arrow-head" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#ff985b"/></marker></defs>${arrow}</svg><div class="annotation-instructions">${points.length ? '再点一下箭头终点' : '在这帧画面选箭头起点'}</div></div>` : ''}</div><div class="stage-caption"><strong>${esc(p.media.filename)}</strong><span>${time(p.media.duration)} · ${p.media.width}×${p.media.height}</span><span class="right">${esc(safeSourceKind(p.media))}</span></div>`;
}
function renderTimeline() {
  const p = state.project, duration = mediaDuration();
  const obs = (p.observations || []).map((o,index) => `<button class="${o.review?.status === 'accepted' ? 'accepted' : ''}" data-action="seek-observation" data-id="${esc(o.id)}" type="button" title="${esc(`${obsNames[o.type] || '观察'} ${time(o.start)}`)}" aria-label="跳到第 ${index+1} 条观察：${esc(o.description)}" style="left:${clamp(num(o.anchorTime ?? o.start) / Math.max(duration,.001) * 100,0,100)}%"></button>`).join('');
  const beats = (p.story?.beats || []).map((b,index) => `<button class="beat" data-action="seek-beat" data-id="${esc(b.id)}" type="button" title="${esc(`${b.label} ${time(b.sourceStart)}`)}" aria-label="跳到第 ${index+1} 段：${esc(b.label)}" style="left:${clamp(num(b.sourceStart) / Math.max(duration,.001) * 100,0,100)}%"></button>`).join('');
  const frames = state.frames.map(f => `<button class="frame-thumb" data-action="seek-frame" data-time="${f.actualTime}" type="button"><img src="${esc(f.url)}" alt="源片 ${time(f.actualTime)} 的真实取证帧"><span>${time(f.actualTime)}</span></button>`).join('');
  return `<div class="timeline"><div class="timeline-top"><strong>源片时间线</strong><span id="time-display">${time(state.currentTime)} / ${time(duration)}</span></div><label class="visually-hidden" for="source-seek">源片时间</label><div class="seek-wrap"><input id="source-seek" data-seek type="range" min="0" max="${duration}" step="0.04" value="${clamp(state.currentTime,0,duration)}"></div><div class="timeline-markers" aria-label="观察与故事时间点">${obs}${beats}</div><div class="timeline-scale"><span>00:00.0</span><span>${time(duration / 2)}</span><span>${time(duration)}</span></div><div class="utility-row"><button type="button" class="button quiet small" data-action="frame-back">← 逐帧后退</button><button type="button" class="button quiet small" data-action="frame-forward">逐帧前进 →</button><button type="button" class="button secondary small" data-action="capture-frame">取证当前画面</button>${frames ? `<details class="frame-drawer"><summary>取证帧 · ${state.frames.length}</summary><div class="frame-strip" aria-label="实际抽取的取证帧">${frames}</div></details>` : ''}</div></div>`;
}
function renderPanel() { return [renderPickPanel,renderObservePanel,renderStoryPanel,renderDeliverPanel][state.step](); }
function panel(title, intro, body, kicker = '') { return `<div class="panel-head"><span class="eyebrow">${esc(kicker || `STEP 0${state.step+1}`)}</span><h2>${title}</h2><p>${intro}</p></div><div class="panel-body">${body}</div>`; }
function renderPickPanel() {
  const p = state.project, media = p.media;
  const upload = `<section class="panel-section"><h3>${media ? '更换源片' : '上传源片'}</h3>${media ? '<p class="inline-note">更换视频会让旧观察与审核失效；历史成片依然可看。</p>' : ''}<form data-form="upload"><label class="field"><span>视频文件</span><input type="file" name="video" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" required><small>单片不超过 256 MiB / 180 秒；上传后由服务探测真实时长与帧率。</small></label><label class="field"><span>素材来源</span><select name="sourceKind"><option value="user-provided" ${media?.source?.kind === 'user-provided' ? 'selected' : ''}>我提供的素材</option><option value="official-provided" ${media?.source?.kind === 'official-provided' ? 'selected' : ''}>赛事方提供 · 待核验</option><option value="synthetic" ${media?.source?.kind === 'synthetic' ? 'selected' : ''}>合成演练素材</option></select></label><label class="field"><span>来源说明</span><input name="sourceLabel" required maxlength="160" value="${esc(media?.source?.label || '')}" placeholder="例如：本人拍摄的训练片段"></label><label class="field"><span>使用范围与授权说明</span><textarea name="rightsNote" required maxlength="600" placeholder="请写明这段素材可用于什么展示">${esc(media?.source?.rightsNote || '')}</textarea></label><button class="button full" type="submit">${media ? '上传并替换源片' : '上传并开始制作'}</button></form></section>`;
  const details = media ? `<section class="panel-section"><h3>视频信息</h3><div class="info-list"><div class="info-row"><span>真实时长</span><strong>${time(media.duration)}</strong></div><div class="info-row"><span>画面尺寸</span><strong>${media.width} × ${media.height}</strong></div><div class="info-row"><span>帧率</span><strong>${media.fpsNumerator}/${media.fpsDenominator}${media.variableFrameRate ? ' · 可变帧率' : ''}</strong></div><div class="info-row"><span>来源标签</span><strong>${esc(media.source?.label || '未填写')}</strong></div></div></section>` : '';
  const project = `<section class="panel-section"><h3>项目设置</h3><form data-form="project-settings"><label class="field"><span>项目标题</span><input name="title" required maxlength="100" value="${esc(p.title)}"></label><label class="field"><span>制作方式</span><select name="mode"><option value="manual" ${p.mode === 'manual' ? 'selected' : ''}>人工辅助制作</option><option value="assisted" ${p.mode === 'assisted' ? 'selected' : ''}>自动辅助理解</option></select><small>模型没有实际运行时，成片只标注“人工辅助制作”。</small></label><button class="button secondary full" type="submit">保存项目设置</button></form></section>`;
  const context = `<details class="panel-section"><summary>比赛信息与当场名单（可选）</summary><p class="help-text">只有使用赛事指标或确认球员姓名时才需要填写；日期和当场名单可避免认错人。</p><form data-form="context"><label class="field"><span>比赛 ID</span><input name="gameId" maxlength="80" value="${esc(p.context?.gameId || '')}"></label><div class="field-row"><label class="field"><span>比赛日期</span><input name="gameDate" type="date" value="${esc(p.context?.gameDate || '')}"></label><label class="field"><span>赛季 ID</span><input name="seasonId" maxlength="80" value="${esc(p.context?.seasonId || '')}"></label></div><div class="field-row"><label class="field"><span>赛季类型</span><input name="seasonType" maxlength="80" value="${esc(p.context?.seasonType || '')}"></label><label class="field"><span>进攻方 ID</span><input name="offenseTeamId" maxlength="80" value="${esc(p.context?.offenseTeamId || '')}"></label></div><label class="field"><span>当场名单（每行：球员ID,姓名,球队ID,号码）</span><textarea name="roster" placeholder="player-1,球员甲,team-1,7">${esc((p.context?.roster || []).map(person=>[person.id,person.name,person.teamId,person.jersey||''].join(',')).join('\n'))}</textarea></label><button class="button quiet full" type="submit">保存比赛信息</button></form></details>`;
  const sourceEdit = media ? `<details class="panel-section"><summary>修改素材来源说明</summary><form data-form="source-settings" style="margin-top:12px"><label class="field"><span>素材来源</span><select name="sourceKind"><option value="user-provided" ${media.source?.kind==='user-provided'?'selected':''}>我提供的素材</option><option value="official-provided" ${media.source?.kind==='official-provided'?'selected':''}>赛事方提供 · 待核验</option><option value="synthetic" ${media.source?.kind==='synthetic'?'selected':''}>合成演练素材</option></select></label><label class="field"><span>来源说明</span><input name="sourceLabel" value="${esc(media.source?.label||'')}" required maxlength="160"></label><label class="field"><span>使用范围与授权说明</span><textarea name="rightsNote" maxlength="500">${esc(media.source?.rightsNote||'')}</textarea></label><button class="button quiet full" type="submit">保存来源说明</button></form></details>` : '';
  const metrics = `<section class="panel-section"><h3>官方数据（可选）</h3><p class="empty-copy">可以导入与源片对应的指标文件。未核对的数字不会自动放进解说画面。</p><form data-form="metrics-import"><label class="field"><span>指标文件 · JSON</span><input type="file" name="metrics" accept=".json,application/json" required></label><button class="button quiet full" type="submit">导入指标并校验</button></form>${p.metrics ? `<p class="inline-note good">已导入 ${esc(p.metrics.name || '指标资料')} · ${p.metrics.records?.length || 0} 条记录。事件数字需要在「看懂」中逐条绑定。</p>` : ''}</section>`;
  return panel('选片', '一段有来源的真实视频，是后面每一句解说的起点。', `${details}${upload}${sourceEdit}${project}${context}${metrics}${media ? '<button class="button full" data-action="next-step" type="button">进入画面观察 →</button>' : ''}`);
}
function renderObservePanel() {
  const p = state.project;
  const selected = (p.observations || []).find(o => o.id === state.selectedObservationId);
  const semantic = (state.capabilities?.providers || []).filter(x => x.kind === 'semantic' && (x.modalities?.includes('video') || x.modalities?.includes('image')) && !x.id.endsWith('-story'));
  const choices = visualChoices(state.capabilities);
  const cv = (state.capabilities?.providers || []).filter(x => x.kind === 'cv');
  const cvOptions = cv.filter(x => x.available).map(x => `<option value="${esc(x.id)}">视觉追踪 · ${esc(x.verified ? '已实测' : '尚未实测')}</option>`).join('');
  const analysisOptions = choices.map(({provider,strategy,label}) => `<option value="${esc(provider.id)}::${strategy}" data-provider="${esc(provider.id)}" data-strategy="${strategy}">${esc(providerName(provider))} · ${label} · ${provider.verified ? '已实测' : '尚未实测'}</option>`).join('');
  const scope = analysisWindow();
  const analysis = `<details class="panel-section" ${p.mode==='assisted'?'open':''}><summary>自动辅助（可选）</summary>${choices.length ? `<form data-form="analyze"><label class="field"><span>画面理解方式</span><select name="analysisChoice">${analysisOptions}</select></label><div class="field-row"><label class="field"><span>分析从 · 秒</span><input name="scopeStart" type="number" min="0" max="${mediaDuration()}" step="0.01" value="${scope.start}" required></label><label class="field"><span>分析到 · 秒</span><input name="scopeEnd" type="number" min="0" max="${mediaDuration()}" step="0.01" value="${scope.end}" required></label></div><p class="help-text" id="analysis-window-hint"></p><button class="button secondary full" type="submit">仅分析所选片段</button></form>` : `<p class="inline-note">当前没有可用的自动画面理解。可以继续通过人工观察完成成片；未运行的模型不会被标为已看懂视频。</p>`}${cvOptions ? `<form data-form="cv" style="margin-top:10px"><label class="field"><span>视觉追踪</span><select name="providerId">${cvOptions}</select></label><button class="button quiet full" type="submit">运行视觉辅助</button></form>` : ''}${semantic.some(x => x.available && !x.verified) ? `<button class="button quiet full" data-action="probe-provider" type="button" style="margin-top:9px">先实测画面理解</button>` : ''}<p class="help-text">模型生成的是待核对候选；没有运行或没有人工确认时，不会作为已看懂画面的证据。</p></details>`;
  const list = (p.observations || []).slice().sort((a,b) => a.start-b.start).map(o => `<div class="record ${o.id === state.selectedObservationId ? 'selected' : ''}"><div class="record-top"><strong>${time(o.start)} · ${esc(obsNames[o.type] || '观察')}</strong><span class="tag ${o.review?.status === 'accepted' ? 'good' : o.review?.status === 'rejected' ? 'bad' : 'orange'}">${o.review?.status === 'accepted' ? '已接受' : o.review?.status === 'rejected' ? '已排除' : '待核对'}</span></div><p>${esc(o.description)}</p><small>${o.source?.kind === 'manual' ? '人工记录' : o.source?.kind === 'cv' ? '视觉候选' : '模型候选'} · ${time(o.start)}—${time(o.end)}</small><div class="record-actions"><button data-action="select-observation" data-id="${esc(o.id)}" type="button">编辑 / 核对</button><button data-action="seek-observation" data-id="${esc(o.id)}" type="button">回看画面</button></div></div>`).join('');
  const observations = `<section class="panel-section"><h3>这一回合发生了什么</h3><div class="observation-list">${list || '<p class="empty-copy">还没有观察。播放源片，停在关键动作，写下一句你确实看见的内容。</p>'}</div></section>`;
  const frameChecks = [...state.frames.map(f => `<label class="check"><input type="checkbox" name="frameId" value="${esc(f.id)}" ${selected?.frameIds?.includes(f.id) || state.chosenFrameIds.has(f.id) ? 'checked' : ''}><span>引用 ${time(f.actualTime)} 的真实画面</span></label>`),...(selected?.frameIds||[]).filter(fid=>!state.frames.some(f=>f.id===fid)).map(fid=>`<label class="check"><input type="checkbox" name="frameId" value="${esc(fid)}" checked><span>已引用的取证帧 ${esc(fid.slice(0,8))}</span></label>`)].join('');
  const roster = (p.context?.roster || []).map(person => `<option value="${esc(person.id)}" ${selected?.playerIds?.includes(person.id) ? 'selected' : ''}>${esc(person.name)} · ${esc(person.jersey || '号码未知')}</option>`).join('');
  const edit = `<section class="panel-section"><h3>${selected ? '核对这条观察' : '在此添加观察'}</h3><form data-form="observation"><label class="field"><span>动作类型</span><select name="type">${Object.entries(obsNames).map(([key,label]) => `<option value="${key}" ${selected?.type === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="field-row triple"><label class="field"><span>开始 · 秒</span><input type="number" name="start" min="0" max="${mediaDuration()}" step="0.01" required value="${selected ? selected.start : Math.max(0,state.currentTime-.5).toFixed(2)}"></label><label class="field"><span>结束 · 秒</span><input type="number" name="end" min="0" max="${mediaDuration()}" step="0.01" required value="${selected ? selected.end : Math.min(mediaDuration(),state.currentTime+1).toFixed(2)}"></label><label class="field"><span>锚点 · 秒</span><input type="number" name="anchorTime" min="0" max="${mediaDuration()}" step="0.01" value="${selected?.anchorTime ?? state.currentTime.toFixed(2)}"></label></div><label class="field"><span>画面中可确认的事实</span><textarea name="description" required maxlength="800" placeholder="例如：持球人把球传向左侧底角">${esc(selected?.description || '')}</textarea></label>${roster ? `<label class="field"><span>确认的球员（可留空）</span><select name="playerId"><option value="">身份未确认</option>${roster}</select></label>` : `<p class="help-text">未导入当场名单，先用“持球人”等画面描述，不猜球员姓名。</p>`}${frameChecks ? `<div class="minor-title">取证画面</div>${frameChecks}` : `<p class="help-text">先点时间线的「取证当前画面」，可将真实帧附在观察上。</p>`}<label class="field"><span>核对者</span><input name="actor" maxlength="80" placeholder="你的姓名或制作署名"></label><div class="button-row"><button class="button" type="submit">${selected ? '保存修改' : '保存观察'}</button>${selected && selected.review?.status !== 'accepted' ? `<button class="button orange" data-action="accept-observation" data-id="${esc(selected.id)}" type="button">确认属实</button>` : ''}</div>${selected ? `<div class="button-row" style="margin-top:8px"><button class="button quiet" data-action="new-observation" type="button">新建下一条</button><button class="button danger" data-action="reject-observation" data-id="${esc(selected.id)}" type="button">排除这条</button></div>` : ''}</form></section>`;
  const bindingObs = (p.observations || []).filter(o => o.review?.status === 'accepted');
  const metricRecords = p.metrics?.records || [];
  const bindings = `<section class="panel-section"><h3>事件与数字核对（可选）</h3><p class="empty-copy">只有确认了源片时刻、赛事事件和对应数据记录，数字才可进入画面。</p>${(p.bindings || []).map(b => `<div class="record"><strong>${esc(b.officialEventId || b.shotId || '人工时刻映射')}</strong><p>${esc(b.reason)}</p><small>${b.status === 'confirmed' ? '已确认' : '待核对'} · ${time(b.timeMapping?.videoTime)}</small></div>`).join('')}<form data-form="binding" style="margin-top:14px"><label class="field"><span>对应观察</span><select name="observationId" required><option value="">选择已接受的观察</option>${bindingObs.map(o => `<option value="${esc(o.id)}">${time(o.start)} · ${esc(o.description.slice(0,35))}</option>`).join('')}</select></label><div class="field-row"><label class="field"><span>赛事事件 ID（如有）</span><input name="officialEventId" maxlength="100"></label><label class="field"><span>出手 ID（如有）</span><input name="shotId" maxlength="100"></label></div><label class="field"><span>确认依据</span><textarea name="reason" maxlength="500" required placeholder="例如：比分牌时钟与画面出手动作逐帧核对"></textarea></label>${metricRecords.length ? `<div class="minor-title">绑定的指标记录</div>${metricRecords.map(r => `<label class="check"><input type="checkbox" name="metricRecordId" value="${esc(r.id)}"><span>${esc(p.metrics.dictionary?.metrics?.[r.metricId]?.label || r.metricId)} · ${esc(r.id)}</span></label>`).join('')}` : ''}<button class="button secondary full" type="submit" ${bindingObs.length ? '' : 'disabled'}>确认事件映射</button></form></section>`;
  const imports = `<section class="panel-section"><h3>视觉结果导入（可选）</h3><form data-form="cv-import"><label class="field"><span>受检视觉结果 · JSON</span><input name="cvFile" type="file" accept=".json,application/json" required></label><button type="submit" class="button quiet full">导入为待核对候选</button></form><p class="help-text">导入结果与真实运行分开标注；任何候选都要人工确认。</p></section>`;
  return panel('看懂', '先看画面、再写观察。自动建议只有被人确认后才进入故事。', `${edit}${observations}${analysis}${bindings}${imports}<button class="button full" data-action="next-step" type="button">进入故事编辑 →</button>`);
}
function renderStoryPanel() {
  const p = state.project, story = p.story;
  const accepted = (p.observations || []).filter(o => o.review?.status === 'accepted');
  const storyProviders = writingProviders(state.capabilities);
  const initialStoryButtons = storyProviders.map(provider => `<button class="button secondary" data-action="model-story" data-provider="${esc(provider.id)}" type="button" ${accepted.length ? '' : 'disabled'}>${esc(providerName(provider))}拟稿 · ${provider.verified ? '已实测' : '尚未实测'}</button>`).join('');
  const reviseStoryButtons = storyProviders.map(provider => `<button class="button quiet" data-action="model-story" data-provider="${esc(provider.id)}" type="button">${esc(providerName(provider))}重拟</button>`).join('');
  const modelJob=state.job?.type==='model-story' ? `<div class="job-status"><h3>${esc(statusNames[state.job.status]||state.job.status)} · 辅助拟稿</h3><p>${esc(state.job.error?.message||'正在依据已确认的观察组织故事。')}</p>${['queued','running'].includes(state.job.status)?'<button class="button quiet small" data-action="refresh-job" type="button">刷新进度</button>':''}</div>` : '';
  if (!story) return panel('讲清', '只挑真正值得讲的一个选择。最多三段，不必凑满。', `<section class="panel-section"><h3>从已确认观察开始</h3><p class="empty-copy">${accepted.length ? `已有 ${accepted.length} 条已确认观察。可以生成第一版，再调整句子和时间。` : '还没有已确认的观察。请回到「看懂」核对至少一条画面事实。'}</p><div class="button-row" style="margin-top:16px"><button class="button" data-action="template-story" type="button" ${accepted.length ? '' : 'disabled'}>生成初稿</button><button class="button secondary" data-action="manual-story" type="button" ${accepted.length ? '' : 'disabled'}>手写初稿</button>${initialStoryButtons}</div>${storyProviders.length ? '<p class="help-text">辅助拟稿只读取已确认的观察和事件映射，生成后仍需人工逐句核对。</p>' : ''}${modelJob}</section><button class="button quiet full" data-action="step" data-step="1" type="button">← 返回画面观察</button>`);
  const selected = story.beats.find(b => b.id === state.selectedBeatId) || story.beats[0];
  const beats = story.beats.map((beat,index) => `<button class="record ${selected?.id === beat.id ? 'selected' : ''}" data-action="select-beat" data-id="${esc(beat.id)}" type="button" style="text-align:left;width:100%;color:inherit"><div class="record-top"><strong>0${index+1} / ${esc(beatLabel(beat.label))}</strong><span class="tiny-pill">${time(beat.sourceStart)}</span></div><p>${esc(beat.text)}</p><small>${time(beat.sourceStart)}—${time(beat.sourceEnd)}</small></button>`).join('');
  const metrics = (p.metrics?.records || []).filter(record => (p.bindings || []).some(b => b.status === 'confirmed' && b.metricRecordIds?.includes(record.id)));
  const metricOptions = metrics.map(r => `<option value="${esc(r.id)}" ${selected?.metricRecordId === r.id ? 'selected' : ''}>${esc(p.metrics.dictionary?.metrics?.[r.metricId]?.label || r.metricId)} · ${esc(r.id)}</option>`).join('');
  const observationChecks = accepted.map(o => `<label class="check"><input name="observationId" type="checkbox" value="${esc(o.id)}" ${selected?.observationIds?.includes(o.id) ? 'checked' : ''}><span>${time(o.start)} · ${esc(o.description.slice(0,50))}</span></label>`).join('');
  const bindingChecks = (p.bindings || []).filter(b => b.status === 'confirmed').map(b => `<label class="check"><input name="bindingId" type="checkbox" value="${esc(b.id)}" ${selected?.bindingIds?.includes(b.id) ? 'checked' : ''}><span>${esc(b.officialEventId || b.shotId || '人工映射')} · ${esc(b.reason.slice(0,35))}</span></label>`).join('');
  return panel('讲清', '沿真实源片时间轴写解说：一句主解释，最多一个主要数字和一个辅助标签。', `${modelJob}<section class="panel-section"><h3>故事结构</h3><div class="beat-list">${beats}</div><div class="button-row" style="margin-top:10px"><button class="button quiet" data-action="add-beat" type="button" ${story.beats.length >= 3 || accepted.length <= story.beats.length ? 'disabled' : ''}>＋ 增加一段</button><button class="button quiet" data-action="template-story" type="button">重建初稿</button>${reviseStoryButtons}</div></section><section class="panel-section"><h3>编辑本段</h3>${selected ? `<form data-form="story"><label class="field"><span>整片标题</span><input name="storyTitle" required maxlength="120" value="${esc(story.title)}"></label><label class="field"><span>给谁看</span><select name="audience"><option value="fan" ${story.audience === 'fan' ? 'selected' : ''}>普通观众</option><option value="pro" ${story.audience === 'pro' ? 'selected' : ''}>专业观众</option></select></label><div class="field-row"><label class="field"><span>整片开始 · 秒</span><input name="rangeStart" type="number" min="0" max="${mediaDuration()}" step="0.01" value="${story.sourceRange.start}" required></label><label class="field"><span>整片结束 · 秒</span><input name="rangeEnd" type="number" min="0" max="${mediaDuration()}" step="0.01" value="${story.sourceRange.end}" required></label></div><div class="form-divider"></div><label class="field"><span>章节标题</span><input name="beatLabel" required maxlength="80" value="${esc(selected.label)}"></label><div class="field-row triple"><label class="field"><span>出现 · 秒</span><input name="beatStart" type="number" min="0" max="${mediaDuration()}" step="0.01" value="${selected.sourceStart}" required></label><label class="field"><span>结束 · 秒</span><input name="beatEnd" type="number" min="0" max="${mediaDuration()}" step="0.01" value="${selected.sourceEnd}" required></label><label class="field"><span>锚点 · 秒</span><input name="beatAnchor" type="number" min="0" max="${mediaDuration()}" step="0.01" value="${selected.anchorTime}" required></label></div><label class="field"><span>解说主句</span><textarea name="beatText" required maxlength="240">${esc(selected.text)}</textarea><small>说清画面能证明的事。官方数字要通过下方数据记录引用，不直接手写进句子。</small></label><label class="field"><span>这句话属于</span><select name="explanationKind"><option value="visible-fact" ${selected.explanationKind === 'visible-fact' ? 'selected' : ''}>画面事实</option><option value="data-fact" ${selected.explanationKind === 'data-fact' ? 'selected' : ''}>数据事实</option><option value="interpretation" ${selected.explanationKind === 'interpretation' ? 'selected' : ''}>人工战术解释</option></select></label><label class="field"><span>主要数字（最多一项）</span><select name="metricRecordId"><option value="">不使用数字</option>${metricOptions}</select><small>仅列出已确认事件映射的记录。</small></label><label class="field"><span>辅助短标签（可留空）</span><input name="secondaryLabel" maxlength="60" value="${esc(selected.secondaryLabel || '')}"></label><div class="minor-title">支撑这段的画面观察</div>${observationChecks || '<p class="help-text">没有可用观察，请返回「看懂」。</p>'}${bindingChecks ? `<div class="minor-title">确认的事件映射</div>${bindingChecks}` : ''}<div class="button-row" style="margin-top:14px"><button class="button" type="submit">保存故事</button><button class="button danger" type="button" data-action="delete-beat" ${story.beats.length <= 1 ? 'disabled' : ''}>删除本段</button></div></form><div class="form-divider"></div><h3>画面箭头</h3><p class="help-text">只在人工确认的画面短窗内使用。先填署名，再在左侧视频画面点起点和终点。</p><label class="field"><span>标注确认人</span><input id="annotation-actor" maxlength="80" placeholder="你的姓名或制作署名" value="${esc(state.annotationActor)}"></label><div class="button-row"><button class="button secondary" data-action="start-annotation" type="button">${state.annotation ? '取消标注' : '在画面上画箭头'}</button>${selected.annotation ? '<button class="button quiet" data-action="clear-annotation" type="button">清除箭头</button>' : ''}</div>` : '<p class="empty-copy">先选择一段。</p>'}</section><button class="button full" data-action="next-step" type="button">检查并出片 →</button>`);
}
function renderDeliverPanel() {
  const p = state.project, review = validReview(p), releases = p.releases || [];
  const voiceProviders = (state.capabilities?.providers || []).filter(x => x.kind === 'voice' && x.available);
  const rendererReady = state.capabilities?.renderer?.available === true;
  const job = state.job;
  const jobMarkup = job ? `<div class="job-status ${job.status === 'failed' || job.status === 'blocked' ? 'failed' : job.status === 'succeeded' ? 'succeeded' : ''}"><h3>${esc(statusNames[job.status] || job.status)} · ${esc(stageNames[job.stage] || job.stage)}</h3><p>${esc(job.error?.message || (job.type === 'render' ? '正在生成并验证真实 MP4。' : '正在处理画面；结果仍需人工确认。'))}</p>${job.progress?.total ? `<div class="bar" aria-label="已完成 ${job.progress.completed} / ${job.progress.total}"><span style="width:${clamp(job.progress.completed/job.progress.total*100,0,100)}%"></span></div><small>${job.progress.completed} / ${job.progress.total} ${esc(job.progress.unit)}</small>` : ''}<div class="button-row">${['queued','running'].includes(job.status) ? `<button class="button quiet small" data-action="refresh-job" type="button">刷新进度</button><button class="button danger small" data-action="cancel-job" type="button">取消任务</button>` : ''}${job.status === 'succeeded' && job.type === 'render' && job.resultId ? `<button class="button small" data-action="watch-release" data-id="${esc(job.resultId)}" type="button">打开成片</button>` : ''}${['failed','blocked','cancelled'].includes(job.status) ? `<button class="button quiet small" data-action="refresh-job" type="button">查看任务记录</button>` : ''}</div></div>` : '';
  const reviewForm = `<section class="panel-section"><h3>逐项核查</h3>${review ? `<p class="inline-note good">本修订已由 ${esc(p.review.actor)} 于 ${esc(date(p.review.at))} 完成人工审核。修改后要重新核查；已有成片仍保留。</p>` : `<p class="inline-note">审核只表示你已核对本片的身份、时刻、数字、措辞与标注；自然语言判断仍由制作人负责。</p>`}<form data-form="review"><label class="field"><span>审核人</span><input name="actor" required maxlength="80" value="${esc(p.review?.actor || '')}" placeholder="你的姓名或制作署名"></label>${[['identity','人物身份'],['timing','动作时刻与顺序'],['metrics','数字口径和来源'],['wording','解说措辞'],['geometry','箭头位置与有效时窗']].map(([key,label]) => `<label class="check"><input type="checkbox" name="${key}" required ${review ? 'checked' : ''}><span>${label} 已逐项核对</span></label>`).join('')}<label class="field"><span>审核备注（可留空）</span><textarea name="note" maxlength="500">${esc(p.review?.note || '')}</textarea></label><button class="button secondary full" type="submit" ${p.story ? '' : 'disabled'}>${review ? '重新核查当前版本' : '完成人工审核'}</button></form></section>`;
  const renderForm = `<section class="panel-section"><h3>制作成片</h3><p class="empty-copy">以原速输出真实 MP4。字幕版使用静音音轨；配音版仅在声音能力实际可用时开启。</p><form data-form="render" style="margin-top:14px"><label class="field"><span>声音版本</span><select name="voiceMode"><option value="silent">字幕版 · 静音</option>${voiceProviders.map(x => `<option value="${esc(x.id)}">中文配音 · ${esc({'local-tts':'本机中文',minimax:'MiniMax',stepfun:'阶跃星辰',polly:'Amazon Polly'}[x.id]||x.id)}</option>`).join('')}</select></label><button class="button orange full" type="submit" ${review && rendererReady ? '' : 'disabled'}>生成真实 MP4</button></form>${!rendererReady ? '<p class="inline-note error">当前成片服务不可用。请检查制作环境，修复后刷新能力状态。</p>' : !review ? `<p class="help-text">先完成上方审核，才能导出当前故事。</p>` : ''}${jobMarkup}</section>`;
  const releaseList = releases.map((r,index) => `<div class="record"><div class="record-top"><strong>成片 ${releases.length-index}</strong><span class="tag good">已验证</span></div><p>${esc(r.understanding?.mode === 'manual' ? '人工辅助制作' : '人工复核的辅助理解')} · ${esc(r.voice?.mode === 'silent' ? '静音字幕' : '中文配音')}</p><small>${esc(date(r.createdAt))} · ${time(r.duration)} · 项目修订 ${r.projectRevision}</small><div class="record-actions"><button type="button" data-action="watch-release" data-id="${esc(r.id)}">观看</button><a href="${esc(r.videoUrl)}" download>下载 MP4</a><a href="${esc(r.captionsUrl)}" download>下载字幕</a></div></div>`).join('');
  return panel('出片', '审核当前故事，再生成一版可以播放、下载与复核的影片。', `${reviewForm}${renderForm}<section class="panel-section"><h3>历史成片</h3><div class="release-list">${releaseList || '<p class="empty-copy">第一版生成后，会出现在这里。后续修改不会覆盖之前发布的影片。</p>'}</div></section>`);
}
function renderWatch() {
  const r = state.release, range = videoRange(), original = cloudEnabled() ? null : originalUrl(), originalMode = state.watchOriginal && original;
  const chapters = chapterBeats();
  const src = originalMode ? original : r?.videoUrl;
  const provenance = r?.understanding?.mode === 'manual' ? '人工辅助制作' : r?.understanding?.humanReviewed ? '人工复核的辅助理解' : '理解方式待核对';
  const sourceKind = state.manifest?.source?.kind || state.manifest?.source?.source?.kind;
  const sourceLabel = sourceKind === 'synthetic' ? '合成演练素材' : sourceKind === 'official-provided' ? '赛事方提供素材 · 待核验' : sourceKind === 'user-provided' ? '用户提供素材' : '来源未在发布记录中说明';
  const title = state.manifest?.story?.title || state.manifest?.title || '一个回合的关键选择';
  const caption = !originalMode && r?.captionsUrl ? `<track kind="subtitles" srclang="zh" label="中文字幕" src="${esc(r.captionsUrl)}" default>` : '';
  const chapterButtons = chapters.slice(0,3).map((b,index) => `<button type="button" class="chapter ${state.activeChapter === index ? 'active' : ''}" data-action="watch-chapter" data-index="${index}"><span class="index">CHAPTER 0${index+1} · ${time(b.sourceStart)}</span><strong>${esc(beatLabel(b.label))}</strong><small>${esc(compiledBeatText(b))}</small></button>`).join('');
  const evidence = state.evidenceOpen ? renderEvidence() : '';
  return `<div class="watch"><div class="watch-head"><div><span class="eyebrow">COURTLENS / FINAL CUT</span><h1>${esc(title)}</h1><p>${esc(provenance)} · ${esc(sourceLabel)} · ${time(r?.duration)}</p></div><span class="status-pill good">已发布成片</span></div><div class="watch-stage"><div class="stage"><video id="broadcast-video" controls playsinline preload="metadata" src="${esc(src)}" aria-label="${originalMode ? '原片' : '解说成片'}">${caption}你的浏览器不支持视频播放。</video>${originalMode ? '<div class="stage-badge">ORIGINAL / 原片</div>' : ''}</div><div class="watch-controls"><div class="toggle" role="group" aria-label="视频版本"><button type="button" class="${!originalMode ? 'active' : ''}" data-action="watch-mode" data-mode="enhanced">解说版</button><button type="button" class="${originalMode ? 'active' : ''}" data-action="watch-mode" data-mode="original" ${original ? '' : 'disabled'}>原片</button></div><p>${original ? `切换版本会停在同一源片时刻 ${time(state.currentTime)}。` : cloudEnabled() ? '原片仅制作端可看。' : '该成片未附可访问的原片。'}</p></div>${chapterButtons ? `<nav class="chapter-section" aria-label="故事章节">${chapterButtons}</nav>` : ''}<div class="watch-end"><div><span class="eyebrow">SOURCE BEFORE STORY</span><p class="source-note">画面与解释经过人工复核。数据若有引用，以来源记录和有效时刻为准。</p></div><div class="button-row"><button class="button secondary" data-action="open-evidence" type="button">这一刻的依据</button><a class="button quiet" href="${esc(r?.videoUrl)}" download>下载 MP4</a></div></div></div></div>${evidence}`;
}
function renderEvidence() {
  const beats = chapterBeats(), beat = beats[state.activeChapter] || beats[0], r = state.release;
  const observations = (state.manifest?.evidence?.observations || []).filter(o => beat?.observationIds?.includes(o.id));
  const bindings = (state.manifest?.evidence?.bindings || []).filter(b => beat?.bindingIds?.includes(b.id));
  const metrics = state.manifest?.evidence?.metrics;
  const metric = metrics?.records?.find(m => m.id === beat?.metricRecordId);
  return `<div class="evidence-backdrop" data-action="close-evidence"></div><aside class="evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-title"><div class="drawer-head"><div><span class="eyebrow">EVIDENCE / ${time(beat?.sourceStart)}</span><h2 id="evidence-title">这一刻的依据</h2></div><button class="button quiet small" data-action="close-evidence" type="button" aria-label="关闭依据抽屉">关闭</button></div><p>${esc(compiledBeatText(beat) || '这段成片的依据保存在发布记录中。')}</p><h3>源片画面</h3>${observations.length ? observations.map(o => `<div class="record"><strong>${esc(obsNames[o.type] || '观察')} · ${time(o.start)}—${time(o.end)}</strong><p>${esc(o.description)}</p><small>${o.review?.status === 'accepted' ? '人工已接受' : '状态未确认'} · ${esc(o.source?.kind === 'manual' ? '人工观察' : '辅助候选')}</small></div>`).join('') : '<p>这段没有附加可展示的观察详情。</p>'}<h3>数据与映射</h3>${metric ? `<dl><dt>指标</dt><dd>${esc(metrics.dictionary?.metrics?.[metric.metricId]?.label || metric.metricId)}</dd><dt>来源记录</dt><dd>${esc(metric.id)}</dd><dt>统计范围</dt><dd>${esc(metric.scope?.granularity || '未说明')}</dd></dl>` : '<p>这段没有使用主要数字。</p>'}${bindings.length ? bindings.map(b => `<div class="record"><strong>${esc(b.officialEventId || b.shotId || '人工时刻映射')}</strong><p>${esc(b.reason)}</p><small>${b.status === 'confirmed' ? '人工确认' : '尚未确认'}</small></div>`).join('') : ''}<h3>制作记录</h3><dl><dt>理解方式</dt><dd>${esc(r?.understanding?.mode === 'manual' ? '人工辅助制作' : '人工复核的辅助理解')}</dd><dt>成片版本</dt><dd>${esc(r?.id || '')}</dd><dt>发布时间</dt><dd>${esc(date(r?.createdAt))}</dd></dl><a class="button quiet full" href="${esc(r?.manifestUrl)}" target="_blank" rel="noopener">查看完整发布记录</a></aside>`;
}

function updateTimeUI() {
  const display = $('#time-display'), slider = $('#source-seek');
  if (display) display.textContent = `${time(state.currentTime)} / ${time(mediaDuration())}`;
  if (slider) slider.value = clamp(state.currentTime, 0, mediaDuration());
  if(state.view==='studio'&&state.step===2)updateDraftOverlay();
  if (state.view === 'watch') {
    const beats = chapterBeats();
    const active = beats.findLastIndex(b => state.currentTime >= b.sourceStart && state.currentTime < b.sourceEnd);
    if (active >= 0 && active !== state.activeChapter) {
      state.activeChapter = active;
      document.querySelectorAll('.chapter').forEach((node,index) => node.classList.toggle('active',index===active));
    }
  }
}
function seek(t) {
  state.currentTime = clamp(num(t), 0, state.view === 'watch' ? Math.max(num(videoRange().end),num(state.project?.media?.duration),num(state.release?.duration)) : mediaDuration());
  const video = $('#broadcast-video');
  if (video) video.currentTime = playbackTimeForSource(state.currentTime);
  updateTimeUI();
}
async function captureFrame() {
  const p = state.project;
  const data = await requestFrames(p,[state.currentTime]);
  addFrames(data.frames||[]);
  notify(`已取证 ${time((data.frames || [])[0]?.actualTime ?? state.currentTime)} 的实际画面。`, 'success');
}
function addFrames(frames) {
  for (const frame of frames) {const at=state.frames.findIndex(f=>f.id===frame.id);if(at>=0)state.frames[at]=frame;else state.frames.push(frame);}
  state.frames.sort((a,b) => a.actualTime-b.actualTime);
  render();
}
async function requestFrames(project,times) {
  const initial=await api.frames(project,times);
  if(Array.isArray(initial.frames))return initial;
  if(!initial?.id)throw new Error('取证任务没有返回帧或任务编号。');
  state.frameJobId=initial.id;state.frameRequestTimes=times;state.frameRefreshAttempts=0;
  return waitForFrameJob(initial.id);
}
async function waitForFrameJob(jobId) {
  const deadline=Date.now()+180000;
  while(Date.now()<deadline) {
    await new Promise(resolve=>setTimeout(resolve,1200));
    const job=await api.job(jobId);
    if(job.status==='succeeded') {
      if(Array.isArray(job.result?.frames))return job.result;
      throw new Error('取证已完成，但没有可读取的画面。');
    }
    if(['failed','blocked','cancelled'].includes(job.status))throw new BroadcastApiError(job.error||{code:'frames_failed',message:'画面取证没有完成，请重试。'},422);
  }
  throw new BroadcastApiError({code:'frames_timeout',message:'取证仍在运行。',retryable:true});
}
async function pollJob() {
  const current = state.job;
  if (!current) return;
  clearTimeout(state.jobTimer);
  try {
    const result = await api.job(current.id);
    if (state.job?.id !== current.id) return;
    state.job = result;
    if (['queued','running'].includes(result.status)) {
      if (Date.now() > state.jobDeadline) {
        notify('任务仍在运行。自动刷新已暂停；点击“刷新进度”继续查看。', 'error');
      } else state.jobTimer = setTimeout(pollJob, 2000);
    } else if (result.status === 'succeeded' || result.status === 'needs_review') {
      if (state.project) state.project = await api.project(state.project.id);
      const storyMoved=result.type==='model-story'&&finite(result.result?.projectRevision)&&state.project?.revision!==result.result.projectRevision;
      if (state.pendingUploadSource && state.project?.media) {
        state.project=await api.edit(state.project,{source:state.pendingUploadSource});
        state.pendingUploadSource=null;
        state.step=1;
        notify('源片已保存，可以逐帧观察。','success');
      } else if(storyMoved) notify('辅助初稿已完成，但项目随后发生修改。请核对当前版本再继续。','error');
      else notify(result.type === 'render' ? '成片已生成并保存。' : ['media','upload'].includes(result.type) ? '源片已上传并检查。' : result.type==='model-story' ? '辅助初稿已生成，请逐句核对后再审核。' : '辅助结果已生成。请逐条核对画面观察。', 'success');
    } else if (result.error) notify(result.error.message, 'error');
    render();
  } catch (error) { handleError(error); render(); }
}
function startJob(job) {
  state.job = job;
  state.jobDeadline = Date.now() + 20 * 60 * 1000;
  clearTimeout(state.jobTimer);
  state.jobTimer = setTimeout(pollJob, 1800);
  render();
}
function checked(form, name) { return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(input => input.value); }
function requiredProject() { if (!state.project) throw new Error('请先选择一个项目。'); return state.project; }
function cleanText(form, name) { return String(new FormData(form).get(name) || '').trim(); }
function storyWithBeat(project, beat) {
  return {...project.story, beats: project.story.beats.map(b => b.id === beat.id ? beat : b)};
}
async function saveObservation(form) {
  const p = requiredProject(), fd = new FormData(form), selected = (p.observations || []).find(o => o.id === state.selectedObservationId);
  const start = num(fd.get('start'),NaN), end = num(fd.get('end'),NaN), anchor = num(fd.get('anchorTime'),NaN);
  if (!(start >= 0 && end > start && end <= mediaDuration() && anchor >= start && anchor <= end)) throw new Error('观察的开始、结束和锚点必须按顺序落在源片内。');
  const frameIds = fd.getAll('frameId').map(String);
  const playerId = String(fd.get('playerId') || '');
  const observation = {
    id: selected?.id || id(), type: String(fd.get('type')), start, end, anchorTime: anchor, segmentId: selected?.segmentId || 'segment-1',
    description: String(fd.get('description') || '').trim(), playerIds: playerId ? [playerId] : [], unknownActors: selected?.unknownActors || [], frameIds,
    source: selected?.source || {kind:'manual',runId:null,recordId:null}, confidence: selected?.confidence ?? null,
    review: {status:'unreviewed',actor:null,reason:null,at:null}, geometry: selected?.geometry || null,
  };
  const observations = selected ? p.observations.map(o => o.id === selected.id ? observation : o) : [...(p.observations || []),observation];
  const result = await api.edit(p, {observations});
  state.selectedObservationId = observation.id;
  state.chosenFrameIds.clear();
  saveProject(result);
  notify('观察已保存。请回看画面并确认属实。', 'success');
}
async function reviewObservation(observationId, status) {
  const p = requiredProject(), observation = p.observations.find(o => o.id === observationId);
  if (!observation) return;
  const actor = cleanText($('[data-form="observation"]'),'actor');
  if (!actor) { notify('请先填写这条观察的核对者。', 'error'); $('[name="actor"]')?.focus(); return; }
  const observations = p.observations.map(o => o.id === observationId ? {...o,review:{status,actor,reason:status === 'rejected' ? '人工排除' : '逐帧人工核对',at:new Date().toISOString()}} : o);
  saveProject(await api.edit(p,{observations}));
  notify(status === 'accepted' ? '这条观察已人工确认。' : '这条候选已排除。','success');
}
async function saveBinding(form) {
  const p = requiredProject(), fd = new FormData(form), observation = p.observations.find(o => o.id === fd.get('observationId'));
  if (!observation || observation.review?.status !== 'accepted') throw new Error('先选择一条已经人工确认的观察。');
  const actor = cleanText($('[data-form="observation"]'),'actor');
  if (!actor) throw new Error('请先在观察表单填写核对者，再确认事件映射。');
  const binding = {id:id(),observationId:observation.id,officialEventId:String(fd.get('officialEventId')||'').trim()||null,shotId:String(fd.get('shotId')||'').trim()||null,
    gameId:p.context?.gameId || null,playerId:observation.playerIds?.[0]||null,metricRecordIds:fd.getAll('metricRecordId').map(String),
    timeMapping:{source:'video',videoTime:observation.anchorTime ?? observation.start,period:null,clock:null,mappingEvidenceIds:observation.frameIds || []},
    status:'confirmed',reason:String(fd.get('reason')||'').trim(),confirmedBy:actor,confirmedAt:new Date().toISOString()};
  saveProject(await api.edit(p,{bindings:[...(p.bindings||[]),binding]}));
  notify('事件时刻与数据记录已保存为人工确认映射。','success');
}
async function manualStory() {
  const p = requiredProject();
  const accepted = (p.observations||[]).filter(o => o.review?.status==='accepted').sort((a,b)=>a.start-b.start);
  if (!accepted.length) throw new Error('请先人工确认至少一条观察。');
  const observation = accepted[0];
  const beatStart = observation.end;
  const beatEnd = Math.min(p.media.duration, beatStart + Math.max(.4, Math.min(2, observation.end-observation.start)));
  if (!(beatEnd > beatStart)) throw new Error('这条观察贴近视频结尾。请把观察结束时刻调到解说出现前，或补充更早的观察。');
  const story = {schema:'courtlens-broadcast-story/1',title:p.title,audience:'fan',sourceRange:{start:0,end:p.media.duration},beats:[{
    id:id(),label:obsNames[observation.type]||'关键选择',sourceStart:beatStart,sourceEnd:beatEnd,anchorTime:beatStart,
    observationIds:[observation.id],bindingIds:[],text:observation.description,explanationKind:'visible-fact',metricRecordId:null,secondaryLabel:null,annotation:null,
  }]};
  saveProject(await api.edit(p,{story}));
  notify('已根据人工观察创建一段初稿。','success');
}
async function saveStory(form) {
  const p = requiredProject(), fd = new FormData(form), beat = p.story?.beats.find(b => b.id === state.selectedBeatId) || p.story?.beats[0];
  if (!beat) throw new Error('请选择要编辑的故事段落。');
  const sourceRange = {start:num(fd.get('rangeStart'),NaN),end:num(fd.get('rangeEnd'),NaN)};
  const sourceStart = num(fd.get('beatStart'),NaN), sourceEnd = num(fd.get('beatEnd'),NaN), anchorTime = num(fd.get('beatAnchor'),NaN);
  if (!(sourceRange.start >= 0 && sourceRange.end > sourceRange.start && sourceRange.end <= mediaDuration() && sourceStart >= sourceRange.start && sourceEnd <= sourceRange.end && sourceEnd > sourceStart && anchorTime >= sourceStart && anchorTime <= sourceEnd)) throw new Error('故事入出点、章节和锚点必须按顺序落在源片内。');
  const updated = {...beat,label:String(fd.get('beatLabel')).trim(),sourceStart,sourceEnd,anchorTime,observationIds:fd.getAll('observationId').map(String),bindingIds:fd.getAll('bindingId').map(String),
    text:String(fd.get('beatText')).trim(),explanationKind:String(fd.get('explanationKind')),metricRecordId:String(fd.get('metricRecordId')||'')||null,secondaryLabel:String(fd.get('secondaryLabel')||'').trim()||null};
  const story = {...p.story,title:String(fd.get('storyTitle')).trim(),audience:String(fd.get('audience')),sourceRange,beats:p.story.beats.map(b=>b.id===beat.id?updated:b).sort((a,b)=>a.sourceStart-b.sourceStart)};
  if (story.beats.some((b,i) => i>0 && b.sourceStart < story.beats[i-1].sourceEnd)) throw new Error('故事段落不能在源片时间线上重叠。');
  saveProject(await api.edit(p,{story}));
  notify('故事已保存，当前内容需要重新审核。','success');
}
async function addBeat() {
  const p = requiredProject(), story = p.story;
  if (story.beats.length >= 3) return;
  const used = new Set(story.beats.flatMap(b=>b.observationIds));
  const source = (p.observations||[]).filter(o=>o.review?.status==='accepted'&&!used.has(o.id)).sort((a,b)=>a.start-b.start).find(o=>{
    const start=o.end,end=Math.min(story.sourceRange.end,start+Math.max(.4,Math.min(2,o.end-o.start)));
    return end>start && story.beats.every(b=>end<=b.sourceStart||start>=b.sourceEnd);
  });
  if (!source) throw new Error('没有可新增的、与现有章节不重叠的已确认观察。');
  const beatStart=source.end,beatEnd=Math.min(story.sourceRange.end,beatStart+Math.max(.4,Math.min(2,source.end-source.start)));
  const beat={id:id(),label:obsNames[source.type]||'下一步',sourceStart:beatStart,sourceEnd:beatEnd,anchorTime:beatStart,observationIds:[source.id],bindingIds:[],text:source.description,explanationKind:'visible-fact',metricRecordId:null,secondaryLabel:null,annotation:null};
  const newStory={...story,beats:[...story.beats,beat].sort((a,b)=>a.sourceStart-b.sourceStart)};
  saveProject(await api.edit(p,{story:newStory}));state.selectedBeatId=beat.id;render();
}
async function saveAnnotation(points) {
  let p = requiredProject();
  const beat = p.story.beats.find(b=>b.id===state.selectedBeatId) || p.story.beats[0];
  const sourceObservationId = beat.observationIds?.find(oid=>p.observations.some(o=>o.id===oid && o.review?.status==='accepted'));
  if (!sourceObservationId) throw new Error('本段需要至少一条已人工确认的画面观察，才能保存箭头。');
  const actor=state.annotationActor.trim();
  if (!actor) throw new Error('请先填写标注确认人。');
  const source=p.observations.find(o=>o.id===sourceObservationId);
  const frame=state.annotationFrame;
  if(!frame||frame.mediaSha256!==p.media.sha256)throw new Error('请先在目标时刻取证一帧，再绘制箭头。');
  if(frame.actualTime>source.end+3)throw new Error('这条观察的画面已过去太久。请把章节移近动作，或新增观察后再标注。');
  const validTo=Math.min(beat.sourceEnd,frame.actualTime+1,source.end+3);
  if(!(validTo>frame.actualTime))throw new Error('箭头起点距离章节结束太近，请延长该段或提前标注。');
  const geometry={space:'screen-normalized',points,validFrom:frame.actualTime,validTo,segmentId:source.segmentId};
  const observations=p.observations.map(o=>o.id===sourceObservationId?{...o,frameIds:[...new Set([...(o.frameIds||[]),frame.id])],geometry,review:{status:'accepted',actor,reason:`在源片 ${time(frame.actualTime)} 真实帧人工确认箭头；仅显示至 ${time(validTo)}`,at:new Date().toISOString()}}:o);
  p=await api.edit(p,{observations,story:p.story});
  state.project=p;
  const annotation={id:id(),points,sourceObservationId,confirmedBy:actor,confirmedAt:new Date().toISOString()};
  const saved=await api.edit(p,{story:storyWithBeat(p,{...beat,annotation})});
  state.annotation=false;state.annotationPoints=[];state.annotationFrame=null;
  saveProject(saved);
  notify('人工箭头已保存；审核需要重新完成。','success');
}

async function onForm(event) {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind=form.dataset.form;
  await run(async()=>{
    if (kind==='create-project') {
      const project=await api.createProject(cleanText(form,'title'),cleanText(form,'mode'));
      state.createProject=false;setProject(project,0);notify('项目已创建。现在上传源片。','success');
    } else if (kind==='upload') {
      const p=requiredProject(),file=form.querySelector('[name="video"]').files?.[0];
      if(!file) throw new Error('请选择视频文件。');
      if(file.size>256*1024*1024) throw new Error('视频超过 256 MiB，请先选更短的回合片段。');
      const kind=cleanText(form,'sourceKind'),label=cleanText(form,'sourceLabel'),rightsNote=cleanText(form,'rightsNote');
      if(!label||!rightsNote) throw new Error('请填写来源与使用范围。');
      const source={label,kind,rightsNote};
      notify('正在上传并检查真实视频，请稍候。');
      if (cloudEnabled()) {
        if (state.capabilities?.upload?.mode!=='signed-async') throw new Error('云端上传尚未配置。请稍后重试，或使用本地制作台。');
        const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));
        const sha256=Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
        const prepared=await api.prepareUpload(p,file,sha256);
        await api.putSigned(prepared.uploadUrl,prepared.requiredHeaders,file);
        state.pendingUploadSource=source;
        startJob(await api.commitUpload(p,file,sha256,prepared.uploadKey));
        notify('云端上传已完成，正在验证视频并建立项目。');
      } else {
        const uploaded=await api.upload(p.id,p.revision,file);
        state.project=uploaded;
        saveProject(await api.edit(uploaded,{source}));
        state.step=1;state.currentTime=0;render();notify('源片已保存，可以逐帧观察。','success');
      }
    } else if (kind==='project-settings') {
      const p=requiredProject();saveProject(await api.edit(p,{title:cleanText(form,'title'),mode:cleanText(form,'mode')}));notify('项目设置已保存。','success');
    } else if (kind==='source-settings') {
      saveProject(await api.edit(requiredProject(),{source:{kind:cleanText(form,'sourceKind'),label:cleanText(form,'sourceLabel'),rightsNote:cleanText(form,'rightsNote')}}));
      notify('素材来源说明已保存。','success');
    } else if (kind==='context') {
      const roster=cleanText(form,'roster').split(/\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
        const [playerId,name,teamId,jersey]=line.split(',').map(value=>value.trim());
        if(!playerId||!name||!teamId)throw new Error('当场名单每行需要球员 ID、姓名和球队 ID。');
        return {id:playerId,name,teamId,jersey:jersey||null,source:'人工录入',validOn:cleanText(form,'gameDate')||null};
      });
      const context={gameId:cleanText(form,'gameId')||null,gameDate:cleanText(form,'gameDate')||null,seasonId:cleanText(form,'seasonId')||null,seasonType:cleanText(form,'seasonType')||null,offenseTeamId:cleanText(form,'offenseTeamId')||null,roster};
      saveProject(await api.edit(requiredProject(),{context}));notify('比赛信息与当场名单已保存。','success');
    } else if (kind==='metrics-import') {
      const file=form.querySelector('[name="metrics"]').files?.[0];if(!file) throw new Error('请选择指标 JSON。');
      const bundle=JSON.parse(await file.text());saveProject(await api.metrics(requiredProject(),bundle));notify('指标已导入。请逐项确认事件映射。','success');
    } else if (kind==='analyze') {
      const p=requiredProject(),option=form.querySelector('[name="analysisChoice"]')?.selectedOptions[0];
      const providerId=option?.dataset.provider,strategy=option?.dataset.strategy;
      const choice=visualChoices(state.capabilities).find(item=>item.provider.id===providerId&&item.strategy===strategy);
      if(!choice)throw new Error('当前画面理解方式不可用，请刷新能力状态。');
      const start=Number(form.elements.scopeStart.value),end=Number(form.elements.scopeEnd.value);
      const scope=validateAnalysisScope(start,end,p.media.duration,choice.provider,strategy);
      state.analysisScope=scope;
      const job=await api.analyze(p,providerId,scope,strategy);
      startJob(job);notify(`已提交 ${time(start)}—${time(end)} 片段的画面理解；候选仍需人工确认。`);
    } else if (kind==='cv') {
      const p=requiredProject(),providerId=cleanText(form,'providerId');startJob(await api.cv(p,providerId,{start:0,end:p.media.duration}));notify('视觉辅助任务已提交。');
    } else if (kind==='cv-import') {
      const file=form.querySelector('[name="cvFile"]').files?.[0];if(!file) throw new Error('请选择结果 JSON。');
      const result=JSON.parse(await file.text());saveProject(await api.importCv(requiredProject(),result));notify('视觉结果已导入为待核对候选。','success');
    } else if (kind==='observation') await saveObservation(form);
    else if (kind==='binding') await saveBinding(form);
    else if (kind==='story') await saveStory(form);
    else if (kind==='review') {
      const p=requiredProject(),fd=new FormData(form),checks=Object.fromEntries(['identity','timing','metrics','wording','geometry'].map(name=>[name,fd.get(name)==='on']));
      if(Object.values(checks).some(value=>!value)) throw new Error('请逐项完成五项人工核查。');
      saveProject(await api.review(p,cleanText(form,'actor'),checks,cleanText(form,'note')));notify('当前故事版本已人工审核。','success');
    } else if (kind==='render') {
      if(state.capabilities?.renderer?.available!==true)throw new Error('成片服务暂不可用，请检查环境后重试。');
      const p=requiredProject(),voiceMode=cleanText(form,'voiceMode');
      startJob(await api.render(p,voiceMode,null));notify('成片任务已提交；正在生成真实 MP4。');
    }
  });
}
async function onAction(event) {
  const target=event.target.closest('[data-action]');
  if(!target) return;
  const action=target.dataset.action;
  if(target.tagName==='BUTTON') event.preventDefault();
  if(action==='dismiss-notice') {clearNotice();return;}
  if(action==='retry-current'||action==='reconnect') {clearNotice();await bootstrap();return;}
  if(action==='retry-frames'&&state.frameJobId){clearNotice();await run(async()=>{const result=await waitForFrameJob(state.frameJobId);addFrames(result.frames||[]);notify('画面取证已完成。','success');});return;}
  if(action==='close-evidence') {state.evidenceOpen=false;render();return;}
  if(action==='open-evidence') {state.evidenceOpen=true;render();$('#evidence-title')?.focus();return;}
  if(action==='step') {state.step=num(target.dataset.step);state.annotation=false;render();return;}
  if(action==='next-step') {state.step=Math.min(3,state.step+1);state.annotation=false;render();return;}
  if(action==='new-project') {state.createProject=true;render();$('[name="title"]')?.focus();return;}
  if(action==='projects') {
    if(state.view==='watch') location.href='/broadcast/';
    else {state.view='library';state.createProject=false;const listing=await run(()=>api.projects(),{rerender:false});if(listing)state.projects=listing.projects||[];render();}
    return;
  }
  if(action==='open-project') {await run(async()=>setProject(await api.project(target.dataset.id)));return;}
  if(action==='reload-project') {clearNotice();await run(refreshProject);return;}
  if(action==='seek-observation') {const o=state.project?.observations?.find(x=>x.id===target.dataset.id);if(o)seek(o.anchorTime??o.start);return;}
  if(action==='seek-beat') {const b=state.project?.story?.beats?.find(x=>x.id===target.dataset.id);if(b)seek(b.anchorTime);return;}
  if(action==='seek-frame') {seek(num(target.dataset.time));return;}
  if(action==='capture-frame') {await run(captureFrame);return;}
  if(action==='frame-back'||action==='frame-forward') {
    const m=state.project?.media,fps=num(m?.fpsNumerator)/Math.max(1,num(m?.fpsDenominator,1));
    seek(state.currentTime+(action==='frame-back'?-1:1)/Math.max(.1,fps));return;
  }
  if(action==='select-observation') {state.selectedObservationId=target.dataset.id;state.chosenFrameIds.clear();render();return;}
  if(action==='new-observation') {state.selectedObservationId=null;state.chosenFrameIds.clear();render();return;}
  if(action==='accept-observation'||action==='reject-observation') {await run(()=>reviewObservation(target.dataset.id,action==='accept-observation'?'accepted':'rejected'));return;}
  if(action==='template-story') {await run(async()=>{saveProject(await api.story(requiredProject(),'fan','template',null));notify('已生成初稿，请逐句审看。','success');});return;}
  if(action==='model-story') {await run(async()=>{const result=await api.story(requiredProject(),'fan','model',target.dataset.provider);if(result.type==='model-story') {startJob(result);notify('辅助拟稿已提交，完成后仍需逐句人工核对。');}else{saveProject(result);notify('辅助初稿已生成，请逐句核对后再审核。','success');}});return;}
  if(action==='manual-story') {await run(manualStory);return;}
  if(action==='select-beat') {state.selectedBeatId=target.dataset.id;const b=state.project.story.beats.find(x=>x.id===state.selectedBeatId);if(b)seek(b.anchorTime);render();return;}
  if(action==='add-beat') {await run(addBeat);return;}
  if(action==='delete-beat') {await run(async()=>{const p=requiredProject(),beats=p.story.beats.filter(b=>b.id!==state.selectedBeatId);if(!beats.length)throw new Error('至少保留一段故事。');saveProject(await api.edit(p,{story:{...p.story,beats}}));notify('本段已从故事中移除。','success');});return;}
  if(action==='start-annotation') {
    state.annotationActor=$('#annotation-actor')?.value?.trim()||state.annotationActor;
    if(!state.annotationActor) {notify('先填写标注确认人，再在视频上画箭头。','error');$('#annotation-actor')?.focus();return;}
    if(state.annotation){state.annotation=false;state.annotationFrame=null;state.annotationPoints=[];render();return;}
    await run(async()=>{
      const p=requiredProject(),beat=p.story?.beats.find(b=>b.id===state.selectedBeatId)||p.story?.beats[0];
      const source=p.observations.find(o=>beat.observationIds.includes(o.id)&&o.review?.status==='accepted');
      if(!source)throw new Error('本段需要一条已确认的画面观察。');
      if(beat.sourceStart>source.end+3)throw new Error('箭头必须紧接已确认动作出现；请调整章节时刻。');
      const result=await requestFrames(p,[beat.sourceStart]);
      const frame=result.frames?.[0];
      if(!frame)throw new Error('无法取证标注时刻的真实画面。');
      if(frame.actualTime<beat.sourceStart-.2||frame.actualTime>beat.sourceStart+.04)throw new Error('实际取证帧距章节起点太远，请调整章节到可定位的帧。');
      state.annotationFrame=frame;
      if(!state.frames.some(f=>f.id===frame.id))state.frames.push(frame);
      state.currentTime=frame.actualTime;
      $('#broadcast-video')?.pause();
      state.annotation=true;state.annotationPoints=[];
      notify(`已固定源片 ${time(frame.actualTime)} 的真实画面。箭头最多显示 1 秒。`);
    });return;
  }
  if(action==='annotation-point') {
    if(!state.annotation)return;
    const rect=target.getBoundingClientRect();
    const video=$('#broadcast-video');
    const videoAspect=(video?.videoWidth||16)/(video?.videoHeight||9),containerAspect=rect.width/rect.height;
    const drawnWidth=videoAspect>containerAspect?rect.width:rect.height*videoAspect;
    const drawnHeight=videoAspect>containerAspect?rect.width/videoAspect:rect.height;
    const left=rect.left+(rect.width-drawnWidth)/2,top=rect.top+(rect.height-drawnHeight)/2;
    const x=(event.clientX-left)/drawnWidth,y=(event.clientY-top)/drawnHeight;
    if(x<0||x>1||y<0||y>1){notify('请在视频实际画面内选择箭头位置。','error');return;}
    const point={x:clamp(x,0,1),y:clamp(y,0,1)};
    state.annotationPoints.push(point);
    if(state.annotationPoints.length===2) await run(()=>saveAnnotation([...state.annotationPoints]),{rerender:false}); else render();
    return;
  }
  if(action==='clear-annotation') {await run(async()=>{const p=requiredProject(),beat=p.story.beats.find(b=>b.id===state.selectedBeatId);saveProject(await api.edit(p,{story:storyWithBeat(p,{...beat,annotation:null})}));notify('箭头已清除。','success');});return;}
  if(action==='refresh-job') {await pollJob();return;}
  if(action==='cancel-job') {await run(async()=>{state.job=await api.cancel(state.job.id);clearTimeout(state.jobTimer);notify('任务已取消，历史成片仍可观看。','success');});return;}
  if(action==='watch-release') {location.href=`/broadcast/?release=${encodeURIComponent(target.dataset.id)}`;return;}
  if(action==='watch-mode') {
    if(target.dataset.mode==='original'&&!originalUrl())return;
    state.watchOriginal=target.dataset.mode==='original';render();return;
  }
  if(action==='watch-chapter') {
    state.activeChapter=num(target.dataset.index);const beat=chapterBeats()[state.activeChapter];if(beat)seek(beat.sourceStart);render();return;
  }
  if(action==='probe-provider') {
    await run(async()=>{
      const p=requiredProject(),option=$('[data-form="analyze"] [name="analysisChoice"]')?.selectedOptions[0];
      const providerId=option?.dataset.provider,strategy=option?.dataset.strategy;
      if(!visualChoices(state.capabilities).some(choice=>choice.provider.id===providerId&&choice.strategy===strategy))throw new Error('目前没有可用的画面理解提供者。');
      const window=analysisWindow();
      const frame=strategy==='frames-first' ? state.frames.find(item=>item.actualTime>=window.start&&item.actualTime<=window.end) : null;
      if(strategy==='frames-first'&&!frame)throw new Error('请先从视频取一帧，再实测关键帧画面理解。');
      startJob(await api.probe(providerId,p,frame?.id||null,frame?null:{start:window.start,end:Math.min(window.start+4,window.end)}));
    });return;
  }
  if(action==='sign-in') {await signIn();return;}
}
document.addEventListener('submit',onForm);
document.addEventListener('click',onAction);
document.addEventListener('input',event=>{
  if(event.target.matches('[data-seek]'))seek(num(event.target.value));
  if(event.target.id==='annotation-actor')state.annotationActor=event.target.value;
  if(event.target.closest('[data-form="analyze"]')){
    const form=event.target.form,start=form?.elements.scopeStart?.value,end=form?.elements.scopeEnd?.value;
    if(start!==''&&end!==''&&Number.isFinite(Number(start))&&Number.isFinite(Number(end)))state.analysisScope={start:Number(start),end:Number(end)};
    updateAnalysisHint();
  }
  if(event.target.closest('[data-form="story"]'))updateDraftOverlay();
});
document.addEventListener('change',event=>{if(event.target.matches('[data-form="analyze"] [name="analysisChoice"]'))updateAnalysisHint();});
document.addEventListener('timeupdate',event=>{
  if(event.target.id==='broadcast-video') {state.currentTime=sourceTimeOfVideo(event.target);updateTimeUI();}
},true);
document.addEventListener('error',event=>{
  if(!cloudEnabled()||!state.frameJobId||state.frameRefreshAttempts>=2||!event.target.matches?.('.frame-thumb img,.annotation-reference'))return;
  state.frameRefreshAttempts++;
  api.job(state.frameJobId).then(job=>{
    if(job.status!=='succeeded'||!Array.isArray(job.result?.frames))return;
    for(const frame of job.result.frames){const at=state.frames.findIndex(item=>item.id===frame.id);if(at>=0)state.frames[at]=frame;if(state.annotationFrame?.id===frame.id)state.annotationFrame=frame;}
    render();
  }).catch(error=>notify(`取证帧暂时无法刷新：${error.message}`,'error','retry-frames'));
},true);
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&state.evidenceOpen){state.evidenceOpen=false;render();}
  if(['ArrowLeft','ArrowRight'].includes(event.key)&&document.activeElement?.id==='broadcast-video'){
    event.preventDefault();seek(state.currentTime+(event.key==='ArrowLeft'?-1:1)/Math.max(1,num(state.project?.media?.fpsNumerator)/Math.max(1,num(state.project?.media?.fpsDenominator,1))));
  }
});
bootstrap();
