// Capability labels are presentation only. The server remains the source of truth
// for configured, available and verified provider states.
const names = {
  'bedrock-video': 'Amazon Bedrock',
  'bedrock-image': 'Amazon Bedrock',
  'bedrock-story': 'Amazon Bedrock',
  'stepfun-vision': '阶跃星辰',
  'stepfun-story': '阶跃星辰',
  'agentcore-proposal': '云端视觉辅助',
  'agentcore-story': '云端模型',
};

export const providerName = provider => names[provider.id] || '辅助模型';
export const maxAnalysisWindow = (provider, strategy) => provider?.id === 'stepfun-vision' ? 48 : strategy === 'video-first' ? 90 : 180;
export function validateAnalysisScope(start, end, mediaDuration, provider, strategy) {
  if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(mediaDuration)||start<0||end<=start||end>mediaDuration)
    throw new Error('请选择源片内有效的分析开始与结束时刻。');
  const maximum=maxAnalysisWindow(provider,strategy);
  if(end-start>maximum+1e-6)throw new Error(`当前方式单次最多分析 ${maximum} 秒，请缩小所选片段。`);
  return {start,end};
}
export const isWritingProvider = provider => provider?.kind === 'semantic'
  && provider.modalities?.includes('text') && provider.id?.endsWith('-story');

export function writingProviders(capabilities) {
  return (capabilities?.providers || []).filter(provider => provider.available && isWritingProvider(provider));
}

export function visualChoices(capabilities) {
  return (capabilities?.providers || [])
    .filter(provider => provider.kind === 'semantic' && provider.available
      && !isWritingProvider(provider))
    .flatMap(provider => {
      const modes = provider.modalities || [];
      return [
        ...(modes.includes('video') ? [{provider, strategy:'video-first', label:'视频片段理解'}] : []),
        ...(modes.includes('image') ? [{provider, strategy:'frames-first', label:'取证帧理解'}] : []),
      ];
    });
}
