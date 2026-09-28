'use strict';
(() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  function nullableNumber(value, label, minimum, maximum) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) throw new Error(`${label}请填写数字，未知时留空。`);
    const number = Number(raw);
    if (!Number.isFinite(number)) throw new Error(`${label}必须是有限数字。`);
    if (minimum !== undefined && number < minimum) throw new Error(`${label}不能小于 ${minimum}。`);
    if (maximum !== undefined && number > maximum) throw new Error(`${label}不能大于 ${maximum}。`);
    return number;
  }
  function requiredNumber(value, label, minimum, maximum) {
    const number = nullableNumber(value, label, minimum, maximum);
    if (number === null) throw new Error(`请填写${label}。`);
    return number;
  }
  function requiredText(value, label, maximum = 2000) {
    const text = String(value ?? '').trim();
    if (!text) throw new Error(`请填写${label}。`);
    if (text.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符。`);
    return text;
  }
  function clockTime(seconds) {
    const n = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(n / 3600), m = Math.floor(n / 60) % 60, s = Math.floor(n) % 60;
    return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function byteSize(bytes) {
    const n = Math.max(0, Number(bytes) || 0);
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
    if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function nextInterval(dataset) {
    const duration = Number(dataset.video.duration);
    let cursor = 0;
    for (const p of [...dataset.possessions].sort((a, b) => a.start - b.start)) {
      if (p.start - cursor > 0.05) return { start: cursor, end: Math.min(p.start, cursor + 12) };
      cursor = Math.max(cursor, p.end);
    }
    return duration - cursor > 0.05 ? { start: cursor, end: Math.min(duration, cursor + 12) } : null;
  }
  function cropPossession(p, start, end) {
    const out = clone(p);
    if (start === p.start && end === p.end) return out;
    out.start = start; out.end = end;
    out.tracks = (out.tracks || []).filter(frame => frame.t >= start && frame.t <= end);
    out.annotations = (out.annotations || []).filter(a => a.end > start && a.start < end).map(a => ({ ...a, start: Math.max(start, a.start), end: Math.min(end, a.end) }));
    out.camera_segments = (out.camera_segments || []).filter(c => c.end > start && c.start < end).map(c => ({ ...c, start: Math.max(start, c.start), end: Math.min(end, c.end), calibrated: false }));
    if (!out.camera_segments.length) out.camera_segments = [{ start, end, calibrated: false }];
    return out;
  }
  function reviewProblem(dataset) {
    if (!dataset?.provenance?.source?.trim()) return '请先补充可核查的数据与视频来源。';
    for (const p of dataset.possessions || []) {
      if (!p.shooter || /待标注|待填写|请填写/.test(p.shooter) || Number(p.points) === 0) return `“${p.title}”仍有投篮球员或分值占位，请完成标注后再复核。`;
      if (p.shot_time < p.start || p.shot_time >= p.end) return `“${p.title}”的出手时间应落在回合内，并早于结束时间。`;
      if (!p.source_refs?.length || p.source_refs.some(ref => /人工标注尚未完成/.test(ref))) return `请为“${p.title}”填写实际证据来源，替换占位说明。`;
    }
    return '';
  }
  function demoDraft(dataset) {
    if (!dataset || dataset.provenance?.kind !== 'synthetic' || !Array.isArray(dataset.possessions) || !dataset.video) throw new Error('内置演练数据的合成标识不完整，暂时无法建立演练项目。');
    const draft = clone(dataset); draft.workflow = { ...(draft.workflow || {}), state: 'draft' }; return draft;
  }
  function exportVoice(checked, capabilities) {
    if (checked === true && capabilities?.tts_available !== true) throw new Error('本机未安装可用配音工具，本次配音任务未提交。');
    return checked === true;
  }
  const logic = { nullableNumber, requiredNumber, requiredText, clockTime, byteSize, nextInterval, cropPossession, reviewProblem, demoDraft, exportVoice };
  if (typeof module !== 'undefined' && module.exports) module.exports = logic;
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const E = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
  const state = { projects: [], project: null, draft: null, possessionId: null, dirty: false, busy: '', loading: false, selection: 0, caps: null, jobs: [], history: [], quality: null, qualityStale: true, qualityRequest: 0, jobsRequest: 0, historyRequest: 0, tab: 'editor', poll: null, xhr: null, pendingMedia: null, pendingMetadata: null, createFile: null, createMetadata: null, createMode: 'video', creating: false, backup: null, noticeAction: null, filter: '' };
  const idPath = id => encodeURIComponent(String(id));
  const projectPath = suffix => `/api/projects/${idPath(state.project.id)}${suffix || ''}`;
  const selectedPossession = () => state.draft?.possessions.find(p => p.id === state.possessionId);
  const dateText = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '时间未提供' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); };

  class RequestError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
  function serverMessage(data) {
    if (typeof data?.error === 'string') return data.error;
    if (typeof data?.message === 'string') return data.message;
    if (data?.error && typeof data.error.message === 'string') return data.error.message;
    return '本机服务未能完成操作，请重试。';
  }
  async function api(url, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      let data;
      try { data = await response.json(); } catch { throw new RequestError('本机服务返回了无法读取的内容。', response.status); }
      if (!response.ok) throw new RequestError(serverMessage(data), response.status, data.code);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('本机服务响应超时。当前修改还在页面中，可以重试。');
      if (error instanceof TypeError) throw new Error('无法连接本机服务，请确认 CourtLens 已启动。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function notify(message, kind = 'warning', action = null) {
    $('notice-text').textContent = message; $('notice').classList.toggle('success', kind === 'success'); $('notice').hidden = false;
    state.noticeAction = action?.run || null; $('notice-action').hidden = !action; $('notice-action').textContent = action?.label || '重试';
  }
  function handleError(error, prefix = '') {
    if (error.status === 409 && state.project) { $('conflict-panel').hidden = false; notify('项目版本已更新。你的草稿尚未覆盖任何保存版本，请先比对或重新载入。'); return; }
    notify(prefix + error.message);
  }
  function setBusy(message = '') {
    state.busy = message;
    $('project-content').setAttribute('aria-busy', String(!!message));
    document.querySelectorAll('#project-content input, #project-content select, #project-content textarea, #project-content button').forEach(control => { control.disabled = !!message; });
    $('new-project').disabled = !!message || state.creating; $('empty-create').disabled = !!message || state.creating; $('empty-demo').disabled = !!message || state.creating; $('create-demo').disabled = !!message || state.creating;
    $('cancel-upload').disabled = false;
    updateControls(); renderDirty();
  }
  function updateControls() {
    $('save-project').disabled = !state.project || !state.dirty || !!state.busy;
    $('save-project').textContent = state.busy === 'save' ? '正在保存…' : '保存项目';
    $('upload-media').disabled = !!state.busy || !state.pendingMedia || !$('media-confirm').checked;
    const voiceAvailable = state.caps?.tts_available === true;
    $('export-voice').disabled = !!state.busy || !voiceAvailable;
    $('export-voice-help').textContent = voiceAvailable ? '可选本机离线配音。配音版不保留原视频音轨，失败时不会降级为无声成片。' : '本机未安装可用配音工具，当前可导出字幕版成片。';
    if (!voiceAvailable && $('export-voice').checked) { $('export-voice').checked = false; notify('本机配音工具暂时不可用，已取消配音选择。若要继续，请新建字幕版导出任务。'); }
    $('start-export').disabled = !!state.busy || !state.project || !state.project.media || !state.caps?.render_available || state.draft?.workflow?.state !== 'reviewed';
    if (state.project) {
      const reasons = [];
      if (!state.project.media) reasons.push('请先导入并保存本机视频。');
      if (state.draft?.workflow?.state !== 'reviewed') reasons.push('请在回合编辑中完成来源与时间复核。');
      if (!state.caps?.render_available) reasons.push('本机成片导出工具尚未就绪，请查看顶部本机功能说明。');
      $('export-blocker').textContent = reasons.join(' '); $('export-blocker').hidden = !reasons.length;
    }
  }
  function renderDirty() {
    if (!state.project) return;
    $('revision-label').textContent = `已保存版本 ${state.project.revision}`;
    $('save-state').textContent = state.busy ? ({ save: '正在保存…', media: '正在导入视频…', restore: '正在恢复版本…', export: '正在创建任务…' }[state.busy] || '正在处理…') : state.dirty ? '有未保存修改' : `已保存 ${dateText(state.project.updated_at)}`;
    $('save-state').style.color = state.dirty ? 'var(--warn)' : '';
    const reviewed = state.draft?.workflow?.state === 'reviewed';
    $('workflow-state').textContent = reviewed ? '已声明完成复核' : '待复核草稿'; $('workflow-state').className = `workflow-label ${reviewed ? 'reviewed' : 'draft'}`;
    $('project-synthetic').hidden = state.draft?.provenance?.kind !== 'synthetic';
    $('draft-explanation').textContent = state.draft?.provenance?.kind === 'synthetic' ? '这是全合成功能演练，非真实 NBA 比赛。请先查看演练画面、时刻与来源，完成检查后再勾选复核；系统不会替你声明已复核。' : '这是待复核的草稿。自动建立的回合只占位，不代表已识别投篮、球员或比赛结果。';
    $('draft-explanation').hidden = reviewed;
    updateControls();
  }
  function markDirty() {
    if (!state.draft || state.busy) return;
    state.dirty = true; state.qualityStale = true; state.qualityRequest++; state.draft.workflow = { ...(state.draft.workflow || {}), state: 'draft' }; $('reviewed-checkbox').checked = false;
    $('quality-summary').textContent = '有新修改，等待重新检查'; renderDirty();
  }
  function setURL() { const url = new URL(location.href); if (state.project) url.searchParams.set('project', state.project.id); else url.searchParams.delete('project'); history.replaceState({}, '', url); }
  function safeProjectMediaURL(project) { return project?.media ? `/api/projects/${idPath(project.id)}/media` : null; }

  async function loadCapabilities() {
    try { state.caps = await api('/api/capabilities'); const okay = !!state.caps.render_available && !!state.caps.ffprobe; $('capability-summary').textContent = okay ? '本机功能就绪' : '部分本机功能待准备'; $('capability-dot').className = `status-dot ${okay ? 'ready' : 'warning'}`; updateControls(); }
    catch (error) { $('capability-summary').textContent = '本机功能暂时无法检查'; $('capability-dot').className = 'status-dot warning'; }
  }
  function renderProjects() {
    const list = $('project-list'); list.replaceChildren(); $('project-count').textContent = state.projects.length;
    const query = state.filter.toLocaleLowerCase();
    const filtered = state.projects.filter(p => p.name.toLocaleLowerCase().includes(query));
    filtered.forEach(project => {
      const button = E('button', 'project-card'); button.type = 'button'; button.setAttribute('aria-current', String(state.project?.id === project.id)); button.title = project.name;
      button.append(E('div', 'project-card-title', project.name));
      const meta = E('div', 'project-card-meta'); meta.append(E('span', '', `${project.possession_count ?? 0} 个回合`), E('span', '', `版本 ${project.revision}`));
      button.append(meta, E('div', 'project-card-footer', `${project.media ? '已保存视频' : '等待视频'} · ${dateText(project.updated_at)}`));
      button.addEventListener('click', () => selectProject(project.id)); list.append(button);
    });
    if (!filtered.length) list.append(E('div', 'list-placeholder', query ? '没有匹配的项目。' : '还没有项目。\n从一段本地视频开始。'));
  }
  async function refreshProjects() {
    $('project-list').setAttribute('aria-busy', 'true');
    try { const result = await api('/api/projects'); state.projects = result.projects || []; renderProjects(); }
    catch (error) { notify(error.message, 'warning', { label: '重试', run: refreshProjects }); if (!state.projects.length) $('project-list').replaceChildren(E('div', 'list-placeholder', '项目列表暂时无法载入。')); }
    finally { $('project-list').setAttribute('aria-busy', 'false'); }
  }
  function renderPossessionSelect() {
    const select = $('possession-select'); select.replaceChildren();
    const sorted = [...(state.draft?.possessions || [])].sort((a, b) => a.start - b.start);
    sorted.forEach((p, i) => { const option = E('option', '', `${String(i + 1).padStart(2, '0')}  ${p.title}`); option.value = p.id; select.append(option); });
    select.value = state.possessionId; $('possession-position').textContent = `${sorted.length} 个回合`;
  }
  function renderEditor() {
    const p = selectedPossession(); if (!p) return;
    renderPossessionSelect();
    const values = { 'edit-title': p.title, 'edit-start': p.start, 'edit-end': p.end, 'edit-shot-time': p.shot_time, 'edit-result-time': p.result_time ?? '', 'edit-clock': p.clock, 'edit-shooter': p.shooter, 'edit-result': p.result, 'edit-points': p.points, 'edit-xfg': p.metrics?.xfg_pct ?? '', 'edit-gravity': p.metrics?.gravity ?? '', 'edit-leverage': p.metrics?.leverage ?? '', 'edit-annotations': JSON.stringify(p.annotations || [], null, 2), 'edit-source-refs': (p.source_refs || []).join('\n') };
    Object.entries(values).forEach(([id, value]) => { $(id).value = value; });
    $('edit-offense').replaceChildren(); [state.draft.game.home, state.draft.game.away].forEach(team => { const option = E('option', '', team); option.value = team; $('edit-offense').append(option); }); $('edit-offense').value = p.offense;
    $('edit-provenance-kind').value = state.draft.provenance.kind; $('edit-provenance-label').value = state.draft.provenance.label; $('edit-source').value = state.draft.provenance.source;
    $('reviewed-checkbox').checked = state.draft.workflow?.state === 'reviewed';
    const cameras = $('camera-segments'); cameras.replaceChildren();
    (p.camera_segments || []).forEach((camera, i) => {
      const row = E('div', 'camera-row'), desc = E('div'); desc.append(E('strong', '', `镜头 ${i + 1}`), E('span', 'timecode', `${clockTime(camera.start)} — ${clockTime(camera.end)}`));
      const label = E('label'), input = E('input'); input.type = 'checkbox'; input.checked = camera.calibrated; input.dataset.cameraIndex = i; input.addEventListener('change', markDirty);
      label.append(input, E('span', '', '已核对追踪坐标位置')); row.append(desc, label); cameras.append(row);
    });
    if (!(p.camera_segments || []).length) cameras.append(E('p', 'field-help', '当前回合没有镜头区间，请检查导入数据。'));
    $('editor-errors').textContent = ''; renderDirty();
  }
  function applyEditor() {
    if (!state.draft) throw new Error('请先打开一个项目。');
    const candidate = clone(state.draft), index = candidate.possessions.findIndex(p => p.id === state.possessionId);
    if (index < 0) throw new Error('当前回合不存在，请重新载入项目。');
    const previous = candidate.possessions[index], duration = candidate.video.duration;
    const start = requiredNumber($('edit-start').value, '起始时间', 0, duration), end = requiredNumber($('edit-end').value, '结束时间', 0, duration);
    const rangeChanged = start !== previous.start || end !== previous.end;
    if (end <= start) throw new Error('回合结束时间必须晚于起始时间。');
    const shot = requiredNumber($('edit-shot-time').value, '出手时间', start, end);
    if (shot >= end) throw new Error('出手时间必须早于回合结束时间。');
    const resultTime = nullableNumber($('edit-result-time').value, '结果确认时间', shot, end);
    let annotations; try { annotations = JSON.parse($('edit-annotations').value || '[]'); } catch { throw new Error('几何注释格式无法读取，请检查高级编辑区。'); }
    if (!Array.isArray(annotations)) throw new Error('几何注释应是一组标注，请使用 JSON 数组。');
    let p = { ...previous, annotations };
    (p.camera_segments || []).forEach((camera, i) => { const input = document.querySelector(`[data-camera-index="${i}"]`); if (input) camera.calibrated = input.checked; });
    p = cropPossession(p, start, end);
    p.title = requiredText($('edit-title').value, '回合标题', 200); p.start = start; p.end = end; p.shot_time = shot; p.result_time = resultTime;
    p.clock = requiredText($('edit-clock').value, '比赛时钟', 200); p.shooter = requiredText($('edit-shooter').value, '投篮球员编号', 80); p.offense = $('edit-offense').value; p.result = $('edit-result').value;
    p.points = requiredNumber($('edit-points').value, '投篮分值', 0, 4);
    p.metrics = { ...(p.metrics || {}), xfg_pct: nullableNumber($('edit-xfg').value, '预期命中概率', 0, 1), gravity: nullableNumber($('edit-gravity').value, 'Gravity'), leverage: nullableNumber($('edit-leverage').value, '回合胜率机会差', 0, 1) };
    p.source_refs = $('edit-source-refs').value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    if (!p.source_refs.length) throw new Error('请至少填写一条本回合的证据来源。');
    candidate.possessions[index] = p; candidate.possessions.sort((a, b) => a.start - b.start);
    for (let i = 1; i < candidate.possessions.length; i++) if (candidate.possessions[i].start < candidate.possessions[i - 1].end) throw new Error(`“${candidate.possessions[i].title}”与前一回合时间重叠，请调整起止时间。`);
    candidate.provenance = { ...candidate.provenance, kind: $('edit-provenance-kind').value, label: requiredText($('edit-provenance-label').value, '来源名称'), source: requiredText($('edit-source').value, '视频与数据来源') };
    candidate.workflow = { ...(candidate.workflow || {}), state: $('reviewed-checkbox').checked ? 'reviewed' : 'draft' };
    if (candidate.workflow.state === 'reviewed') { const problem = reviewProblem(candidate); if (problem) throw new Error(problem); }
    requiredText($('project-name').value, '项目名称', 120);
    state.draft = candidate; $('editor-errors').textContent = '';
    // Reflect clipped geometry and revoked calibration immediately. Otherwise a
    // second save could read stale checked controls and silently re-enable them.
    if (rangeChanged) renderEditor();
    return candidate;
  }
  function readEditorOrReport() { try { return applyEditor(); } catch (error) { $('editor-errors').textContent = error.message; notify(error.message); return null; } }
  function adoptProject(project) {
    state.project = project; state.draft = clone(project.dataset); state.dirty = false; state.qualityStale = true;
    if (!state.draft.possessions.some(p => p.id === state.possessionId)) state.possessionId = state.draft.possessions[0]?.id || null;
    $('project-content').hidden = false; $('empty-project').hidden = true; $('project-name').value = project.name; $('project-short-id').textContent = String(project.id).slice(0, 8).toUpperCase();
    $('open-replay').href = `/?project=${idPath(project.id)}`; $('open-annotate').href = `/annotate.html?project=${idPath(project.id)}`; $('conflict-panel').hidden = true;
    renderEditor(); renderMedia(); renderProjects(); setURL(); updateControls();
  }
  async function selectProject(id, force = false) {
    if (state.busy || state.creating || state.loading) { notify('当前操作还未完成，请稍候。'); return false; }
    if (!force && state.project?.id === id) return true;
    if (state.dirty && !force && !(await saveCurrent(false))) return false;
    const token = ++state.selection; state.loading = true; setBusy('load'); clearTimeout(state.poll);
    try {
      const data = await api(`/api/projects/${idPath(id)}`);
      if (token !== state.selection) return false;
      state.jobs = []; state.history = []; state.quality = null; state.pendingMedia = null; state.pendingMetadata = null;
      adoptProject(data.project); renderJobs(); renderHistory(); setTab(state.tab);
      await Promise.allSettled([refreshQuality(false), refreshJobs(), refreshHistory()]); return true;
    } catch (error) { handleError(error, '项目未能打开：'); return false; }
    finally { if (token === state.selection) { state.loading = false; setBusy(''); } }
  }
  async function saveCurrent(showSuccess = true) {
    if (state.busy || !state.project) return false;
    const dataset = readEditorOrReport(); if (!dataset) return false;
    if (!state.dirty) return true;
    setBusy('save');
    try {
      const data = await api(projectPath('/save'), { name: requiredText($('project-name').value, '项目名称', 120), dataset, expected_revision: state.project.revision });
      adoptProject(data.project); await Promise.allSettled([refreshProjects(), refreshHistory(), refreshQuality(false)]);
      if (showSuccess) notify(`已保存为版本 ${state.project.revision}。`, 'success'); return true;
    } catch (error) { handleError(error, '保存失败：'); return false; }
    finally { setBusy(''); }
  }
  function setTab(tab) {
    if (!['editor', 'media', 'exports', 'history'].includes(tab)) return;
    state.tab = tab;
    document.querySelectorAll('[data-tab]').forEach(button => { const selected = button.dataset.tab === tab; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
    ['editor', 'media', 'exports', 'history'].forEach(name => { $(`panel-${name}`).hidden = name !== tab; });
    if (state.project) { if (tab === 'exports') refreshJobs(); if (tab === 'history') refreshHistory(); if (tab === 'media' && !state.quality) refreshQuality(false); }
  }
  function addPossession() {
    if (!readEditorOrReport()) return;
    const range = nextInterval(state.draft);
    if (!range) { notify('目前的回合已覆盖整段视频。请先缩短一个回合，为新回合留出时间。'); $('edit-end').focus(); return; }
    const id = `p-${crypto.randomUUID().slice(0, 12)}`;
    state.draft.possessions.push({ id, title: '待标注回合', ...range, shot_time: (range.start + range.end) / 2, result_time: null, clock: '待核对', offense: state.draft.game.home, shooter: '待标注', result: 'unknown', points: 0, metrics: { xfg_pct: null, gravity: null, leverage: null }, source_refs: ['人工标注尚未完成'], annotations: [], tracks: [], camera_segments: [{ ...range, calibrated: false }], notes: ['手工新增占位回合，等待来源和事件核对。'] });
    state.draft.possessions.sort((a, b) => a.start - b.start); state.possessionId = id; markDirty(); renderEditor(); $('edit-title').focus();
  }
  function removePossession() {
    if (state.draft.possessions.length <= 1) { notify('项目至少需要保留一个回合。可以修改当前回合的起止时间。'); return; }
    const removed = selectedPossession(); state.draft.possessions = state.draft.possessions.filter(p => p.id !== state.possessionId); state.possessionId = state.draft.possessions[0].id; markDirty(); renderEditor(); notify(`已从草稿移除“${removed.title}”。保存后仍可通过版本历史恢复。`);
  }
  function renderMedia() {
    const media = state.project?.media; $('media-state').textContent = media ? '已保存到本机' : '未绑定';
    $('media-empty').hidden = !!media; $('media-preview').hidden = !media;
    const mediaURL = safeProjectMediaURL(state.project);
    const url = mediaURL ? `${mediaURL}?revision=${state.project.revision}` : null;
    if (url && $('media-preview').getAttribute('src') !== url) { $('media-preview').src = url; $('media-preview').load(); }
    else if (!url) { $('media-preview').removeAttribute('src'); $('media-preview').load(); }
    const source = media || state.draft?.video;
    $('media-description').textContent = source ? `${media?.original_name || '分析所对应的视频'} · ${clockTime(source.duration)} · ${source.width} × ${source.height}${media?.bytes ? ' · ' + byteSize(media.bytes) : ''}${media ? '。服务已保存文件并记录指纹，播放和导出时仍会校验。' : '。请导入与该信息匹配的实际文件。'}` : '';
    renderPendingMedia();
  }
  function renderPendingMedia() {
    $('chosen-media-name').textContent = state.pendingMedia?.name || '尚未选择'; $('media-confirm-panel').hidden = !state.pendingMedia;
    $('media-file-details').textContent = state.pendingMetadata ? `${clockTime(state.pendingMetadata.duration)} · ${state.pendingMetadata.width} × ${state.pendingMetadata.height} · ${byteSize(state.pendingMedia.size)}` : '';
    updateControls();
  }
  async function refreshQuality(fromEditor = true) {
    if (!state.project) return;
    if (fromEditor && !readEditorOrReport()) return;
    const projectId = state.project.id, token = ++state.qualityRequest; $('quality-summary').textContent = '正在检查当前内容…';
    try { const data = await api('/api/quality', { dataset: state.draft }); if (projectId !== state.project?.id || token !== state.qualityRequest) return; state.quality = data.report; state.qualityStale = false; renderQuality(); }
    catch (error) { if (projectId === state.project?.id && token === state.qualityRequest) { $('quality-summary').textContent = '暂时无法检查'; $('quality-checks').replaceChildren(E('p', 'field-error', error.message)); } }
  }
  function renderQuality() {
    const report = state.quality; if (!report) return;
    const names = { blocked: '需要处理后再导出', needs_review: report.export_allowed ? '可处理，仍有证据边界' : '等待复核', ready: '当前检查项已就绪' };
    $('quality-summary').textContent = names[report.status] || '检查已返回'; $('quality-summary').className = `quality-summary ${String(report.status || '').replaceAll('_', '-')}`;
    const metrics = report.metrics || {}; $('quality-metrics').replaceChildren();
    [[metrics.possession_count ?? '—', '回合'], [metrics.covered_seconds !== undefined ? `${Math.round(metrics.covered_seconds * 10) / 10}s` : '—', '已标记时长'], [metrics.possessions_without_tracks ?? '—', '无轨迹回合']].forEach(([value, label]) => { const item = E('div', 'quality-metric'); item.append(E('strong', '', value), E('span', '', label)); $('quality-metrics').append(item); });
    const checks = $('quality-checks'); checks.replaceChildren();
    (report.checks || []).forEach(check => { const status = ['pass', 'warning', 'fail'].includes(check.status) ? check.status : 'warning'; const row = E('div', `quality-check ${status}`), body = E('div'); body.append(E('strong', '', check.label || check.id), E('p', '', check.detail || '未提供细节')); row.append(E('span', 'check-symbol', status === 'pass' ? '✓' : '!'), body); checks.append(row); });
    $('quality-warnings').replaceChildren(); (report.blocking_issues || []).forEach(message => $('quality-warnings').append(E('p', '', message)));
    updateControls();
  }
  function maxMediaBytes() { return state.caps?.max_media_bytes || 536870912; }
  async function readMetadata(file) {
    if (!file) throw new Error('请选择本地视频。');
    if (file.size > maxMediaBytes()) throw new Error(`视频超过当前上限 ${byteSize(maxMediaBytes())}，请先裁成较短片段。`);
    if (!file.size) throw new Error('视频文件为空，请重新选择。');
    return await new Promise((resolve, reject) => {
      const probe = document.createElement('video'), url = URL.createObjectURL(file); let settled = false;
      const cleanup = () => { clearTimeout(timer); probe.removeAttribute('src'); probe.load(); URL.revokeObjectURL(url); };
      const done = (error, result) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(result); };
      const timer = setTimeout(() => done(new Error('浏览器读取视频信息超时，请换用可播放的 MP4 或 WebM 文件。')), 20000);
      probe.preload = 'metadata'; probe.onloadedmetadata = () => { if (!Number.isFinite(probe.duration) || probe.duration <= 0 || !probe.videoWidth || !probe.videoHeight) return done(new Error('视频时长或尺寸无法读取，请检查文件。')); done(null, { url: '/media/unbound.mp4', duration: probe.duration, width: probe.videoWidth, height: probe.videoHeight }); }; probe.onerror = () => done(new Error('浏览器无法读取这个视频，请检查格式或换用 MP4 / WebM。')); probe.src = url;
    });
  }
  function rawUpload(project, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); state.xhr = xhr; xhr.open('POST', `/api/projects/${idPath(project.id)}/media`); xhr.timeout = 300000;
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream'); xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name)); xhr.setRequestHeader('X-Expected-Revision', String(project.revision));
      // The browser supplies Content-Length for this File body. Setting that
      // forbidden header manually would be ignored by browsers.
      xhr.upload.onprogress = event => onProgress(event.lengthComputable ? event.loaded / event.total : Math.min(1, event.loaded / file.size));
      xhr.onload = () => { state.xhr = null; let result; try { result = JSON.parse(xhr.responseText); } catch { reject(new Error('视频导入返回了无法读取的内容。')); return; } if (xhr.status < 200 || xhr.status >= 300) reject(new RequestError(serverMessage(result), xhr.status, result.code)); else resolve(result.project); };
      xhr.onerror = () => { state.xhr = null; reject(new Error('视频导入中断，请确认本机服务后重试。')); };
      xhr.ontimeout = () => { state.xhr = null; reject(new Error('视频导入超时。已保存项目不受影响，可以重试较短片段。')); };
      xhr.onabort = () => { state.xhr = null; const error = new Error('已取消视频导入，项目原视频保持不变。'); error.cancelled = true; reject(error); };
      xhr.send(file);
    });
  }
  function uploadProgress(ratio) { const progress = Math.max(0, Math.min(1, ratio)); $('upload-progress').value = progress; $('upload-message').textContent = progress >= 1 ? '文件已发送，本机正在核验格式与时长…' : `正在导入本机 ${Math.round(progress * 100)}%`; }
  async function uploadSelectedMedia() {
    if (!state.pendingMedia || !$('media-confirm').checked || state.busy) return;
    if (state.dirty && !(await saveCurrent(false))) return;
    const file = state.pendingMedia; setBusy('media'); $('upload-panel').hidden = false; uploadProgress(0);
    try { const project = await rawUpload(state.project, file, uploadProgress); state.pendingMedia = null; state.pendingMetadata = null; $('media-confirm').checked = false; adoptProject(project); await Promise.allSettled([refreshProjects(), refreshHistory(), refreshQuality(false)]); notify('视频已持久保存到本机，并生成新的项目版本。', 'success'); }
    catch (error) { handleError(error, error.cancelled ? '' : '视频未保存：'); }
    finally { $('upload-panel').hidden = true; setBusy(''); }
  }

  function scheduleJobPoll() {
    clearTimeout(state.poll);
    if (!state.project || !state.jobs.some(job => ['queued', 'running'].includes(job.status))) return;
    state.poll = setTimeout(() => refreshJobs(), document.hidden ? 6000 : 1800);
  }
  async function refreshJobs() {
    if (!state.project) return;
    const projectId = state.project.id, token = ++state.jobsRequest;
    try {
      const data = await api(projectPath('/jobs'));
      if (state.project?.id !== projectId || token !== state.jobsRequest) return;
      state.jobs = data.jobs || []; renderJobs(); scheduleJobPoll();
    } catch (error) {
      if (state.project?.id !== projectId || token !== state.jobsRequest) return;
      if (!state.jobs.length) $('job-list').replaceChildren(E('p', 'field-error', error.message));
      else { const message = E('p', 'field-error', '任务状态暂时无法更新，正在等待本机服务。'); renderJobs(); $('job-list').prepend(message); }
      clearTimeout(state.poll); state.poll = setTimeout(() => refreshJobs(), 6000);
    }
  }
  function renderJobs() {
    const list = $('job-list'); list.replaceChildren();
    const active = state.jobs.filter(job => ['queued', 'running'].includes(job.status)).length;
    $('active-job-count').hidden = !active; $('active-job-count').textContent = active;
    if (!state.jobs.length) { list.append(E('div', 'empty-state', '还没有导出任务。完成视频与回合复核后，可在这里生成成片、字幕和分析文件。')); return; }
    const statuses = { queued: '等待处理', running: '正在导出', complete: '已完成', failed: '未完成', cancelled: '已取消' };
    [...state.jobs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).forEach(job => {
      const card = E('article', 'job-card'), top = E('div', 'job-top'), info = E('div');
      info.append(E('strong', '', `版本 ${job.revision} · ${job.audience === 'analyst' ? '分析师视角' : '球迷视角'} · ${job.voice === true ? '有声版' : '字幕版'}`), E('p', 'job-meta', dateText(job.created_at)));
      top.append(info, E('span', `job-status ${['queued', 'running', 'complete', 'failed', 'cancelled'].includes(job.status) ? job.status : ''}`, statuses[job.status] || '状态待确认')); card.append(top);
      if (['queued', 'running'].includes(job.status)) {
        const progress = E('progress', 'job-progress'); progress.max = 1; progress.value = Math.max(0, Math.min(1, Number(job.progress) || 0)); progress.setAttribute('aria-label', '服务返回的任务阶段进度');
        const row = E('div', 'job-top'), cancel = E('button', 'text-button', '取消任务'); cancel.type = 'button'; cancel.disabled = !!state.busy; cancel.addEventListener('click', () => cancelJob(job.id, cancel));
        row.append(E('span', 'subtle', job.progress_label || (job.status === 'queued' ? '在本机队列中等待' : '本机正在处理，进度按阶段更新')), cancel); card.append(progress, row);
      }
      if (job.error) card.append(E('p', 'job-error', String(job.error)));
      if (job.status === 'cancelled') card.append(E('p', 'subtle', '已停止本次任务。项目与先前成片仍保留。'));
      if (job.status === 'complete') {
        const files = E('div', 'job-files');
        (job.files || []).forEach(file => { const name = typeof file === 'string' ? file : file.name; if (!name) return; const link = E('a', 'secondary-button', `${name}${file.bytes || file.size ? ' · ' + byteSize(file.bytes || file.size) : ''}`); link.href = `/api/jobs/${idPath(job.id)}/files/${idPath(name)}`; link.setAttribute('download', name); files.append(link); });
        if (!files.childElementCount) files.append(E('p', 'subtle', '服务未返回可下载文件，请刷新任务记录。')); card.append(files);
      }
      if (job.quality_warnings?.length) { const details = E('details', 'advanced'); details.append(E('summary', '', '本次导出的证据边界')); job.quality_warnings.forEach(message => details.append(E('p', '', message))); card.append(details); }
      list.append(card);
    });
  }
  async function cancelJob(id, button) {
    button.disabled = true;
    try { const result = await api(`/api/jobs/${idPath(id)}/cancel`, {}); state.jobs = state.jobs.map(job => job.id === id ? result.job : job); renderJobs(); scheduleJobPoll(); notify(result.job.status === 'complete' ? '任务已经完成，成片仍可下载。' : '已请求取消任务。', 'success'); }
    catch (error) { handleError(error, '取消未完成：'); button.disabled = false; }
  }
  async function startExport() {
    if (!state.project || state.busy) return;
    if (state.dirty && !(await saveCurrent(false))) return;
    if (state.draft.workflow?.state !== 'reviewed' || !state.project.media || !state.caps?.render_available) { updateControls(); return; }
    let voice;
    try { voice = exportVoice($('export-voice').checked, state.caps); } catch (error) { handleError(error); return; }
    setBusy('export');
    try {
      const quality = await api('/api/quality', { dataset: state.project.dataset }); state.quality = quality.report; state.qualityStale = false; renderQuality();
      if (!quality.report?.export_allowed) { setTab('media'); notify('当前项目还有未完成的质量检查，请查看需要处理的项目。'); return; }
      const result = await api(projectPath('/export'), { expected_revision: state.project.revision, audience: $('export-audience').value, voice });
      state.jobs.unshift(result.job); renderJobs(); scheduleJobPoll(); notify('导出任务已加入本机队列。你可以继续编辑，任务会保留创建时的版本。', 'success');
    } catch (error) { handleError(error, '未能创建导出任务：'); }
    finally { setBusy(''); renderJobs(); }
  }

  async function refreshHistory() {
    if (!state.project) return;
    const projectId = state.project.id, token = ++state.historyRequest;
    try { const data = await api(projectPath('/history')); if (state.project?.id !== projectId || token !== state.historyRequest) return; state.history = data.revisions || []; renderHistory(); }
    catch (error) { if (state.project?.id === projectId && token === state.historyRequest) $('history-list').replaceChildren(E('p', 'field-error', error.message)); }
  }
  function renderHistory() {
    const list = $('history-list'); list.replaceChildren();
    if (!state.history.length) { list.append(E('div', 'empty-state', '正在等待版本记录。')); return; }
    [...state.history].sort((a, b) => b.revision - a.revision).forEach(version => {
      const row = E('article', 'history-row'), number = E('span', 'version-number', String(version.revision).padStart(2, '0')), content = E('div');
      content.append(E('strong', '', version.name || state.project.name), E('p', 'subtle', dateText(version.created_at))); row.append(number, content);
      if (version.revision === state.project.revision) row.append(E('span', 'workflow-label reviewed', '当前保存版本'));
      else { const restore = E('button', 'secondary-button', '恢复此版本'); restore.type = 'button'; restore.disabled = !!state.busy; restore.addEventListener('click', () => restoreVersion(version.revision)); row.append(restore); }
      list.append(row);
    });
  }
  async function restoreVersion(revision) {
    if (state.busy || !state.project) return;
    if (state.dirty && !(await saveCurrent(false))) return;
    setBusy('restore');
    try { const data = await api(projectPath('/restore'), { revision, expected_revision: state.project.revision }); adoptProject(data.project); await Promise.allSettled([refreshProjects(), refreshHistory(), refreshQuality(false), refreshJobs()]); notify(`已将版本 ${revision} 的内容恢复为新版本 ${data.project.revision}。此前版本仍然保留。`, 'success'); }
    catch (error) { handleError(error, '未能恢复：'); }
    finally { setBusy(''); renderHistory(); }
  }
  function downloadFile(content, name, type = 'application/json') {
    const blob = content instanceof Blob ? content : new Blob([content], { type }); const url = URL.createObjectURL(blob), link = E('a');
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function captureBackup() {
    try { applyEditor(); } catch { /* Raw fields below also preserve incomplete input. */ }
    const fields = {}; document.querySelectorAll('#edit-form input, #edit-form select, #edit-form textarea').forEach(input => { const name = input.id || `camera-${input.dataset.cameraIndex}`; fields[name] = input.type === 'checkbox' ? input.checked : input.value; });
    return { format: 'courtlens-editor-backup', project_name: $('project-name').value, project_id: state.project.id, based_on_revision: state.project.revision, saved_at: new Date().toISOString(), dataset: clone(state.draft), editor_fields: fields, note: 'dataset 为最后可读取的数据；editor_fields 额外保留尚未通过校验的输入。请比对后在编辑器中恢复。' };
  }
  function downloadBackup(backup) { if (!backup) return; downloadFile(JSON.stringify(backup, null, 2), `CourtLens-草稿备份-${backup.based_on_revision}.json`); }
  async function reloadAfterConflict() {
    if (state.busy) return;
    state.backup = captureBackup(); $('backup-panel').hidden = false; const id = state.project.id;
    if (await selectProject(id, true)) notify('已载入最新版本。刚才的草稿仍可下载比对，未覆盖已保存的内容。', 'success');
  }

  function setCreateMode(mode) {
    if (state.creating) return;
    state.createMode = ['video', 'csv', 'json'].includes(mode) ? mode : 'video';
    document.querySelectorAll('[data-create-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.createMode === state.createMode)));
    $('create-video-fields').hidden = mode === 'json'; $('create-json-fields').hidden = mode !== 'json'; $('create-csv-fields').hidden = mode !== 'csv'; $('manual-video-note').hidden = mode === 'csv'; $('create-error').textContent = '';
  }
  async function showCreate() { if (state.busy || state.creating) return; if (state.dirty && !(await saveCurrent(false))) return; $('create-error').textContent = ''; $('create-progress').hidden = true; $('create-dialog').showModal(); $('create-name').focus(); }
  function setCreating(value) {
    state.creating = value; $('create-dialog').setAttribute('aria-busy', String(value));
    document.querySelectorAll('#create-form input, #create-form select, #create-form textarea, #create-form button').forEach(control => { control.disabled = value; });
    $('close-create').disabled = value; $('create-submit').textContent = value ? '正在建立项目…' : '创建项目';
    $('new-project').disabled = value || !!state.busy; $('empty-create').disabled = value || !!state.busy; $('empty-demo').disabled = value || !!state.busy; $('create-demo').disabled = value || !!state.busy;
  }
  async function createDemoProject() {
    if (state.busy || state.creating || state.loading) return;
    if (state.dirty && !(await saveCurrent(false))) return;
    setCreating(true); setBusy('demo'); $('create-error').textContent = '';
    $('empty-demo').textContent = '正在建立演练…'; $('create-demo').textContent = '正在建立演练…';
    if ($('create-dialog').open) { $('create-progress').hidden = false; $('create-progress').replaceChildren(E('span', '', '正在读取本机合成演练素材…')); }
    try {
      const dataset = demoDraft(await api('/api/demo'));
      const project = (await api('/api/projects', { name: 'CourtLens合成演练', dataset })).project;
      clearTimeout(state.poll); state.jobs = []; state.history = []; state.quality = null; state.pendingMedia = null; state.pendingMetadata = null;
      adoptProject(project); renderJobs(); renderHistory(); setTab('editor');
      if ($('create-dialog').open) $('create-dialog').close();
      await Promise.allSettled([refreshProjects(), refreshHistory(), refreshQuality(false), refreshJobs()]);
      notify('合成演练项目已建立，仍为待复核草稿。请先打开复盘查看画面与证据，再在回合编辑中勾选“已核对回合时刻与来源”。', 'success');
    } catch (error) {
      if ($('create-dialog').open) { $('create-error').textContent = error.message; $('create-progress').hidden = true; }
      else handleError(error, '演练项目未能建立：');
    } finally { setCreating(false); setBusy(''); $('empty-demo').textContent = '用合成演练体验'; $('create-demo').textContent = '用合成演练体验'; }
  }
  async function smallTextFile(file, kind) {
    if (!file) throw new Error(`请选择${kind}文件。`);
    if (file.size > 8 * 1024 * 1024) throw new Error(`${kind}文件超过 8 MB，请拆分为较小项目。`);
    return (await file.text()).replace(/^\uFEFF/, '');
  }
  async function createProject(event) {
    event.preventDefault(); if (state.creating || state.busy) return;
    $('create-error').textContent = ''; let created = null, file = null, metadata = null, warnings = [];
    try {
      const name = requiredText($('create-name').value, '项目名称', 120); let dataset;
      setCreating(true); const progress = $('create-progress'); progress.hidden = false; progress.replaceChildren(E('span', '', '正在检查项目资料…'));
      if (state.createMode === 'json') {
        let parsed; try { parsed = JSON.parse(await smallTextFile($('create-json-file').files[0], '分析数据集')); } catch (error) { if (error instanceof SyntaxError) throw new Error('这个 JSON 文件无法读取，请检查文件格式。'); throw error; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.possessions) || !parsed.video) throw new Error('请导入完整分析数据集，文件需要包含视频信息与回合。');
        dataset = clone(parsed); dataset.workflow = { ...(dataset.workflow || {}), state: 'draft' };
      } else {
        file = $('create-video-file').files[0]; metadata = await readMetadata(file);
        const home = requiredText($('create-home').value, '主队名称', 200), away = requiredText($('create-away').value, '客队名称', 200);
        if (home === away) throw new Error('主队和客队名称应不同。');
        const game = { title: $('create-game-title').value.trim() || name, home, away, period: requiredText($('create-period').value, '比赛时段', 200), score: requiredText($('create-score').value, '比分记录', 200) }, source = requiredText($('create-source').value, '视频与数据来源');
        const body = { video: metadata, game, source };
        if (state.createMode === 'csv') { body.csv = await smallTextFile($('create-csv-file').files[0], '回合表'); if ($('csv-leverage-confirm').checked) body.leverage_semantics = 'possession_win_probability_opportunity'; const adapted = await api('/api/adapt/csv', body); dataset = adapted.dataset; warnings = adapted.warnings || []; }
        else dataset = (await api('/api/new-dataset', body)).dataset;
      }
      progress.replaceChildren(E('span', '', '正在保存项目资料…'));
      created = (await api('/api/projects', { name, dataset })).project;
      state.jobs = []; state.history = []; state.quality = null; state.pendingMedia = null; state.pendingMetadata = null; adoptProject(created);
      if (file) {
        const label = E('span', '', '正在导入视频到本机…'), bar = E('progress'), cancel = E('button', 'text-button', '取消视频导入'); bar.max = 1; bar.value = 0; cancel.type = 'button'; cancel.addEventListener('click', () => state.xhr?.abort()); progress.replaceChildren(label, bar, cancel);
        created = await rawUpload(created, file, ratio => { bar.value = ratio; label.textContent = ratio >= 1 ? '文件已发送，正在核验视频…' : `正在导入视频到本机 ${Math.round(ratio * 100)}%`; }); adoptProject(created);
      }
      $('create-dialog').close(); $('create-form').reset(); state.createFile = null; state.createMetadata = null; $('create-video-info').textContent = '视频只会导入本机服务，不会上传到云端'; setTab('editor');
      await Promise.allSettled([refreshProjects(), refreshHistory(), refreshQuality(false), refreshJobs()]);
      notify(warnings.length ? `项目已建立，待复核。${warnings.join(' ')}` : '项目已建立。请标记实际回合并核对来源，未知信息可继续保留为空。', 'success');
    } catch (error) {
      if (created) { adoptProject(created); state.pendingMedia = file; state.pendingMetadata = metadata; $('media-confirm').checked = false; renderPendingMedia(); $('create-dialog').close(); setTab('media'); await Promise.allSettled([refreshProjects(), refreshHistory(), refreshQuality(false)]); notify(`项目资料已经保存，视频尚未保存。${error.message} 可在“媒体与质量”中继续导入。`); }
      else { $('create-error').textContent = error.message; $('create-progress').hidden = true; }
    } finally { setCreating(false); setBusy(''); }
  }
  function showInfo(title, content) { $('info-title').textContent = title; $('info-content').replaceChildren(...content); if (!$('info-dialog').open) $('info-dialog').showModal(); }
  async function showCapabilities() {
    await loadCapabilities(); const c = state.caps, content = [];
    if (!c) content.push(E('p', '', '暂时无法检查本机服务。请确认启动窗口仍在运行，然后重试。'));
    else {
      content.push(E('p', '', '当前是本机单用户工作区。项目、视频与导出文件保存在当前设备，页面不会把素材上传到云端。'));
      [['视频核验', c.ffprobe, '导入视频时核对格式、时长与尺寸'], ['成片导出', c.render_available, '生成带分析画面的 MP4、字幕和数据'], ['视频处理', c.ffmpeg, '本机转码与合成']].forEach(([name, available, detail]) => { const row = E('div', 'capability-row'); row.append(E('strong', '', `${available ? '✓' : '!'} ${name} · ${available ? '已就绪' : '尚未就绪'}`), E('p', '', detail)); content.push(row); });
      content.push(E('p', '', `单个视频上限 ${byteSize(c.max_media_bytes || maxMediaBytes())}。`));
      if (!c.ffprobe || !c.render_available || !c.ffmpeg) content.push(E('p', 'creation-note', '请在启动环境准备 FFmpeg / FFprobe 和成片渲染依赖，再重新启动服务。已保存的项目不受影响。'));
      content.push(E('p', 'subtle', '解读使用项目中的已有证据；本页面没有调用外部模型识别视频。'));
    }
    const retry = E('button', 'secondary-button', '重新检查'); retry.type = 'button'; retry.addEventListener('click', showCapabilities); content.push(retry); showInfo('本机功能', content);
  }
  function showCSVGuide() {
    showInfo('回合表填写说明', [E('p', '', '每行填写一个互不重叠的回合，所有时间采用视频秒数。先用模板建立表头，不知道的指标留空。'), E('pre', '', '必填列\nid,title,start,end,shot_time,offense,shooter,points,result\n\n可选列\nresult_time,clock,xfg_pct,gravity,leverage'), E('p', '', 'id 是不重复的回合编号；offense 填写主队或客队名称；result 使用 made（命中）、missed（未中）或 unknown（未知）。points 是这次投篮的分值。'), E('p', '', 'xfg_pct 用 0–1 概率；gravity 保持来源单位；leverage 只有明确为 0–1 回合胜率机会差时才填写，并勾选口径确认。未知值留空，不填 0 代替。'), E('p', '', '导入只建立事件与指标，不会自动推断轨迹或画面坐标。所有回合仍需人工复核。')]);
  }

  $('edit-form').addEventListener('input', event => { if (event.target.id !== 'reviewed-checkbox') markDirty(); });
  $('edit-form').addEventListener('change', event => { if (event.target.id !== 'reviewed-checkbox') markDirty(); });
  $('project-name').addEventListener('input', markDirty);
  $('edit-form').addEventListener('submit', event => { event.preventDefault(); saveCurrent(); });
  $('save-project').addEventListener('click', () => saveCurrent());
  $('reviewed-checkbox').addEventListener('change', () => {
    try { applyEditor(); state.dirty = true; state.qualityStale = true; state.qualityRequest++; renderDirty(); }
    catch (error) { $('reviewed-checkbox').checked = false; state.draft.workflow = { ...(state.draft.workflow || {}), state: 'draft' }; state.dirty = true; $('editor-errors').textContent = error.message; notify(error.message); renderDirty(); }
  });
  $('possession-select').addEventListener('change', () => { const id = $('possession-select').value; if (!readEditorOrReport()) { $('possession-select').value = state.possessionId; return; } state.possessionId = id; renderEditor(); });
  $('add-possession').addEventListener('click', addPossession); $('remove-possession').addEventListener('click', removePossession);
  document.querySelectorAll('[data-tab]').forEach((button, index, buttons) => {
    button.addEventListener('click', () => setTab(button.dataset.tab));
    button.addEventListener('keydown', event => { let next; if (event.key === 'ArrowRight') next = (index + 1) % buttons.length; if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length; if (event.key === 'Home') next = 0; if (event.key === 'End') next = buttons.length - 1; if (next === undefined) return; event.preventDefault(); setTab(buttons[next].dataset.tab); buttons[next].focus(); });
  });
  $('project-search').addEventListener('input', event => { state.filter = event.target.value; renderProjects(); }); $('refresh-projects').addEventListener('click', refreshProjects);
  $('choose-media').addEventListener('click', () => $('media-file').click());
  let mediaSelection = 0;
  $('media-file').addEventListener('change', async () => {
    const token = ++mediaSelection, file = $('media-file').files[0], projectId = state.project?.id; if (!file) return;
    $('chosen-media-name').textContent = '正在读取视频信息…';
    try { const metadata = await readMetadata(file); if (token !== mediaSelection || projectId !== state.project?.id) return; state.pendingMedia = file; state.pendingMetadata = metadata; $('media-confirm').checked = false; renderPendingMedia(); }
    catch (error) { if (token === mediaSelection && projectId === state.project?.id) { state.pendingMedia = null; state.pendingMetadata = null; renderPendingMedia(); handleError(error); } }
  });
  $('media-confirm').addEventListener('change', updateControls); $('upload-media').addEventListener('click', uploadSelectedMedia); $('cancel-upload').addEventListener('click', () => state.xhr?.abort());
  $('refresh-quality').addEventListener('click', () => refreshQuality()); $('start-export').addEventListener('click', startExport); $('refresh-jobs').addEventListener('click', refreshJobs); $('refresh-history').addEventListener('click', refreshHistory);
  $('download-conflict').addEventListener('click', () => downloadBackup(captureBackup())); $('reload-conflict').addEventListener('click', reloadAfterConflict); $('download-backup').addEventListener('click', () => downloadBackup(state.backup));
  ['open-replay', 'open-annotate'].forEach(id => $(id).addEventListener('click', async event => { event.preventDefault(); if (state.busy || state.creating) { notify('当前操作尚未完成，请稍候。'); return; } if (state.dirty && !(await saveCurrent(false))) return; location.assign($(id).href); }));
  $('new-project').addEventListener('click', showCreate); $('empty-create').addEventListener('click', showCreate); $('close-create').addEventListener('click', () => { if (!state.creating) $('create-dialog').close(); });
  $('empty-demo').addEventListener('click', createDemoProject); $('create-demo').addEventListener('click', createDemoProject);
  $('create-dialog').addEventListener('cancel', event => { if (state.creating) event.preventDefault(); });
  document.querySelectorAll('[data-create-mode]').forEach(button => button.addEventListener('click', () => setCreateMode(button.dataset.createMode)));
  let createSelection = 0;
  $('create-video-file').addEventListener('change', async () => {
    const token = ++createSelection, file = $('create-video-file').files[0]; if (!file) return; $('create-video-info').textContent = '正在读取视频…';
    try { const metadata = await readMetadata(file); if (token !== createSelection) return; state.createFile = file; state.createMetadata = metadata; $('create-video-info').textContent = `${clockTime(metadata.duration)} · ${metadata.width} × ${metadata.height} · ${byteSize(file.size)}`; if (!$('create-name').value.trim()) $('create-name').value = file.name.replace(/\.[^.]+$/, '').slice(0, 120); }
    catch (error) { if (token === createSelection) { $('create-video-info').textContent = error.message; state.createMetadata = null; } }
  });
  $('create-form').addEventListener('submit', createProject); $('csv-columns-button').addEventListener('click', showCSVGuide);
  $('csv-template').addEventListener('click', event => { event.preventDefault(); downloadFile('\uFEFFid,title,start,end,shot_time,offense,shooter,points,result,result_time,clock,xfg_pct,gravity,leverage\r\n', 'CourtLens-回合表模板.csv', 'text/csv;charset=utf-8'); });
  $('capabilities-button').addEventListener('click', showCapabilities); $('close-info').addEventListener('click', () => $('info-dialog').close()); $('info-done').addEventListener('click', () => $('info-dialog').close());
  $('close-notice').addEventListener('click', () => { $('notice').hidden = true; }); $('notice-action').addEventListener('click', () => state.noticeAction?.());
  window.addEventListener('beforeunload', event => { if (state.dirty || state.xhr || state.creating) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.project && state.jobs.some(job => ['queued', 'running'].includes(job.status))) refreshJobs(); });
  async function initialize() {
    await Promise.allSettled([loadCapabilities(), refreshProjects()]);
    const requested = new URL(location.href).searchParams.get('project');
    if (requested) await selectProject(requested); else if (state.projects.length) await selectProject(state.projects[0].id);
  }
  initialize();
})();
