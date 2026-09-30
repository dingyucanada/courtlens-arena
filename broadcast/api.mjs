import {apiToken, cloudEnabled} from './auth.mjs';
export const API_ROOT = '/api/broadcast/v1';

export class BroadcastApiError extends Error {
  constructor(error, status = 0) {
    super(error?.message || '服务暂时没有响应。');
    this.name = 'BroadcastApiError';
    this.code = error?.code || (status === 0 ? 'network_unavailable' : 'request_failed');
    this.status = status;
    this.retryable = error?.retryable ?? (status === 0 || status >= 500);
    this.fields = Array.isArray(error?.fields) ? error.fields : [];
    this.jobId = error?.jobId || null;
  }
}

async function call(path, {method = 'GET', body, headers = {}, timeout = 12000, raw = false} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const token = await apiToken();
    const response = await fetch(`${API_ROOT}${path}`, {
      method, body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
      headers: {...(raw ? {} : body === undefined ? {} : {'Content-Type': 'application/json'}), ...(token ? {'Authorization': `Bearer ${token}`} : {}), ...headers},
      signal: controller.signal,
      cache: 'no-store',
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw new BroadcastApiError({code: 'invalid_response', message: '服务返回了无法读取的结果，请刷新后重试。'}, response.status); }
    if (response.status === 401 && cloudEnabled()) throw new BroadcastApiError({code:'auth_required',message:'登录已过期，请重新登录后继续。',retryable:true},401);
    if (!response.ok || payload?.error) throw new BroadcastApiError(payload?.error, response.status);
    if (!Object.prototype.hasOwnProperty.call(payload, 'data')) throw new BroadcastApiError({code: 'invalid_response', message: '服务结果缺少内容，请刷新后重试。'}, response.status);
    return payload.data;
  } catch (error) {
    if (error instanceof BroadcastApiError) throw error;
    if (error?.name === 'AbortError') throw new BroadcastApiError({code: 'timeout', message: '等待超时。可以重试；已保存的内容不会丢失。', retryable: true});
    throw new BroadcastApiError({code: 'network_unavailable', message: '制作服务无法连接。请启动 CourtLens 本地服务后重试。', retryable: true});
  } finally { clearTimeout(timer); }
}

export const api = {
  capabilities: () => call('/capabilities'),
  projects: () => call('/projects'),
  createProject: (title, mode) => call('/projects', {method: 'POST', body: {title, mode}}),
  project: id => call(`/projects/${encodeURIComponent(id)}`),
  upload: (id, revision, file) => call(`/projects/${encodeURIComponent(id)}/media`, {method: 'POST', raw: true, body: file,
    headers: {'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), 'If-Match': String(revision)}, timeout: 180000}),
  edit: (project, patch) => call(`/projects/${encodeURIComponent(project.id)}/edit`, {method: 'POST', body: {expectedRevision: project.revision, patch}}),
  metrics: (project, bundle) => call(`/projects/${encodeURIComponent(project.id)}/metrics`, {method: 'POST', body: {expectedRevision: project.revision, bundle}}),
  frames: (project, times) => call(`/projects/${encodeURIComponent(project.id)}/frames`, {method: 'POST', body: {expectedRevision: project.revision, times},headers:cloudEnabled()?{'Idempotency-Key':crypto.randomUUID()}:{}}),
  analyze: (project, providerId, scope, strategy) => call(`/projects/${encodeURIComponent(project.id)}/analyze`, {method: 'POST', body: {expectedRevision: project.revision, providerId, scope, strategy}, headers: {'Idempotency-Key': crypto.randomUUID()}}),
  cv: (project, providerId, scope) => call(`/projects/${encodeURIComponent(project.id)}/cv`, {method: 'POST', body: {expectedRevision: project.revision, providerId, scope}, headers: {'Idempotency-Key': crypto.randomUUID()}}),
  importCv: (project, result) => call(`/projects/${encodeURIComponent(project.id)}/cv/import`, {method: 'POST', body: {expectedRevision: project.revision, result}}),
  story: (project, audience, mode, providerId = null) => call(`/projects/${encodeURIComponent(project.id)}/story`, {method: 'POST', body: {expectedRevision: project.revision, audience, mode, providerId},headers:{'Idempotency-Key':crypto.randomUUID()}}),
  review: (project, actor, checks, note) => call(`/projects/${encodeURIComponent(project.id)}/review`, {method: 'POST', body: {expectedRevision: project.revision, actor, checks, note}}),
  render: (project, voiceMode, voiceId = null) => call(`/projects/${encodeURIComponent(project.id)}/render`, {method: 'POST', body: {expectedRevision: project.revision, voiceMode, voiceId}, headers: {'Idempotency-Key': crypto.randomUUID()}}),
  job: id => call(`/jobs/${encodeURIComponent(id)}`),
  cancel: id => call(`/jobs/${encodeURIComponent(id)}/cancel`, {method: 'POST', body: {}}),
  release: id => call(`/releases/${encodeURIComponent(id)}`),
  probe: (providerId, project, frameId = null, scope = null) => call(`/providers/${encodeURIComponent(providerId)}/probe`, {method:'POST',body:{projectId:project.id,expectedRevision:project.revision,frameId,scope},headers:{'Idempotency-Key':crypto.randomUUID()}}),
  prepareUpload: (project, file, sha256) => call(`/projects/${encodeURIComponent(project.id)}/uploads`, {method:'POST',body:{expectedRevision:project.revision,bytes:file.size,sha256,contentType:file.type||'application/octet-stream'}}),
  commitUpload: (project, file, sha256, uploadKey) => call(`/projects/${encodeURIComponent(project.id)}/media/commit`, {method:'POST',body:{expectedRevision:project.revision,uploadKey,bytes:file.size,sha256,contentType:file.type||'application/octet-stream',filename:file.name},headers:{'Idempotency-Key':crypto.randomUUID()}}),
  putSigned: async (uploadUrl, requiredHeaders, file) => {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),12*60*1000);
    try {
      const response=await fetch(uploadUrl,{method:'PUT',headers:requiredHeaders,body:file,credentials:'omit',signal:controller.signal});
      if(!response.ok) throw new BroadcastApiError({code:'upload_failed',message:`云端上传未完成（${response.status}），请重试。`,retryable:true},response.status);
    } catch(error) {
      if(error instanceof BroadcastApiError) throw error;
      throw new BroadcastApiError({code:'upload_failed',message:error?.name==='AbortError'?'上传超时，请重试。':'无法连接素材存储，请检查网络后重试。',retryable:true});
    } finally {clearTimeout(timer);}
  },
};
