const video = document.querySelector('#preview-video');
const timeNode = document.querySelector('#preview-time');
const statusNode = document.querySelector('#preview-status');
const titleNode = document.querySelector('#preview-title');
const copyNode = document.querySelector('#preview-copy');
const evidenceNode = document.querySelector('#preview-evidence');
const jumps = document.querySelector('#preview-jumps');

const stamp = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.${Math.floor(seconds % 1 * 10)}`;
let timeline = [];
let lastCue = null, loop=false, comparison=false;
const loopButton=document.querySelector('#loop-cue'),compareButton=document.querySelector('#compare-video');
function renderCues(){const list=document.querySelector('#cue-list');list.replaceChildren();timeline.forEach((cue,index)=>{const button=document.createElement('button');button.type='button';button.dataset.index=index;button.setAttribute('aria-current','false');const time=document.createElement('small');time.textContent=`${stamp(cue.start)}—${stamp(cue.end)}`;button.append(time,document.createTextNode(cue.text));list.append(button);});}

function sync() {
  let now = video.currentTime || 0;
  if(loop&&lastCue&&now>=lastCue.end-.04&&!video.paused){video.currentTime=lastCue.start;now=lastCue.start;}
  timeNode.textContent = stamp(now);
  const cue = timeline.find((entry) => now >= entry.start && now < entry.end);
  if (cue === lastCue) return;
  lastCue = cue;
  document.querySelectorAll('#cue-list button').forEach((b,i)=>b.setAttribute('aria-current',String(timeline[i]===cue)));
  if (!cue) {
    document.querySelector('#cue-window').textContent='—';
    document.querySelector('#detail-title').textContent='当前画面';
    document.querySelector('#detail-text').textContent='这一时刻没有解说。';
    document.querySelector('#detail-evidence').textContent='演练数据独立于正式 NBA 指标';
    statusNode.textContent = now >= video.duration && video.duration ? '播放结束' : '演示';
    titleNode.textContent = now >= video.duration && video.duration ? '播放结束' : '当前回合';
    copyNode.textContent = '播放视频查看解说。';
    evidenceNode.textContent = '演练数据独立于正式 NBA 指标';
    return;
  }
  document.querySelector('#cue-window').textContent=`${stamp(cue.start)}—${stamp(cue.end)}`;
  document.querySelector('#detail-title').textContent=cue.metric?'数据说明':'事件解读';
  document.querySelector('#detail-text').textContent=cue.text;
  document.querySelector('#detail-evidence').textContent=cue.evidence.join(' · ')+' · 合成数据';
  statusNode.textContent = '演示';
  titleNode.textContent = `回合 ${cue.possession.slice(1)}`;
  copyNode.textContent = cue.text;
  evidenceNode.textContent = `依据：${cue.evidence.join(' · ')} · 合成数据`;
}

async function loadTimeline() {
  try {
    const response = await fetch('./preview-data.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const packet = await response.json();
    if (packet.schema !== 'courtlens-public-preview/1' || packet.provenance !== 'synthetic') throw new Error('Only synthetic rehearsal data is accepted');
    timeline = packet.cues;
    if (timeline.length !== 12) throw new Error('Unexpected rehearsal cue count');
    renderCues();sync();
  } catch {
    statusNode.textContent = '数据未加载';
    titleNode.textContent = '视频仍可播放';
    copyNode.textContent = '同步数据暂时未加载，请稍后刷新。';
    evidenceNode.textContent = '合成数据暂不可用';
  }
}

video.addEventListener('timeupdate', sync);
video.addEventListener('seeked', sync);
video.addEventListener('ended', sync);
jumps.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-seek]');
  if (!button) return;
  loop=false;loopButton.setAttribute('aria-pressed','false');
  video.currentTime = Number(button.dataset.seek);
  // Chapter seeks keep the current pause/play state.
  sync();
});
document.querySelector('#cue-list').addEventListener('click',event=>{const button=event.target.closest('button[data-index]');if(!button)return;loop=false;loopButton.setAttribute('aria-pressed','false');video.currentTime=timeline[Number(button.dataset.index)].start;sync();});
loopButton.addEventListener('click',()=>{if(!lastCue)return;loop=!loop;loopButton.setAttribute('aria-pressed',String(loop));if(loop){video.currentTime=lastCue.start;video.play().catch(()=>{});}});
compareButton.addEventListener('click',()=>{
  if(compareButton.disabled)return;
  const time=video.currentTime,playing=!video.paused;
  comparison=!comparison;compareButton.disabled=true;
  compareButton.setAttribute('aria-pressed',String(comparison));
  compareButton.textContent=comparison?'返回分析版':'查看原片';
  const finish=()=>{compareButton.disabled=false;video.removeEventListener('error',failed);};
  const loaded=()=>{finish();video.currentTime=Math.min(time,video.duration||time);if(playing)video.play().catch(()=>{});};
  const failed=()=>{finish();video.removeEventListener('loadedmetadata',loaded);statusNode.textContent='视频未加载';};
  video.addEventListener('loadedmetadata',loaded,{once:true});video.addEventListener('error',failed,{once:true});
  video.src=comparison?'../media/demo.mp4':'../media/broadcast-rehearsal.mp4';
});
loadTimeline();
