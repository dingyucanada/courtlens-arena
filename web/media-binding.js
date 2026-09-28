/* A file digest binds the declared data to bytes; it does not authenticate annotations. */
(function(root){
  function check(expected, actual) {
    if (!expected || !actual.ready) return {ok:false, message:'等待视频与数据核验 · 已暂停同步标注与字幕'};
    if (actual.error) return {ok:false, message:actual.error};
    if (!/^[a-f0-9]{64}$/i.test(expected.sha256 || '')) return {ok:false, message:'数据缺少视频 SHA-256，无法确认片段身份 · 已暂停同步标注与字幕'};
    if (!actual.sha256) return {ok:false, message:'正在核对视频指纹 · 已暂停同步标注与字幕'};
    if (expected.sha256.toLowerCase() !== actual.sha256.toLowerCase()) return {ok:false, message:'视频指纹与数据不匹配 · 已暂停同步标注、字幕与证据跳转'};
    if (expected.width !== actual.width || expected.height !== actual.height) return {ok:false, message:'视频尺寸与数据不匹配 · 请重新校准'};
    if (!Number.isFinite(actual.duration) || Math.abs(expected.duration-actual.duration) > .1) return {ok:false, message:'视频时长与数据不匹配 · 请重新对齐'};
    return {ok:true, message:'视频指纹、尺寸与时长匹配 · 时间与标注仍以提供者校准为准'};
  }
  if (typeof module !== 'undefined' && module.exports) module.exports={check};
  else root.CourtLensMedia={check};
})(typeof globalThis !== 'undefined' ? globalThis : this);
