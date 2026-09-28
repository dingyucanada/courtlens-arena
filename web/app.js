'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const video = $('game-video');
  const svgNS = 'http://www.w3.org/2000/svg';
  const state = {
    dataset: null, analysis: null, audience: 'fan', possessionId: null,
    overlay: true, objectURL: null, importedVideo: false, requestVersion: 0,
    analysisBusy: false, questionBusy: false, raf: null, lastOverlayKey: '',
    previousVideoURL: null, apiError: false, videoReady: false, marker: null,
    activeCue: '', lastAnnouncedSecond: -1, askVersion: 0,
    mediaHash: null, mediaError: '', mediaVersion: 0, synchronized: false
  };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const svgEl = (tag, attrs = {}, text) => {
    const node = document.createElementNS(svgNS, tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  function time(value, milliseconds = false) {
    const v = Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
    const hours = Math.floor(v / 3600), minutes = Math.floor(v / 60) % 60;
    const seconds = Math.floor(v) % 60;
    return (hours ? String(hours).padStart(2, '0') + ':' : '') +
      String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0') +
      (milliseconds ? '.' + String(Math.floor((v % 1) * 1000)).padStart(3, '0') : '');
  }
  function vttTime(value) {
    const v = Math.max(0, Math.round(Number(value) * 1000));
    return `${String(Math.floor(v / 3600000)).padStart(2, '0')}:${String(Math.floor(v / 60000) % 60).padStart(2, '0')}:${String(Math.floor(v / 1000) % 60).padStart(2, '0')}.${String(v % 1000).padStart(3, '0')}`;
  }
  const rawPossession = () => state.dataset?.possessions.find(p => p.id === state.possessionId);
  const analyzedPossession = () => state.analysis?.possessions.find(p => p.id === state.possessionId);
  const duration = () => Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (state.dataset?.video.duration || 36);
  const datasetDuration = () => state.dataset?.video.duration || duration();
  function notify(message, kind = 'warning', retry = false) {
    $('status-text').textContent = message;
    $('status-banner').classList.toggle('success', kind === 'success');
    $('status-banner').hidden = false;
    $('retry-button').hidden = !retry;
  }
  function setBusy(value) {
    state.analysisBusy = value;
    ['import-data', 'export-json', 'export-vtt'].forEach(id => { $(id).disabled = value || !state.analysis && id !== 'import-data'; });
    $('possession-list').setAttribute('aria-busy', String(value));
    $('fan-mode').disabled = value;
    $('analyst-mode').disabled = value;
    $('ask-button').disabled = value || state.questionBusy || !state.analysis;
  }
  async function api(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(path, {
        method: body ? 'POST' : 'GET', signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
      });
      let result;
      try { result = await response.json(); } catch { throw new Error('服务返回了无法读取的数据。'); }
      if (!response.ok) {
        const message = typeof result.error === 'string' ? result.error : result.message || '数据未通过校验，请检查文件格式。';
        throw new Error(message);
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('本地分析服务响应超时，请稍后重试。');
      if (error instanceof TypeError) throw new Error('无法连接本地分析服务，请确认工作台服务已启动。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function provenanceLabel() {
    const kind = state.dataset?.provenance.kind;
    const detail = state.dataset?.provenance;
    $('provenance-label').textContent = kind === 'synthetic' ? '合成演练 · 非真实 NBA 比赛' : kind === 'official' ? '用户声明的官方数据 · 来源见方法说明' : '用户导入数据 · 来源由提供者声明';
    $('provenance-detail').textContent = kind === 'synthetic' ? '视频、轨迹及指标均为演练数据，不代表真实比赛事实' : (detail?.label || detail?.source || '请核对视频与分析数据是否匹配');
    updateOverlayBadge();
  }
  function updateOverlayBadge() {
    const synthetic = state.dataset?.provenance.kind === 'synthetic';
    $('overlay-badge').textContent = !state.synchronized ? '视频未配对 · 叠加暂停' : !state.overlay ? '原画对照 · 叠加已关闭' : synthetic ? '演练轨迹 · 已叠加' : '提供者轨迹 · 已叠加';
  }
  function safeVideoURL(url) {
    if (typeof url !== 'string') return null;
    try {
      const parsed = new URL(url, location.origin);
      if (parsed.origin === location.origin && ['http:', 'https:'].includes(parsed.protocol)) return parsed.href;
    } catch {}
    return null;
  }
  function loadVideo(url, label, file = null) {
    if (!url || state.previousVideoURL === url) return;
    state.videoReady = false; state.mediaHash = null; state.mediaError = '';
    state.synchronized = false; const mediaVersion = ++state.mediaVersion;
    checkMedia(); hashMedia(url, file, mediaVersion);
    state.previousVideoURL = url;
    video.pause();
    $('video-empty').replaceChildren(el('span', 'loader'), el('strong', '', '正在载入比赛画面'), el('span', '', '同步视频、轨迹与解说证据'));
    $('video-empty').hidden = false;
    $('stage-play').hidden = true;
    video.src = url;
    video.load();
    $('video-source').textContent = label;
  }
  async function analyze(dataset, initial = false) {
    const version = ++state.requestVersion;
    setBusy(true);
    try {
      const analysis = await api('/api/analyze', { dataset, audience: state.audience });
      if (version !== state.requestVersion) return;
      if (!analysis || !Array.isArray(analysis.possessions)) throw new Error('分析结果缺少回合数据。');
      state.dataset = dataset;
      state.analysis = analysis;
      state.apiError = false;
      state.askVersion++;
      state.questionBusy = false;
      $('answer-panel').hidden = true;
      const query = new URL(location.href).searchParams.get('possession');
      const requested = initial ? query : state.possessionId;
      const sorted = [...analysis.possessions].sort((a,b) => b.rank_score - a.rank_score);
      state.possessionId = sorted.some(p => p.id === requested) ? requested : sorted[0]?.id || null;
      renderAll();
      if (!state.importedVideo) {
        const url = safeVideoURL(dataset.video.url);
        if (url) loadVideo(url, dataset.provenance.kind === 'synthetic' ? 'DEMO FILM' : 'SOURCE FILM');
        else {
          video.removeAttribute('src'); video.load(); state.previousVideoURL = null;
          showVideoError('请导入与分析匹配的视频', '为保护本地工作区，不自动加载外部视频地址。');
        }
      }
      if (initial && query && query === state.possessionId) seek(rawPossession()?.start || 0, false);
      updateURL();
      checkMedia();
      updateClock();
    } catch (error) {
      if (version !== state.requestVersion) return;
      state.apiError = true;
      notify(`分析未完成：${error.message}`, 'warning', true);
      if (!state.analysis) {
        $('possession-list').replaceChildren(el('p', 'empty-evidence', '暂时无法读取回合。请重试，或导入有效的分析 JSON。'));
        $('narrative-text').textContent = '分析尚未完成。连接恢复后，解说和证据将显示在这里。';
      }
      throw error;
    } finally { if (version === state.requestVersion) setBusy(false); }
  }
  async function init() {
    setBusy(true);
    try {
      const projectId=new URL(location.href).searchParams.get('project');
      let dataset;
      if(projectId){
        const result=await api('/api/projects/'+encodeURIComponent(projectId));
        dataset=result.project.dataset;
        $('project-link').href='/projects.html?project='+encodeURIComponent(projectId);
        $('project-link').textContent='项目 · '+result.project.name;
        $('annotation-link').href='/annotate.html?project='+encodeURIComponent(projectId);
        $('annotation-link').hidden=false;
      }else dataset=await api('/api/demo');
      await analyze(dataset, true);
      $('status-banner').hidden = true;
      if(dataset.workflow?.state==='draft')notify('这是尚未复核的编辑草稿。回合字段可能仍为占位内容，请先在项目页完成标注。');
    } catch (error) {
      notify(`工作台未能载入：${error.message}`, 'warning', true);
      if (!state.dataset) showVideoError('等待比赛数据', '请重试本地服务，或导入视频与分析 JSON。');
      setBusy(false);
    }
  }
  function renderAll() {
    const { dataset } = state;
    provenanceLabel();
    $('game-title').textContent = dataset.game.title;
    $('away-team').textContent = dataset.game.home;
    $('home-team').textContent = dataset.game.away;
    ['away-team','home-team'].forEach(id=>{$(id).classList.toggle('hou',$(id).textContent==='HOU');$(id).classList.toggle('dal',$(id).textContent==='DAL');});
    $('game-score').textContent = dataset.game.score;
    $('game-period').textContent = dataset.game.period;
    $('possession-count').textContent = String(dataset.possessions.length).padStart(2, '0');
    $('total-time').textContent = time(duration());
    $('timeline-mid').textContent = time(datasetDuration() / 2);
    $('timeline-end').textContent = time(datasetDuration());
    $('video-progress').max = duration();
    renderPossessions(); renderTimeline(); renderInsight(); renderTrace(state.analysis.trace || []);
    $('analysis-summary').textContent = state.analysis.summary || '';
    syncAudienceButtons();
  }
  function renderPossessions() {
    const list = $('possession-list'); list.replaceChildren();
    const sorted = [...state.analysis.possessions].sort((a,b) => b.rank_score - a.rank_score);
    sorted.forEach((p,index) => {
      const raw = state.dataset.possessions.find(item => item.id === p.id);
      const button = el('button', 'possession-card');
      button.type = 'button'; button.dataset.id = p.id;
      button.setAttribute('aria-current', String(p.id === state.possessionId));
      button.setAttribute('aria-label', `回看 ${p.title}，${time(p.start)} 至 ${time(p.end)}`);
      const top = el('div', 'possession-top');
      top.append(el('span', 'possession-number', `0${index + 1} / PLAY`), el('span', 'possession-time', raw?.clock || `${time(p.start)}`));
      const bottom = el('div', 'possession-bottom');
      const result = el('span', 'possession-result');
      result.append(el('i','result-dot'), document.createTextNode(raw?.result === 'made' ? `命中 · ${raw.points} 分` : raw?.result === 'missed' ? '投篮未中' : '结果未提供'));
      const rank = Number.isFinite(p.rank_score) ? p.rank_score.toFixed(1) : '—';
      bottom.append(result,el('span','possession-score',`编辑评分 ${rank}`));
      button.append(top,el('h3','',p.title),el('p','possession-description',p.headline),bottom);
      button.addEventListener('click', () => selectPossession(p.id, true));
      list.append(button);
    });
    if (!sorted.length) list.append(el('p','empty-evidence','这份数据暂无可分析的回合。'));
  }
  function renderTimeline() {
    const timeline = $('timeline'); timeline.replaceChildren();
    const d = datasetDuration();
    [...state.dataset.possessions].sort((a,b)=>a.start-b.start).forEach((p,index) => {
      const button = el('button', 'timeline-segment'); button.type = 'button';
      button.style.left = `${Math.max(0,p.start/d*100)}%`;
      button.style.width = `calc(${Math.min(100,(p.end-p.start)/d*100)}% - 4px)`;
      button.dataset.id = p.id;
      button.setAttribute('aria-current',String(p.id===state.possessionId));
      button.setAttribute('aria-label',`${p.title}，跳转至 ${time(p.start)}`);
      button.title = `${p.title} · ${time(p.start)}—${time(p.end)}`;
      button.append(el('span','timeline-number',String(index+1).padStart(2,'0')),document.createTextNode(p.title));
      button.addEventListener('click',()=>selectPossession(p.id,true)); timeline.append(button);
    });
    state.marker = el('span','timeline-marker'); state.marker.setAttribute('aria-hidden','true'); timeline.append(state.marker);
  }
  function selectPossession(id, doSeek = false) {
    if (!state.dataset?.possessions.some(p => p.id === id)) return;
    const changed = id !== state.possessionId;
    state.possessionId = id;
    if (changed) {
      document.querySelectorAll('.possession-card,.timeline-segment').forEach(button=>button.setAttribute('aria-current',String(button.dataset.id===id)));
      renderInsight();
      $('answer-panel').hidden = true;
      state.askVersion++; state.questionBusy = false; $('ask-button').disabled = state.analysisBusy;
      updateURL();
    }
    if (doSeek) seek(rawPossession().start, false);
  }
  function updateURL() {
    const url = new URL(location.href);
    if (state.possessionId) url.searchParams.set('possession',state.possessionId); else url.searchParams.delete('possession');
    try { history.replaceState({},'',url); } catch {}
  }
  function syncAudienceButtons() {
    $('fan-mode').setAttribute('aria-pressed',String(state.audience==='fan'));
    $('analyst-mode').setAttribute('aria-pressed',String(state.audience==='analyst'));
    $('narrative-kicker').textContent = state.audience === 'fan' ? '球迷解说 · 通俗呈现' : '分析师解说 · 指标与边界';
  }
  function renderInsight() {
    const p = analyzedPossession();
    if (!p) return;
    $('narrative-headline').textContent = p.headline || p.title;
    $('narrative-text').textContent = state.audience === 'fan' ? p.fan_narration : p.analyst_narration;
    const claims = $('claims'); claims.replaceChildren();
    const claimDetails=el('details','claim-details');
    const counts={observed:0,inferred:0,unavailable:0};(p.claims||[]).forEach(c=>{if(c.type in counts)counts[c.type]++;});
    claimDetails.append(el('summary','',`逐条核验 · ${counts.observed} 已观测 / ${counts.inferred} 推断 / ${counts.unavailable} 未知`));
    (p.claims || []).forEach(c=>{
      const row=el('div','claim-row'), tag=el('span',`claim-tag ${c.type}`,c.type==='observed'?'已观测':c.type==='inferred'?'推断':'未知');
      row.append(tag,el('span','',c.text)); claimDetails.append(row);
    });
    claims.append(claimDetails);
    const list = $('evidence-list'); list.replaceChildren();
    const extra = el('details','more-evidence');
    const extraCount = (p.evidence||[]).filter(e=>!e.id.includes(':metric:')).length;
    extra.append(el('summary','',`展开事件、轨迹与标注证据（${extraCount}）`));
    (p.evidence || []).forEach(e=>{
      const metric = e.id.includes(':metric:');
      const button=el('button',`evidence-card${metric?'':' compact-evidence'}`); button.type='button';
      button.title=`${e.definition || e.label}\n来源：${e.source || '未注明'}\n点击回看 ${time(e.time)}`;
      let formatted=formatEvidenceValue(e),unit=e.unit||'';
      if (typeof e.value==='number' && e.unit==='probability (0–1)') { formatted=(e.value*100).toFixed(1);unit='%'; }
      if (e.value===null || e.value===undefined) unit='';
      if (!metric) unit='';
      button.setAttribute('aria-label', `${e.label}，${formatted} ${unit}，跳转至 ${time(e.time)}`);
      const top=el('div','evidence-card-top'); top.append(el('span','evidence-label',e.label),el('span','evidence-time',`${time(e.time)} ↗`));
      const value=el('span',`evidence-value${formatted.length>12?' long-value':''}`,formatted);
      if(unit) value.append(el('span','evidence-unit',unit));
      button.append(top,value,el('span','evidence-source',state.dataset.provenance.kind==='synthetic'?'合成演练输入 · 非真实比赛指标':e.source || '数据未注明来源'));
      button.addEventListener('click',()=>seek(e.time,false)); (metric?list:extra).append(button);
    });
    if(extraCount)list.append(extra);
    if (!(p.evidence || []).length) list.append(el('p','empty-evidence','这一回合没有可核验的证据，暂不生成解释。'));
    $('evidence-count').textContent = `${(p.evidence||[]).length} 条 · 点击回看`;
    const warnings = [...new Set(p.warnings||[])];
    $('possession-warnings').textContent = warnings.join('；');
    $('possession-warnings').hidden = !warnings.length;
    syncAudienceButtons();
    state.activeCue = ''; updateCaptions();
  }
  function formatEvidenceValue(e) {
    const value=e.value;
    if(value===null||value===undefined)return '未提供';
    if(typeof value!=='object')return formatValue(value);
    if(value.shooter) return `${value.shooter} · ${value.shot_value} 分投篮`;
    if(value.sample_time!==undefined) return `${value.player?.id||'球员未知'} · ${time(value.sample_time)} 轨迹样本`;
    if(value.annotations) return `${value.annotations.length} 处几何注释 · 点击定位`;
    return '结构化证据 · 详见分析 JSON';
  }
  function formatValue(value) {
    if (value === null || value === undefined) return '未提供';
    if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '未提供';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
  function renderTrace(trace) {
    const box=$('agent-trace'); box.replaceChildren();
    trace.forEach((item,index)=>{
      const step=el('div','trace-step');
      step.tabIndex=0; step.setAttribute('role','button');
      step.setAttribute('aria-label',`${item.step}，状态 ${item.status}，查看执行详情`);
      step.title=`${item.tool}: ${item.detail}`;
      const names={validate_dataset:'数据校验',collect_evidence:'提取证据',selection_score:'精选回合',compose_grounded_narration:'生成解说',classify_question:'识别问题',retrieve_evidence:'检索证据',compose_answer:'组织回答',validate_request:'校验提问',route_question:'识别问题',explain_selection:'解释筛选',lookup_evidence:'核对证据',compare_possessions:'比较回合',explain_metric:'解释指标',summarize_event:'概括回合',report_unsupported:'报告边界',guard_untrusted_question:'检验边界'};
      const stepName=names[item.tool]||String(item.step);
      step.append(el('span','trace-icon',/error|fail/i.test(item.status)?'!':item.status==='unsupported'?'?':'✓'),el('span','trace-title',stepName),el('span','trace-tool',item.status==='ok'?'已完成':item.status==='unsupported'?'证据不足':item.status));
      const open=()=>showDialog(`Agent · ${item.step}`, [
        ['执行工具',item.tool],['返回状态',item.status],['执行详情',item.detail]
      ]);
      step.addEventListener('click',open);
      step.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
      box.append(step);
    });
    if (!trace.length) box.append(el('p','section-note','服务未提供执行记录。'));
  }
  function updateClock() {
    const t=video.currentTime||0;
    $('current-time').textContent=time(t);
    $('video-progress').value=t;
    $('video-progress').style.setProperty('--progress',`${Math.min(100,t/duration()*100)}%`);
    if(state.marker) state.marker.style.left=`${Math.min(100,t/datasetDuration()*100)}%`;
    if(state.dataset){
      const playing=state.synchronized && state.dataset.possessions.find(p=>t>=p.start && t<p.end);
      if(playing && playing.id!==state.possessionId) selectPossession(playing.id,false);
    }
    renderOverlay(t); updateCaptions();
  }
  function frameLoop(){updateClock();if(!video.paused&&!video.ended)state.raf=requestAnimationFrame(frameLoop);}
  function playIcon(paused){
    const icon=svgEl('svg',{viewBox:'0 0 20 20','aria-hidden':'true'});
    icon.append(svgEl('path',{d:paused?'m6 3 11 7-11 7z':'M5 3h4v14H5zM12 3h4v14h-4z'}));
    $('play-button').replaceChildren(icon);$('play-button').setAttribute('aria-label',paused?'播放':'暂停');
    $('video-stage').classList.toggle('is-playing',!paused);
  }
  async function togglePlay(){
    if(!state.videoReady){notify('视频尚未就绪，请等待载入或导入本地视频。');return;}
    if(video.paused){try{await video.play();}catch{notify('浏览器暂时无法播放这段视频，请检查格式或重新导入。');}}else video.pause();
  }
  function seek(target, play=false, evidence=true){
    if(evidence&&!state.synchronized){notify('视频与数据尚未配对，已暂停证据跳转。请按下方核验提示处理。');return;}
    const t=Math.max(0,Math.min(duration(),Number(target)||0));
    if(video.readyState>=1){video.currentTime=t;updateClock();if(play)video.play().catch(()=>{});}
    else {
      const onMetadata=()=>{video.currentTime=Math.min(duration(),t);updateClock();};
      video.addEventListener('loadedmetadata',onMetadata,{once:true});
      $('current-time').textContent=time(t);
    }
  }
  function nextEvidence(){
    const list=(state.analysis?.possessions||[]).flatMap(p=>p.evidence||[]).filter(e=>Number.isFinite(e.time)).sort((a,b)=>a.time-b.time);
    if(!list.length){notify('当前数据没有可以跳转的证据。');return;}
    const next=list.find(e=>e.time>video.currentTime+.12)||list[0];seek(next.time,false);
  }
  function currentCamera(p,t){return (p.camera_segments||[]).find(c=>t>=c.start && t<c.end);}
  function renderOverlay(t){
    const root=$('video-overlay'),p=rawPossession();
    const camera=p&&currentCamera(p,t),calibrated=!!camera?.calibrated;
    const active=!!p&&t>=p.start&&t<p.end;
    $('calibration-note').hidden=!(state.synchronized&&state.overlay&&active&&!calibrated);
    root.replaceChildren();
    if(!state.synchronized||!state.overlay||!active||!camera) return;
    const manual=(p.annotations||[]).some(a=>a.origin==='manual'&&a.frame_reviewed===true&&t>=a.start&&t<a.end);
    if(!calibrated&&!manual)return;
    // A terminal possession sample can close its final camera interval. Samples
    // on an internal cut belong to the next camera and cannot bridge that cut.
    const frames=(p.tracks||[]).filter(f=>f.t>=camera.start&&(f.t<camera.end||(f.t===camera.end&&camera.end===p.end))).sort((a,b)=>a.t-b.t);
    let before=null,after=null;
    for(const frame of frames){if(frame.t<=t)before=frame;if(frame.t>=t){after=frame;break;}}
    // Both brackets are required: never hold a first/last sample outside its
    // measured interval, and never fill a tracking gap longer than one second.
    const tracked=calibrated&&!!before&&!!after&&after.t-before.t<=1.0;
    if(!tracked&&!manual)return;
    if(!tracked){before={t,players:[],ball:null};after=before;}
    const mix=before.t===after.t?0:(t-before.t)/(after.t-before.t);
    const W=Number(state.dataset?.video?.width),H=Number(state.dataset?.video?.height);
    if(!Number.isFinite(W)||!Number.isFinite(H)||W<=0||H<=0)return;
    root.setAttribute('viewBox',`0 0 ${W} ${H}`);
    const defs=svgEl('defs'),marker=svgEl('marker',{id:'route-arrow',viewBox:'0 0 10 10',refX:8,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});
    marker.append(svgEl('path',{d:'M0 0L10 5L0 10z',fill:'#8bb6ff'}));defs.append(marker);root.append(defs);
    (p.annotations||[]).filter(a=>t>=a.start&&t<a.end&&((a.origin==='manual'&&a.frame_reviewed===true)||(tracked&&a.origin!=='manual'))).forEach(a=>{
      const pts=(a.points||[]).map(pt=>[pt[0]*W,pt[1]*H]);if(!pts.length)return;
      const title=svgEl('title',{},a.label||a.kind);
      let shape;
      if(a.kind==='zone'){
        if(pts.length===2){const [one,two]=pts;shape=svgEl('rect',{x:Math.min(one[0],two[0]),y:Math.min(one[1],two[1]),width:Math.abs(two[0]-one[0]),height:Math.abs(two[1]-one[1]),rx:14,fill:'#8bb6ff','fill-opacity':.10,stroke:'#8bb6ff','stroke-opacity':.6,'stroke-width':2,'stroke-dasharray':'7 6'});}
        else shape=svgEl('polygon',{points:pts.map(pt=>pt.join(',')).join(' '),fill:'#8bb6ff','fill-opacity':.10,stroke:'#8bb6ff','stroke-opacity':.6,'stroke-width':2,'stroke-dasharray':'7 6'});
      }else if(a.kind==='arrow') shape=svgEl('polyline',{points:pts.map(pt=>pt.join(',')).join(' '),fill:'none',stroke:'#8bb6ff','stroke-width':4,'stroke-linecap':'round','stroke-linejoin':'round','stroke-dasharray':'10 7','marker-end':'url(#route-arrow)'});
      if(shape){shape.append(title);root.append(shape);}
      if(a.label){const [x,y]=pts[0];const lx=Math.max(12,Math.min(W-210,x+10)),ly=Math.max(30,y-15);root.append(svgEl('text',{x:lx,y:ly,fill:'#bcd1ee','font-size':19,class:'overlay-label'},(a.origin==='manual'?'人工 · ':'')+a.label));}
    });
    // Interpolate only between nearby samples in the same calibrated camera segment.
    (before.players||[]).forEach(player=>{
      const next=(after.players||[]).find(n=>n.id===player.id&&n.team===player.team);
      if(!next)return;
      const x=(player.x+(next.x-player.x)*mix)*W,y=(player.y+(next.y-player.y)*mix)*H;
      const color=player.team==='HOU'?'#f5a17d':'#a9d5ec';
      root.append(svgEl('ellipse',{cx:x,cy:y+11,rx:21,ry:8,fill:color,'fill-opacity':.10,stroke:color,'stroke-width':2}));
      const id=String(player.id),width=Math.max(34,id.length*10+10);
      root.append(svgEl('rect',{x:x-width/2,y:y-37,width,height:24,rx:5,fill:'#0d1117','fill-opacity':.85,stroke:color,'stroke-width':1.2}));
      root.append(svgEl('text',{x,y:y-20,fill:color,'font-size':15,'text-anchor':'middle','font-weight':700,'font-family':'system-ui,sans-serif'},id));
    });
    if(before.ball&&after.ball){const x=(before.ball.x+(after.ball.x-before.ball.x)*mix)*W,y=(before.ball.y+(after.ball.y-before.ball.y)*mix)*H;
      root.append(svgEl('circle',{cx:x,cy:y,r:10,fill:'none',stroke:'#8bb6ff','stroke-width':2.5}));root.append(svgEl('circle',{cx:x,cy:y,r:3,fill:'#8bb6ff'}));}
  }
  function updateCaptions(){
    const p=analyzedPossession(),t=video.currentTime||0;
    const cue=(p?.cues||[]).find(c=>t>=c.start&&t<c.end);
    const text=state.synchronized ? (cue?.text||'') : '';
    if(state.activeCue!==text){$('video-caption').textContent=text;state.activeCue=text;}
  }
  async function changeAudience(audience){
    if(state.audience===audience||!state.dataset||state.analysisBusy)return;
    const old=state.audience;state.audience=audience;syncAudienceButtons();
    try{await analyze(state.dataset);}catch{state.audience=old;syncAudienceButtons();}
  }
  async function ask(question){
    const cleaned=question.trim();if(!cleaned||!state.dataset||!state.analysis)return;
    const version=++state.askVersion;state.questionBusy=true;$('ask-button').disabled=true;
    const panel=$('answer-panel');panel.hidden=false;panel.replaceChildren(el('span','', '正在检索当前回合的证据…'));
    try{
      const result=await api('/api/ask',{dataset:state.dataset,question:cleaned,possession_id:state.possessionId,audience:state.audience});
      if(version!==state.askVersion)return;
      panel.replaceChildren(el('div','',result.answer||'当前数据不足以回答这个问题。'));
      const refs=el('div','answer-evidence');
      (result.evidence_ids||[]).forEach(id=>{
        const evidence=state.analysis.possessions.flatMap(p=>p.evidence||[]).find(e=>e.id===id);
        if(!evidence)return;
        const button=el('button','',`${evidence.label} · ${time(evidence.time)} ↗`);button.type='button';button.addEventListener('click',()=>seek(evidence.time,false));refs.append(button);
      });
      if(refs.childElementCount)panel.append(refs);
      if(result.warnings?.length)panel.append(el('p','warning-note',result.warnings.join('；')));
      if(result.trace?.length)renderTrace(result.trace);
    }catch(error){if(version===state.askVersion)panel.replaceChildren(el('span','',`提问未完成：${error.message}`));}
    finally{if(version===state.askVersion){state.questionBusy=false;$('ask-button').disabled=state.analysisBusy;}}
  }
  function showDialog(title,sections){
    $('dialog-title').textContent=title;const content=$('dialog-content');content.replaceChildren();
    sections.forEach(([heading,text])=>{if(heading)content.append(el('h3','',heading));content.append(el('p','',text));});
    if(!$('info-dialog').open)$('info-dialog').showModal();
  }
  function showMethod(){
    const definitions=state.dataset?.metric_definitions||{},source=state.dataset?.provenance;
    const sections=[
      ['这个工作台做什么','将回合轨迹、指标和时间戳作为输入，由本地确定性证据 Agent 选择片段、组织解说、检索问题并返回证据。当前版本不调用外部大模型，也不从视频中自动识别球员。'],
      ['数据与版权',source?`${source.label}。来源声明：${source.source}。${source.kind==='synthetic'?'当前视频、轨迹、球员编号及指标全部为合成演练，不是 NBA 官方素材，也不代表任何真实比赛。':'来源由导入者声明；本工具未独立认证来源及版权。'}`:'正在等待数据。'],
      ['一个时间基准','所有轨迹、战术标注、字幕和证据均以视频当前时间同步。坐标为视频平面归一化坐标。只在同一已校准镜头内插值；遇到未校准镜头或轨迹缺失时隐藏图层。'],
      ['如何导入','选择本地视频，再导入符合 schema_version 1.0 的数据集 JSON；此页临时导入视频不会上传；项目页可把视频持久保存至本机服务，均不发送云端。JSON 仅发送到当前本地分析服务。导入数据需包含视频 SHA-256；指纹、尺寸和时长匹配后才显示叠加与字幕。指纹不能证明标注正确，仍需人工校准时间和镜头；浏览器核验限制512 MB。导出的分析 JSON 用于审阅，并非可重新导入的数据集。'],
      ['xFG%',definitions.xfg_pct||'数据源未提供定义。'],['Gravity',definitions.gravity||'数据源未提供定义。'],['Leverage',definitions.leverage||'数据源未提供定义。'],
      ['解释边界','明确区分已观测、推断与未知。缺失数据不补造；不以最近防守者距离替代 Gravity，也不把命中结果或单一指标当成战术因果关系。编辑评分用于选择值得复盘的回合，不是胜率或准确率。'],
      ['导出内容','顶部下载按钮导出完整分析 JSON；解说区导出当前视角的 WebVTT 字幕。字幕内容来自本地 Agent 已生成的时间片段。']
    ];showDialog('方法与数据说明',sections);
  }
  function showRanking(){
    const sections=(state.analysis?.possessions||[]).slice().sort((a,b)=>b.rank_score-a.rank_score).map(p=>[`${p.title} · 编辑评分 ${Number.isFinite(p.rank_score)?p.rank_score.toFixed(1):'未知'}`,(p.rank_reasons||[]).join('；')||'服务未提供评分依据。']);
    sections.unshift(['评分如何使用','评分来自本地 API 返回的可解释选择规则。仅用于回合排序，不是胜率、官方 NBA 评分或模型准确率。']);showDialog('为什么选择这些回合',sections);
  }
  function showKeyboard(){
    showDialog('键盘快捷键',[
      ['空格 / K','播放或暂停视频。'],['← / →','后退或前进 5 秒。'],['O','开启或关闭战术透镜，对照原画。'],['N','跳转下一处证据；到达末尾后返回第一条。'],['M / F','静音切换 / 视频全屏。'],['Tab / Enter','依次访问按钮与证据，按回车选择。输入问题时不会触发播放器快捷键。']
    ]);
  }
  function download(blob,name){const url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
  function exportJSON(){if(!state.analysis)return;download(new Blob([JSON.stringify(state.analysis,null,2)],{type:'application/json'}),`courtlens-analysis-${state.audience}.json`);notify('分析 JSON 已导出，包含解说、证据与 Agent 执行记录。','success');}
  function exportVTT(){
    if(!state.analysis)return;
    const cues=state.analysis.possessions.flatMap(p=>p.cues||[]).filter(c=>Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.end>c.start).sort((a,b)=>a.start-b.start);
    if(!cues.length){notify('当前分析没有可以导出的字幕。');return;}
    const text='WEBVTT\n\nNOTE CourtLens '+(state.audience==='fan'?'球迷视角':'分析师视角')+' | '+$('provenance-label').textContent+'\n\n'+cues.map((cue,index)=>`${index+1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${String(cue.text).replace(/-->/g,'→').replace(/[\r\n]+/g,' ').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}\n`).join('\n');
    download(new Blob([text],{type:'text/vtt;charset=utf-8'}),`courtlens-${state.audience}.vtt`);notify(`已导出${state.audience==='fan'?'球迷':'分析师'}视角字幕。`,'success');
  }
  function showVideoError(title,detail){state.videoReady=false;checkMedia();$('video-empty').replaceChildren(el('strong','',title),el('span','',detail));$('video-empty').hidden=false;$('stage-play').hidden=true;}
  async function hashMedia(url,file,version) {
    try {
      const limit=512*1024*1024;
      if(file && file.size>limit)throw new Error('浏览器核验最多支持512 MB视频，请先剪出参赛片段并重新生成数据');
      let bytes;
      if(file)bytes=await file.arrayBuffer();
      else {
        const response=await fetch(url);
        if(!response.ok)throw new Error('无法读取视频指纹，请检查本地文件');
        if(Number(response.headers.get('content-length'))>limit)throw new Error('视频超过512 MB，请先剪出参赛片段');
        bytes=await response.arrayBuffer();
      }
      if(bytes.byteLength>limit)throw new Error('视频超过512 MB，请先剪出参赛片段');
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      if(version!==state.mediaVersion)return;
      state.mediaHash=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
    }catch(error){if(version===state.mediaVersion)state.mediaError=error.message||'视频指纹核验失败';}
    if(version===state.mediaVersion){checkMedia();updateClock();}
  }
  function checkMedia(){
    const result=CourtLensMedia.check(state.dataset?.video,{ready:state.videoReady,
      error:state.mediaError,sha256:state.mediaHash,width:video.videoWidth,
      height:video.videoHeight,duration:video.duration});
    state.synchronized=result.ok;
    $('media-status').textContent=result.message;
    $('media-status').classList.toggle('media-matched',result.ok);
    $('next-evidence').disabled=!result.ok;
    if(result.ok)$('video-stage').style.aspectRatio=`${video.videoWidth} / ${video.videoHeight}`;
    else {$('video-overlay').replaceChildren();$('video-caption').textContent='';state.activeCue='';}
    updateOverlayBadge();
  }
  $('play-button').addEventListener('click',togglePlay);$('stage-play').addEventListener('click',togglePlay);
  video.addEventListener('click',togglePlay);
  video.addEventListener('play',()=>{playIcon(false);cancelAnimationFrame(state.raf);frameLoop();});
  video.addEventListener('pause',()=>{playIcon(true);cancelAnimationFrame(state.raf);updateClock();});
  video.addEventListener('ended',()=>playIcon(true));
  video.addEventListener('timeupdate',updateClock);video.addEventListener('seeked',updateClock);
  video.addEventListener('loadedmetadata',()=>{state.videoReady=true;$('video-empty').hidden=true;$('stage-play').hidden=false;$('total-time').textContent=time(duration());$('video-progress').max=duration();checkMedia();updateClock();});
  video.addEventListener('canplay',()=>{$('video-empty').hidden=true;});
  video.addEventListener('error',()=>{if(video.hasAttribute('src'))showVideoError('这段视频暂时无法播放','请检查视频文件，或使用“导入视频”选择 MP4 / WebM 文件。');});
  $('video-progress').addEventListener('input',event=>seek(event.target.value,false,false));
  $('playback-speed').addEventListener('change',event=>{video.playbackRate=Number(event.target.value);});
  $('overlay-toggle').addEventListener('click',()=>{state.overlay=!state.overlay;$('overlay-toggle').setAttribute('aria-checked',String(state.overlay));$('toggle-hint').textContent=state.overlay?'开启':'关闭';updateOverlayBadge();updateClock();});
  $('next-evidence').addEventListener('click',nextEvidence);
  $('mute-button').addEventListener('click',()=>{video.muted=!video.muted;$('mute-button').setAttribute('aria-label',video.muted?'取消静音':'静音');$('mute-button').title=video.muted?'取消静音':'静音';$('mute-button').style.color=video.muted?'#53647b':'';});
  $('fullscreen-button').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if($('video-stage').requestFullscreen)await $('video-stage').requestFullscreen();else if(video.webkitEnterFullscreen)video.webkitEnterFullscreen();else notify('当前浏览器不支持全屏，可以扩大窗口观看。');}catch{notify('当前浏览器暂时无法进入全屏。');}});
  $('fan-mode').addEventListener('click',()=>changeAudience('fan'));$('analyst-mode').addEventListener('click',()=>changeAudience('analyst'));
  $('question-form').addEventListener('submit',event=>{event.preventDefault();ask($('question-input').value);});
  document.querySelectorAll('[data-question]').forEach(button=>button.addEventListener('click',()=>{$('question-input').value=button.dataset.question;ask(button.dataset.question);}));
  $('method-button').addEventListener('click',showMethod);$('ranking-button').addEventListener('click',showRanking);$('keyboard-button').addEventListener('click',showKeyboard);
  $('close-dialog').addEventListener('click',()=>$('info-dialog').close());$('dialog-done').addEventListener('click',()=>$('info-dialog').close());
  $('info-dialog').addEventListener('click',event=>{if(event.target===$('info-dialog')){const r=event.target.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)event.target.close();}});
  $('export-json').addEventListener('click',exportJSON);$('export-vtt').addEventListener('click',exportVTT);
  $('import-video').addEventListener('click',()=>$('video-file').click());
  $('video-file').addEventListener('change',event=>{
    const file=event.target.files[0];if(!file)return;
    if(!file.type.startsWith('video/')&&!/\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name)){notify('请选择浏览器可播放的视频文件。');return;}
    const old=state.objectURL;state.objectURL=URL.createObjectURL(file);state.importedVideo=true;loadVideo(state.objectURL,'LOCAL VIDEO',file);if(old)URL.revokeObjectURL(old);
    notify(`已载入本地视频“${file.name}”，视频不会上传。核验通过前暂停同步标注。`,'success');event.target.value='';
  });
  $('import-data').addEventListener('click',()=>$('data-file').click());
  $('data-file').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    try{
      if(file.size>8*1024*1024)throw new Error('分析文件超过 8 MB，请缩小数据后重试。');
      const dataset=JSON.parse(await file.text());
      if(dataset.schema_version!=='1.0'||!Array.isArray(dataset.possessions)||!dataset.video||!dataset.provenance)throw new Error('需要 schema_version 为 1.0、包含 possessions、video 与 provenance 的数据集 JSON。导出的分析结果不含原始轨迹，不能直接作为数据集导入。');
      await analyze(dataset);checkMedia();notify(`已载入“${file.name}”，共 ${dataset.possessions.length} 个回合。`,'success');
    }catch(error){notify(`导入失败：${error instanceof SyntaxError?'JSON 格式无法解析，请检查文件内容。':error.message}`);}
    finally{event.target.value='';}
  });
  $('dismiss-status').addEventListener('click',()=>$('status-banner').hidden=true);
  $('retry-button').addEventListener('click',()=>{if(state.dataset)analyze(state.dataset).then(()=>$('status-banner').hidden=true).catch(()=>{});else init();});
  window.addEventListener('popstate',()=>{const id=new URL(location.href).searchParams.get('possession');if(id)selectPossession(id,true);});
  window.addEventListener('keydown',event=>{
    if(event.ctrlKey||event.metaKey||event.altKey||$('info-dialog').open||/INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target.tagName)||event.target.isContentEditable)return;
    const key=event.key.toLowerCase();
    if(key===' '||key==='k'){event.preventDefault();togglePlay();}
    else if(key==='arrowleft'){event.preventDefault();seek(video.currentTime-5,false,false);}
    else if(key==='arrowright'){event.preventDefault();seek(video.currentTime+5,false,false);}
    else if(key==='o')$('overlay-toggle').click();else if(key==='n')nextEvidence();else if(key==='m')$('mute-button').click();else if(key==='f')$('fullscreen-button').click();
  });
  window.addEventListener('beforeunload',()=>{if(state.objectURL)URL.revokeObjectURL(state.objectURL);});
  init();
})();
