import {languages, languageLabel, commentarySelection, voiceProvidersForLanguage} from './commentary_ui.mjs';
import {visualChoices, writingProviders, maxAnalysisWindow} from './capability_ui.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp = value => `${Math.floor(Number(value || 0) / 60).toString().padStart(2,'0')}:${(Number(value || 0) % 60).toFixed(1).padStart(4,'0')}`;
export const quickReviewChecks = ['identity','timing','metrics','wording','geometry'];
export function commentaryCueRows(story) {
  return story && Object.hasOwn(story,'commentaryCues') ? story.commentaryCues : story?.beats||[];
}
export const cueDraftKey=(project,cueId)=>`${project.id}:${project.revision}:${cueId}`;
export function hasUnsavedCommentary(project,drafts={}) {
  return !!project?.story&&commentaryCueRows(project.story).some(cue=>{
    const draft=drafts[cueDraftKey(project,cue.id)];
    return draft&&((draft.text??'').trim()!==cue.text||String(draft.sourceStart??'').trim()===''||String(draft.sourceEnd??'').trim()===''||Number(draft.sourceStart)!==cue.sourceStart||Number(draft.sourceEnd)!==cue.sourceEnd);
  });
}
export function remainingCommentaryDrafts(project,saved,drafts={},savedCueId) {
  const remaining={...drafts};
  for(const cue of commentaryCueRows(project.story)) {
    const oldKey=cueDraftKey(project,cue.id),draft=remaining[oldKey];
    if(!draft)continue;
    if(cue.id===savedCueId)delete remaining[oldKey];
    else if(saved.id===project.id&&commentaryCueRows(saved.story).some(row=>row.id===cue.id)) {
      delete remaining[oldKey];remaining[cueDraftKey(saved,cue.id)]=draft;
    }
  }
  return remaining;
}
export function updateCommentaryCue(project,cueId,values,expected) {
  if(expected?.projectId!==project?.id||expected?.revision!==project?.revision)throw new Error('解说版本已变化，请重新打开当前句子再保存。');
  const story=project.story,rows=commentaryCueRows(story),cue=rows.find(c=>c.id===cueId);
  if(!cue)throw new Error('这句口播已不存在，请重新载入。');
  const text=String(values.text||'').trim(),start=Number(values.sourceStart),end=Number(values.sourceEnd);
  if(!text||text.length>(Object.hasOwn(story,'commentaryCues')?280:240))throw new Error('请填写有效的口播文字，并缩短过长的句子。');
  if(String(values.sourceStart??'').trim()===''||String(values.sourceEnd??'').trim()===''||!Number.isFinite(start)||!Number.isFinite(end)||start<story.sourceRange.start||end>story.sourceRange.end||end<=start)throw new Error('口播开始与结束必须按顺序落在整片范围内。');
  const lane=Object.hasOwn(story,'commentaryCues')?'commentaryCues':'beats';
  return {...story,[lane]:rows.map(row=>row.id===cueId?{...row,text,sourceStart:start,sourceEnd:end}:row)};
}
export function renderCommentaryCueEditor(project,cue,{draft,busy=false}={}) {
  const values=draft||cue;
  return `<article class="record"><strong>${stamp(cue.sourceStart)}—${stamp(cue.sourceEnd)}</strong><p>${esc(cue.text)}</p><button type="button" data-action="seek-frame" data-time="${Number(cue.sourceStart)||0}">回看这一句</button><details class="manual-tools" ${draft?'open':''}><summary>修正解说</summary><form data-form="commentary-cue" data-cue-id="${esc(cue.id)}" data-project-id="${esc(project.id)}" data-revision="${project.revision}"><label class="field"><span>实际配音文字</span><textarea name="cueText" required maxlength="${Object.hasOwn(project.story,'commentaryCues')?280:240}">${esc(values.text)}</textarea></label><div class="field-row"><label class="field"><span>开始 · 源片秒数</span><input name="cueStart" type="number" min="${project.story.sourceRange.start}" max="${project.story.sourceRange.end}" step="0.01" required value="${esc(values.sourceStart)}"></label><label class="field"><span>结束 · 源片秒数</span><input name="cueEnd" type="number" min="${project.story.sourceRange.start}" max="${project.story.sourceRange.end}" step="0.01" required value="${esc(values.sourceEnd)}"></label></div><p class="help-text">说不完时可缩短句子或调整时窗。人物、事实与证据引用保持原依据；时间仍须通过检查。保存后须重新审核。</p><button type="submit" class="button secondary full" ${busy?'disabled':''}>保存口播修改</button></form></details></article>`;
}
export function renderCommentaryCueSection(project,{drafts={},busy=false}={}) {
  return `<section class="panel-section"><h3>逐句口播</h3><p class="help-text">这里的文字会用于实际配音，可逐句缩短并调整时间。</p><div class="beat-list">${commentaryCueRows(project.story).map(c=>renderCommentaryCueEditor(project,c,{draft:drafts[cueDraftKey(project,c.id)],busy})).join('')||'<p class="empty-copy">当前故事没有口播句子，请根据已确认观察重新拟稿。</p>'}</div></section>`;
}
export function quickDefaults(capabilities, language='zh-CN') {
  const choices=visualChoices(capabilities);
  return {visual:choices.find(x=>x.strategy==='video-first')||choices[0]||null,
    writer:writingProviders(capabilities)[0]||null,
    voice:voiceProvidersForLanguage(capabilities,language).find(x=>x.verified)||['stepfun','minimax','polly','local-tts'].map(id=>voiceProvidersForLanguage(capabilities,language).find(x=>x.id===id)).find(Boolean)||null};
}
export function currentQuickEvidence(project, report) {
  if (!project?.media || report?.projectId!==project.id || report.projectRevision!==project.revision || report.mediaSha256!==project.media.sha256)
    return {ok:false,message:'正在核对当前视频的已保存证据。',pending:true};
  const active=(project.observations||[]).filter(o=>o.review?.status!=='rejected');
  const frames=new Map((report.frames||[]).map(f=>[f.id,f]));
  const runs=new Map((report.vision?.providerRuns||[]).map(r=>[r.runId,r]));
  for(const o of active) {
    if(!o.frameIds?.length||o.frameIds.some(id=>!frames.has(id)||frames.get(id).mediaSha256!==project.media.sha256))
      return {ok:false,message:'动作缺少当前视频的真实画面证据。请在详细工作台补取画面。'};
    if(o.source?.kind==='model'||o.source?.kind==='cv') {
      const r=runs.get(o.source.runId);
      if(!r?.mediaMatches||!r.executionAudited)return {ok:false,message:'自动观察缺少当前视频的可信执行记录。请核对分析任务。'};
    }
  }
  const issue=(report.vision?.reviewQueue||[]).find(x=>x.severity==='blocking');
  if(issue)return {ok:false,message:issue.message||issue.detail||'画面证据存在冲突，请在详细工作台修正。'};
  return {ok:true};
}
export function quickPlan({project, capabilities, language='zh-CN', job, report, selectedFile, busy=false,cueDrafts={}}={}) {
  const defaults=quickDefaults(capabilities,language);
  const base={...defaults,language};
  const blocked=message=>({...base,stage:'blocked',message,label:'生成带配音影片',disabled:true});
  if(busy||job&&project&&job.projectId===project.id&&['queued','running'].includes(job.status))return {...base,stage:'running',message:busy?'正在保存视频…':({queued:'等待处理',probe:'检查视频',frames:'提取画面',infer:'理解画面',draft:'编写解说',voice:'生成配音',render:'生成影片',verify:'验证成片'}[job.stage]||'正在处理'),label:'正在生成…',disabled:true};
  if(!selectedFile&&hasUnsavedCommentary(project,cueDrafts))return blocked('口播有未保存的修改，请先保存当前句子。');
  if(job&&project&&job.projectId===project.id&&['failed','blocked','cancelled'].includes(job.status))return {...base,stage:'failed',message:job.error?.message||'任务已取消，未生成成片。',label:'重新尝试',disabled:false};
  if(selectedFile||!project?.media)return {...base,stage:'upload',message:'选择一段比赛视频，生成有字幕和配音的 MP4。',label:'生成带配音影片',disabled:!selectedFile};
  if(!defaults.voice)return blocked(`${languageLabel(language)}配音尚不可用。请切换语言，或在详细工作台配置语音。`);
  if(capabilities?.renderer?.available!==true)return blocked('成片工具暂不可用。请检查本地制作服务。');
  const active=(project.observations||[]).filter(o=>o.review?.status!=='rejected');
  if(!active.length) {
    if(!defaults.visual)return blocked('视频已保存，自动画面理解尚未配置。可打开详细工作台手工制作。');
    if(project.media.duration>maxAnalysisWindow(defaults.visual.provider,defaults.visual.strategy))return blocked(`此方式最多分析 ${maxAnalysisWindow(defaults.visual.provider,defaults.visual.strategy)} 秒。请换短片，或在详细工作台选取分析范围。`);
    return {...base,stage:'analyze',label:'生成带配音影片',disabled:false,message:'自动识别关键动作，随后请核对画面。'};
  }
  const evidence=currentQuickEvidence(project,report);
  if(!evidence.ok)return {...blocked(evidence.message),stage:evidence.pending?'checking':'blocked'};
  if(active.some(o=>o.review?.status!=='accepted'))return {...base,stage:'observations',label:'确认动作后继续',disabled:true,message:'请回看画面，逐条确认或排除以下动作。'};
  if(!project.story||commentarySelection(project.story).language!==language) {
    return {...base,stage:'draft',label:'生成解说初稿',disabled:false,message:'已确认画面，将按所选语言编排解说。'};
  }
  if(report.checks?.find(x=>x.id==='story')?.status!=='pass')return blocked(report.checks?.find(x=>x.id==='story')?.detail||'当前解说未通过检查。请在详细工作台修正。');
  if(report.checks?.find(x=>x.id==='review')?.status!=='pass')return {...base,stage:'story-review',label:'确认并生成带配音影片',disabled:false,message:'请核对解说、人物和时刻；确认后生成配音影片。'};
  const release=(project.releases||[]).filter(r=>r.projectRevision===project.revision&&r.voice?.mode!=='silent'&&(r.voice?.language||commentarySelection(r.story||r).language)===language).at(-1);
  return {...base,stage:release?'released':'render',release,label:release?'观看成片':'生成带配音影片',disabled:false,message:release?'配音影片已生成并保存。':'当前版本已审核，可以生成配音影片。'};
}

