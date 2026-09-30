/** Read-only inventory. Dictionary roles describe the import; they do not certify its source. */
const categories = [
  {id:'xfg', label:'xFG', match:entry=>entry.role==='difficulty' && ['official_xfg','xfg_probability','shot_make_probability'].includes(entry.semantics)},
  {id:'gravity-on', label:'持球 Gravity', match:entry=>entry.role==='gravity' && entry.ballState==='on-ball'},
  {id:'gravity-off', label:'无球 Gravity', match:entry=>entry.role==='gravity' && entry.ballState==='off-ball'},
  {id:'lvg', label:'LVG 类（口径待核）', match:entry=>entry.role==='leverage' && entry.semantics!=='possession_win_probability_opportunity'},
];
const testSource = provenance => {
  const kind = String(provenance?.kind || '').toLowerCase();
  const source = String(provenance?.source || '').toLowerCase();
  return ['synthetic','fixture','test','demo','mock'].some(term=>kind.includes(term)||source.includes(term));
};

export function dataReadiness(project) {
  const context=project?.context || {}, bundle=project?.metrics || {};
  const gameId=context.gameId, pbp=context.playByPlay;
  const rosterCount=gameId && Array.isArray(context.roster) ? context.roster.length : 0;
  const pbpCount=gameId && pbp?.source?.gameId===gameId && Array.isArray(pbp.entries) ? pbp.entries.length : 0;
  const dictionary=bundle.dictionary || {}, definitions=dictionary.metrics || {};
  const plays=new Map((bundle.plays || []).map(play=>[play.id,play]));
  const accepted=new Set((project?.observations || []).filter(row=>row.review?.status==='accepted').map(row=>row.id));
  const bound=new Set((project?.bindings || []).filter(binding=>binding.status==='confirmed' && binding.gameId===gameId && accepted.has(binding.observationId)).flatMap(binding=>binding.metricRecordIds || []));
  const records=(bundle.records || []).filter(record=>{
    const scope=record.scope || {}, play=plays.get(scope.playId);
    return gameId && ['event','shot'].includes(scope.granularity) && play?.gameId===gameId && record.value!==null && record.value!==undefined && definitions[record.metricId];
  });
  return {
    rosterCount, pbpCount,
    categories:categories.map(category=>{
      const rows=records.filter(record=>category.match(definitions[record.metricId]));
      const mappedCount=rows.filter(record=>bound.has(record.id)).length;
      const isTest=rows.some(record=>testSource(bundle.provenance)||testSource(dictionary.provenance)||testSource(definitions[record.metricId].provenance)||testSource(record.provenance));
      const status=!rows.length?'missing':isTest?'test':mappedCount?'mapped':'pending';
      return {id:category.id,label:category.label,status,importedCount:rows.length,mappedCount};
    }),
  };
}
