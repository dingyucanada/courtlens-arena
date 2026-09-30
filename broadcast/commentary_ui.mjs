export const languages = [{id:'zh-CN',label:'普通话'},{id:'en-US',label:'英语'},{id:'yue-HK',label:'粤语'}];
export const styles = [{id:'analysis',label:'战术派'},{id:'energetic',label:'现场派'},{id:'data',label:'数据派'}];
const profiles = {'zh-analysis':{language:'zh-CN',commentaryStyle:'analysis'},'en-live':{language:'en-US',commentaryStyle:'energetic'},'yue-live':{language:'yue-HK',commentaryStyle:'energetic'}};
export function commentarySelection(story = {}) {
  story ||= {};
  const legacy = profiles[story.commentaryStyle] || profiles[story.profile] || profiles['zh-analysis'];
  return {language: languages.some(x=>x.id===story.language) ? story.language : legacy.language,
    commentaryStyle: styles.some(x=>x.id===story.commentaryStyle) ? story.commentaryStyle : legacy.commentaryStyle};
}
export function languageLabel(language) { return languages.find(x=>x.id===language)?.label || '语言未记录'; }
export function voiceProvidersForLanguage(capabilities, language) {
  const declaredModes = capabilities?.commentaryLanguages?.find(x=>x.id===language)?.voiceModes;
  return (capabilities?.providers || []).filter(provider => provider.kind === 'voice' && provider.available &&
    (Array.isArray(declaredModes) && declaredModes.includes(provider.id)));
}
