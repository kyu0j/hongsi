import { untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { handleAuthError } from '../auth/auth-state.svelte';
import { api, isApp, native } from '../../shared/api/api';
import { connectionError, responseError, responseFormat } from '../../shared/api/api-error';
import { errorText, reportServer } from '../../shared/api/net.svelte';
import { inSession, isCurrentSession, sessionVersion, onSessionChange, readUserData, writeUserData } from '../../shared/state/session';
import { toast, toastOnce } from '../../shared/state/ui.svelte';
import type { DownloadRecord, FileSource, SavedDownload } from '../../shared/types';

const KEY = 'downloads';
const CHECK_BATCH_SIZE = 100;
const load = () => readUserData<DownloadRecord[]>(KEY, []);
const recordKey = (record: DownloadRecord) => JSON.stringify([record.id, record.at, record.path]);

export const downloads = $state({ list: load(), busy: new SvelteSet<string>() });
const checking = new Set<DownloadRecord>();

async function refreshDownloads(records: DownloadRecord[]) {
  const version = sessionVersion();
  const pending = records.filter((record) => !checking.has(record));
  pending.forEach((record) => checking.add(record));
  try {
    for (let offset = 0; offset < pending.length; offset += CHECK_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + CHECK_BATCH_SIZE);
      const files = await native.checkDownloads(batch.map((record) => record.path));
      if (!isCurrentSession(version)) return;
      if (files.length !== batch.length) throw new Error('파일을 확인하지 못했어요.');
      const changed = new Map<DownloadRecord, SavedDownload | null>();
      batch.forEach((record, index) => {
        const file = files[index];
        if (!file || file.path !== record.path || file.name !== record.name) changed.set(record, file);
      });
      if (!changed.size) continue;
      downloads.list = downloads.list.flatMap((record) => {
        const file = changed.get(record);
        if (file === undefined) return [record];
        return file ? [{ ...record, path: file.path, name: file.name }] : [];
      });
      writeUserData(KEY, downloads.list);
    }
  } finally {
    pending.forEach((record) => checking.delete(record));
  }
}

type DownloadListOptions = { rows: () => (DownloadRecord | undefined)[]; onError?: (error: unknown) => void };

export function watchDownloadList(node: HTMLElement, options: DownloadListOptions) {
  if (!isApp) return;
  let listed = new Set<string>();
  let frame = 0;
  const active = () => node.isConnected && !document.hidden && !node.closest('[inert], [data-covered]');
  function check(records: DownloadRecord[]) {
    const version = sessionVersion();
    void refreshDownloads(records).catch((error) => {
      if (active() && isCurrentSession(version)) options.onError?.(error);
    });
  }

  $effect(() => {
    const records = options.rows().filter((record) => record !== undefined);
    const added = records.filter((record) => !listed.has(recordKey(record)));
    listed = new Set(records.map(recordKey));
    if (active() && added.length) untrack(() => check(added));
  });

  function resume() {
    if (frame || !active()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!active()) return;
      const viewport = node.closest('.body')?.getBoundingClientRect();
      const visible = options.rows().flatMap((record, index) => {
        const bounds = node.children[index]?.getBoundingClientRect();
        return record && bounds && bounds.bottom > (viewport?.top ?? 0) && bounds.top < (viewport?.bottom ?? window.innerHeight)
          ? [record] : [];
      });
      check(visible);
    });
  }
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('focus', resume);
  window.addEventListener('hongsi-resume', resume);
  return { destroy() {
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('focus', resume);
    window.removeEventListener('hongsi-resume', resume);
  } };
}

function forgetMissing(record: DownloadRecord, error: unknown, version: number) {
  if (!isApp || !isCurrentSession(version) || fileErrorText(error, '') !== '파일이 없어요.') return;
  downloads.list = downloads.list.filter((saved) => saved.id !== record.id || saved.at !== record.at || saved.path !== record.path);
  writeUserData(KEY, downloads.list);
}

function remember(record: DownloadRecord) {
  downloads.list = [record, ...downloads.list.filter((d) => d.id !== record.id || d.path !== record.path)];
  writeUserData(KEY, downloads.list);
}

onSessionChange(() => {
  downloads.list = load();
  downloads.busy.clear();
});