export function renderQuickScreen({project,capabilities,language='zh-CN',job,report,selectedFile,previewUrl,busy,reviewActor='',stageMarkup='',cueDrafts={}}={}) {
  const plan=quickPlan({project,capabilities,language,job,report,selectedFile,busy,cueDrafts});
  const active=(project?.observations||[]).filter(o=>o.review?.status!=='rejected');
  const options=languages.map(l=>`<option value="${l.id}" ${language===l.id?'selected':''}>${esc(l.label)} · 原创解说</option>`).join('');
  const review=plan.stage==='observations'?`<section class="panel-section"><h3>核对关键动作</h3><label class="field"><span>核对者</span><input id="quick-reviewer" maxlength="80" value="${esc(reviewActor)}" placeholder="你的姓名或制作署名"></label><div class="observation-list">${active.map(o=>`<article class="record"><div class="record-top"><strong>${stamp(o.start)}—${stamp(o.end)}</strong><span class="tag ${o.review?.status==='accepted'?'good':'orange'}">${o.review?.status==='accepted'?'已确认':'待确认'}</span></div><p>${esc(o.description)}</p><div class="record-actions"><button type="button" data-action="seek-observation" data-id="${esc(o.id)}">回看画面</button>${o.review?.status!=='accepted'?`<button type="button" data-action="accept-observation" data-id="${esc(o.id)}">确认属实</button><button type="button" data-action="reject-observation" data-id="${esc(o.id)}">排除</button>`:''}<button type="button" data-action="quick-edit-observation" data-id="${esc(o.id)}">修正</button></div></article>`).join('')}</div></section>`:'';
  const story=!selectedFile&&project?.story&&commentarySelection(project.story).language===language?renderCommentaryCueSection(project,{drafts:cueDrafts,busy:busy||plan.stage==='running'}):'';
  const finalReview=plan.stage==='story-review'?`<form data-form="quick-review"><label class="field"><span>核对者</span><input name="actor" required maxlength="80" value="${esc(reviewActor)}" placeholder="你的姓名或制作署名"></label><label class="check"><input type="checkbox" name="confirmed" required><span>我已回看并核对人物、动作时刻、数字来源、解说措辞与画面标注。</span></label><button class="button full" type="submit">${plan.label}</button></form>`:`<button class="button full" data-action="quick-generate" type="button" ${plan.disabled?'disabled':''}>${plan.label}</button>`;
  const fallback=previewUrl?`<div class="stage"><video id="broadcast-video" controls playsinline preload="metadata" src="${esc(previewUrl)}" aria-label="待上传视频预览"></video></div>`:`<div class="stage empty"><div class="stage-placeholder"><h2>比赛画面，配上解说</h2><p>普通话 · 英语 · 粤语</p></div></div>`;
  const jobDetails=job&&project&&job.projectId===project.id&&['queued','running','failed','blocked','cancelled'].includes(job.status)?`<div class="job-status" role="status"><h3>${esc(plan.message)}</h3>${job.progress?.total?`<p>已完成 ${Number(job.progress.completed)||0} / ${Number(job.progress.total)} ${esc(job.progress.unit)}</p>`:''}${['queued','running'].includes(job.status)?`<div class="button-row"><button class="button quiet small" data-action="refresh-job" type="button">查看进度</button><button class="button danger small" data-action="cancel-job" type="button">取消</button></div>`:''}</div>`:'';
  return `<div class="studio-header"><div class="project-meta"><div><h1>${esc(project?.title||'自动生成解说影片')}</h1><p>选视频，选语言，生成配音影片。</p></div><button class="button quiet small" data-action="toggle-workstation" type="button">详细工作台</button></div></div><div class="studio-layout"><div class="stage-column">${stageMarkup||fallback}${story}</div><aside class="work-panel" aria-label="自动生成"><div class="panel-head"><h2>自动模式</h2></div><div class="panel-body"><label class="field"><span>${project?.media?'更换视频':'比赛视频'}</span><input id="quick-video" type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" ${busy?'disabled':''}><small>${selectedFile?esc(selectedFile.name):'支持 MP4、MOV、WebM；最多 256 MB。'}</small></label><label class="field"><span>解说语言</span><select id="quick-language" ${busy||plan.stage==='running'?'disabled':''}>${options}</select></label><p class="help-text">${plan.voice?`${esc(languageLabel(language))}原创声音 · 成片仍需试听`:'当前语言暂无可用配音'}</p><p class="inline-note ${['blocked','failed'].includes(plan.stage)?'error':''}" role="status">${esc(plan.message)}</p>${finalReview}${jobDetails}${plan.release?`<a class="button quiet full" href="${esc(plan.release.videoUrl)}" download>下载 MP4</a>`:''}${review}<p class="help-text">模型候选须核对；缺失的官方数字会保持缺失。</p></div></aside></div>`;
}
