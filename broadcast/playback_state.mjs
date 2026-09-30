// Pure source-time lookup for the published film. Never carries a previous beat
// or value across a gap, a seek, or a validity boundary.
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function playbackState(manifest, sourcePTS) {
  const beats = manifest?.story?.beats || [];
  const range = manifest?.story?.sourceRange || manifest?.timing?.sourceRange;
  const empty = phase => ({phase, sourcePTS, beat:null, beatIndex:-1, compiledText:null, metric:null, annotation:null});
  if (!finite(sourcePTS) || !range || !finite(range.start) || !finite(range.end)) return empty('unavailable');
  if (sourcePTS < range.start) return empty('before');
  if (sourcePTS >= range.end) return empty('after');
  const beatIndex = beats.findIndex(row => sourcePTS >= row.sourceStart && sourcePTS < row.sourceEnd);
  if (beatIndex < 0) return empty('between');
  const beat = beats[beatIndex];
  const compiled = (manifest?.compiledBeats || []).find(row => row.beatId === beat.id);
  const evidence = manifest?.evidence || {};
  const metricId = beat.metricRecordId;
  let metric = null;
  if (metricId) {
    const record = evidence.metrics?.records?.find(row => row.id === metricId);
    const timing = record?.time || {};
    const binding = (evidence.bindings || []).find(row => beat.bindingIds?.includes(row.id) &&
      row.status === 'confirmed' && row.metricRecordIds?.includes(metricId) && beat.observationIds?.includes(row.observationId));
    const valid = binding && record && finite(record.value) && ['shot','event'].includes(record.scope?.granularity) &&
      timing.timeBase === 'video' && finite(timing.availableAt) && timing.availableAt <= sourcePTS &&
      (timing.observedAt == null || finite(timing.observedAt) && timing.observedAt <= sourcePTS) &&
      (timing.validFrom == null || finite(timing.validFrom) && timing.validFrom <= sourcePTS) &&
      (timing.validTo == null || finite(timing.validTo) && sourcePTS < timing.validTo);
    if (valid && compiled?.metric?.recordId === metricId) metric = compiled.metric;
  }
  let annotation = null;
  const sourceObservationId = beat.annotation?.sourceObservationId;
  if (sourceObservationId && beat.observationIds?.includes(sourceObservationId)) {
    const observation = (evidence.observations || []).find(row => row.id === sourceObservationId && row.review?.status === 'accepted');
    const geometry = observation?.geometry;
    if (geometry && geometry.segmentId === observation.segmentId &&
        finite(geometry.validFrom) && finite(geometry.validTo) &&
        sourcePTS >= geometry.validFrom && sourcePTS < geometry.validTo &&
        Array.isArray(beat.annotation.points) && beat.annotation.points.length === 2) {
      annotation = beat.annotation;
    }
  }
  const compiledText = !metricId || metric ? (compiled?.compiledText || beat.text || null) : null;
  return {phase:'commentary', sourcePTS, beat, beatIndex, compiledText, metric, annotation};
}
