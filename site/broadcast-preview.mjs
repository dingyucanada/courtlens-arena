const video = document.querySelector('#preview-video');
const timeNode = document.querySelector('#preview-time');
const statusNode = document.querySelector('#preview-status');
const titleNode = document.querySelector('#preview-title');
const copyNode = document.querySelector('#preview-copy');
const evidenceNode = document.querySelector('#preview-evidence');
const jumps = document.querySelector('#preview-jumps');

const stamp = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.${Math.floor(seconds % 1 * 10)}`;
let timeline = [];
let lastCue = null;

function sync() {
  const now = video.currentTime || 0;
  timeNode.textContent = stamp(now);
  const cue = timeline.find((entry) => now >= entry.start && now < entry.end);
  if (cue === lastCue) return;
  lastCue = cue;
  if (!cue) {
    statusNode.textContent = now >= video.duration && video.duration ? 'END / 演练结束' : 'READY / 合成演练';
    titleNode.textContent = now >= video.duration && video.duration ? '一段进攻，三次选择' : '等待关键回合';
    copyNode.textContent = '播放视频，随画面查看当前解说和数据依据。';
    evidenceNode.textContent = '演练数据独立于正式 NBA 指标';
    return;
  }
  statusNode.textContent = `ON AIR / ${cue.possession.toUpperCase()}`;
  titleNode.textContent = cue.metric ? '数字解释这一刻' : '这一刻发生了什么';
  copyNode.textContent = cue.text;
  evidenceNode.textContent = `依据：${cue.evidence.join(' · ')} · 合成数据`;
}

async function loadTimeline() {
  try {
    const response = await fetch('../data/analysis.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const packet = await response.json();
    if (packet.dataset?.provenance?.kind !== 'synthetic') throw new Error('Only synthetic rehearsal data is accepted');
    timeline = packet.analyses.fan.possessions.flatMap((possession) => possession.cues.map((cue) => ({
      start: cue.start, end: cue.end, text: cue.text, possession: possession.id,
      evidence: cue.evidence_ids || [], metric: (cue.evidence_ids || []).some((id) => id.includes(':metric:')),
    }))).sort((a, b) => a.start - b.start);
    if (timeline.length !== 12) throw new Error('Unexpected rehearsal cue count');
    sync();
  } catch {
    statusNode.textContent = 'OFFLINE / 数据不可用';
    titleNode.textContent = '视频仍可播放';
    copyNode.textContent = '同步数据暂时未加载，请稍后刷新。';
    evidenceNode.textContent = '没有数据时不显示推断或数字';
  }
}

video.addEventListener('timeupdate', sync);
video.addEventListener('seeked', sync);
video.addEventListener('ended', sync);
jumps.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-seek]');
  if (!button) return;
  video.currentTime = Number(button.dataset.seek);
  video.play().catch(() => {});
  sync();
});
loadTimeline();