export function fileId(src: FileSource): string {
  if (src.kind === 'assign') return `${src.cmid}:${src.index}`;
  if (src.kind === 'module') return `m:${src.cmid}:${src.index}`;
  return `b:${src.cmid}:${src.bwid}:${src.index}`;
}

export function savedFile(src: FileSource): DownloadRecord | undefined {
  const id = fileId(src);
  return downloads.list.find((d) => d.id === id && (d.path || !isApp));
}

async function browserDownload(src: FileSource, name: string) {
  const blob = await inSession(async () => {
    let res: Response;
    try {
      res = await fetch(api.fileUrl(src), { credentials: 'same-origin' });
    } catch {
      reportServer(false);
      throw connectionError(false, { method: 'GET', path: api.fileUrl(src) });
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw responseError(res.status, body, { method: 'GET', path: api.fileUrl(src), format: responseFormat(res.headers.get('content-type')) });
    }
    return res.blob();
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.split('/').pop() || name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const fileMessages = new Set([
  '자동 로그인 정보를 읽지 못했어요.', '자동 로그인 정보를 저장하지 못했어요.', '자동 로그인 정보를 삭제하지 못했어요.',
  '다운로드 폴더를 찾지 못했어요.', '다운로드 폴더를 열지 못했어요.', '폴더를 만들지 못했어요.',
  '파일 저장 권한을 허용해 주세요.', '파일을 저장하지 못했어요.', '파일을 확인하지 못했어요.', '파일이 없어요.', '열 수 없는 경로예요.',
  '파일이나 링크를 열지 못했어요.', '링크를 열 브라우저가 없어요.', '이 파일 형식을 열 수 있는 앱이 없어요.',
  '파일 앱을 열지 못했어요.', '폴더를 열지 못했어요.', '파일을 다운받을 수 없어요.', '다운로드에 실패했어요.',
  '활동을 찾지 못했어요.', '글을 찾지 못했어요.', '로그인이 필요해요.', '다시 로그인해 주세요.',
  '학교 서버가 응답하지 않아요.', '인터넷에 연결되어 있지 않아요.', '홍시 서버에 연결할 수 없어요.',
  '동기화 서버에 연결할 수 없어요.', '서버에 연결하지 못했어요.', '응답이 늦어지고 있어요.',
  '서버 응답을 확인하지 못했어요.', '잠시 후 다시 시도해 주세요.', '이 요청은 허용되지 않았어요.',
  '파일이나 요청의 용량이 너무 커요.',
]);

export function fileErrorText(error: unknown, fallback: string): string {
  const text = errorText(error, fallback).trim();
  const message = text.endsWith('.') ? text : `${text}.`;
  return fileMessages.has(message) ? message : fallback;
}

export async function downloadFile(src: FileSource, name: string, course: string): Promise<DownloadRecord | null> {
  const version = sessionVersion();
  const id = fileId(src);
  if (downloads.busy.has(id)) return null;
  downloads.busy.add(id);
  try {
    const file = isApp ? await native.download(src, name) : (await browserDownload(src, name), null);
    if (!isCurrentSession(version)) return null;
    const record: DownloadRecord = {
      id,
      name: file?.name ?? (name.split('/').pop() || name),
      course,
      source: src,
      at: Date.now(),
      path: file?.path ?? null,
    };
    remember(record);
    toast('다운로드를 완료했어요', 'success');
    return record;
  } catch (e) {
    if (isCurrentSession(version) && !handleAuthError(e)) toastOnce(fileErrorText(e, '다운로드에 실패했어요.'), 'error');
    return null;
  } finally {
    if (isCurrentSession(version)) downloads.busy.delete(id);
  }
}

export async function openDownload(d: DownloadRecord) {
  const version = sessionVersion();
  try {
    if (isApp && d.path) await native.openFile(d.path);
    else window.open(api.fileUrl(d.source, true), '_blank', 'noopener');
  } catch (e) {
    if (!isCurrentSession(version)) return;
    forgetMissing(d, e, version);
    toast(fileErrorText(e, '파일이나 링크를 열지 못했어요.'), 'error');
  }
}

export async function revealDownload(d: DownloadRecord) {
  const version = sessionVersion();
  try {
    if (d.path) await native.revealFile(d.path);
  } catch (e) {
    if (!isCurrentSession(version)) return;
    forgetMissing(d, e, version);
    toast(fileErrorText(e, '폴더를 열지 못했어요.'), 'error');
  }
}
