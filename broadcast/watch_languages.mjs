import {languages, languageLabel, commentarySelection} from './commentary_ui.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`:JSON.stringify(value);
export const watchReleaseLanguage=release=>release?.summary?.voice?.language||commentarySelection(release?.manifest?.story).language;
export function verifiedWatchRelease(release) {
  const {summary,manifest}=release||{},range=manifest?.story?.sourceRange;
  const language=watchReleaseLanguage(release);
  return !!(summary?.id&&summary.videoUrl&&summary.voice?.mode&&summary.voice.mode!=='silent'&&summary.voice.audioSha256&&
    manifest?.schema==='courtlens-broadcast-release/1'&&/^[0-9a-f]{64}$/i.test(manifest.source?.mediaSha256||'')&&
    finite(range?.start)&&finite(range?.end)&&range.end>range.start&&
    manifest.validation?.durationVerified===true&&manifest.validation.sourceHashVerified===true&&
    manifest.review?.result==='approved'&&manifest.review.contentHash===manifest.validation.contentHash&&
    manifest.outputs?.some(o=>o.name==='film.mp4'&&o.sha256===summary.videoSha256)&&
    languages.some(l=>l.id===language)&&manifest.voice?.mode===summary.voice.mode&&manifest.voice.audioSha256===summary.voice.audioSha256&&manifest.voice.language===language&&commentarySelection(manifest.story).language===language&&
    Array.isArray(manifest.evidence?.observations)&&manifest.evidence.observations.length);
}
export function matchingWatchRelease(reference,candidate) {
  if(!verifiedWatchRelease(reference)||!verifiedWatchRelease(candidate))return false;
  return reference.manifest.source.mediaSha256===candidate.manifest.source.mediaSha256&&
    canonical(reference.manifest.story.sourceRange)===canonical(candidate.manifest.story.sourceRange)&&
    canonical(reference.manifest.evidence)===canonical(candidate.manifest.evidence);
}
export function selectWatchLanguages(reference,project,candidates=[]) {
  if(!verifiedWatchRelease(reference)||!project?.releases?.some(r=>r.id===reference.summary.id))return [];
  const published=new Set(project.releases.map(r=>r.id));
  const selected=new Map([[watchReleaseLanguage(reference),reference]]);
  for(const candidate of candidates) {
    if(!published.has(candidate?.summary?.id)||!matchingWatchRelease(reference,candidate))continue;
    const language=watchReleaseLanguage(candidate),previous=selected.get(language);
    if(language===watchReleaseLanguage(reference))continue;
    if(!previous||(candidate.summary.createdAt||'')>(previous.summary.createdAt||''))selected.set(language,candidate);
  }
  return languages.flatMap(l=>selected.has(l.id)?[selected.get(l.id)]:[]);
}
export async function loadWatchLanguages({reference,project,cloud=false,listProjects,readProject,readRelease}) {
  // Public cloud viewers must never enumerate private project metadata.
  if(cloud||!verifiedWatchRelease(reference))return [];
  try {
    let owner=project?.releases?.some(r=>r.id===reference.summary.id)?project:null;
    if(!owner) {
      const listing=await listProjects();
      const rows=(listing.projects||[]).slice().sort((a,b)=>Number(b.latestReleaseId===reference.summary.id)-Number(a.latestReleaseId===reference.summary.id));
      for(const row of rows) {
        let candidate;try{candidate=await readProject(row.id);}catch{continue;}
        if(candidate.releases?.some(r=>r.id===reference.summary.id)){owner=candidate;break;}
      }
    }
    if(!owner)return [];
    const results=await Promise.allSettled(owner.releases.filter(r=>r.id!==reference.summary.id&&r.voice?.mode!=='silent').map(r=>readRelease(r.id)));
    return selectWatchLanguages(reference,owner,results.filter(r=>r.status==='fulfilled').map(r=>r.value));
  } catch {return [];}
}
export function renderWatchLanguages(releases,currentId,{disabled=false}={}) {
  if(releases.length<2)return '';
  return `<label class="field" style="margin:0;min-width:140px"><span>配音语言</span><select data-watch-language aria-label="切换已生成配音语言" ${disabled?'disabled':''}>${releases.map(r=>`<option value="${esc(r.summary.id)}" ${r.summary.id===currentId?'selected':''}>${esc(languageLabel(watchReleaseLanguage(r)))}</option>`).join('')}</select></label>`;
}
export function sourceTimeAfterLanguageSwitch(sourceTime,manifest) {
  const range=manifest?.story?.sourceRange;
  if(!finite(sourceTime)||!finite(range?.start)||!finite(range?.end))return range?.start||0;
  return Math.max(range.start,Math.min(sourceTime,range.end));
}
export function spokenPlaybackState(manifest,sourceTime) {
  if(!Object.hasOwn(manifest?.story||{},'commentaryCues'))return null;
  const range=manifest.story.sourceRange;
  const empty=phase=>({phase,cue:null,index:-1,text:null});
  if(!finite(sourceTime)||!finite(range?.start)||!finite(range?.end))return empty('unavailable');
  if(sourceTime<range.start)return empty('before');if(sourceTime>=range.end)return empty('after');
  const rows=manifest.story.commentaryCues||[],index=rows.findIndex(c=>sourceTime>=c.sourceStart&&sourceTime<c.sourceEnd);
  if(index<0)return empty('between');
  const cue=rows[index],compiled=manifest.compiledCommentaryCues?.find(c=>c.beatId===cue.id);
  return {phase:'speaking',cue,index,text:compiled?.compiledText||cue.text};
}
