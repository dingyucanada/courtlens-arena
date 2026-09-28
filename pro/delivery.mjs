/** Local delivery names and links never become filesystem paths or remote URLs. */
export function filmFilename(name,audio=false){
  const safe=String(name||'CourtLens').replace(/[\u0000-\u001f\u007f/\\:]/g,'-').trim().slice(0,90)||'CourtLens';
  return `${safe}-战术故事.${audio?'mp4':'webm'}`;
}
export function localArtifactLink(value){
  if(!value||typeof value!=='object'||!/^\/api\/arena\/artifacts\/[a-f0-9]{32}\/video$/.test(value.url)||!Number.isSafeInteger(value.bytes)||value.bytes<=0||!/^[a-f0-9]{64}$/.test(value.sha256))throw new Error('本机成片返回了无效的校验信息。');
  return value.url;
}
