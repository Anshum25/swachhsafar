import { useEffect, useRef, useState } from 'react';
import { CameraIcon, PinIcon, Spinner } from './Icons.jsx';
import { compressImage, getPosition } from '../utils/capture.js';
import { reverseGeocode } from '../services/geocode.js';
import LocationMap from './LocationMap.jsx';
import { useSession } from '../app/session.jsx';
import { validateMedia } from '../database/mediaStore.js';
import { startVoiceRecording, voiceFormat } from '../utils/voiceRecording.js';
import { useSecurity } from '../security/SecurityProvider.jsx';

// `stamp`: what to print across the foot of the photo (see stampLines). The picked file is kept so that a
// location or address arriving after the photo re-stamps it, instead of leaving the first photo of a shift
// as the only one without a place on it.
export function PhotoCapture({ value, onChange, required, stamp }) {
  const input = useRef(null);
  const [error, setError] = useState(null);
  const file = useRef(null);
  const lines = JSON.stringify(stamp ?? []);
  async function render(f, text) {
    setError(null);
    onChange(await compressImage(f, 1280, 0.8, text));
  }
  async function pick(e) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    file.current = picked;
    try {
      await render(picked, stamp ?? []);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => {
    if (!file.current || !value) return;
    render(file.current, JSON.parse(lines)).catch(() => {});
    // Re-stamps only when the text actually changes; `value` is the output, so it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);
  return (
    <div>
      <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={pick} data-testid="photo-input" />
      {value ? (
        <div className="relative animate-fade-in overflow-hidden rounded-2xl ring-1 ring-line">
          <img src={value} alt="Captured evidence" className="max-h-60 w-full object-cover" />
          <button type="button" className="btn-secondary absolute bottom-2 right-2 shadow-card" onClick={() => input.current.click()}>Retake</button>
        </div>
      ) : (
        <button type="button" onClick={() => input.current.click()}
          className="mx-auto flex aspect-[1.2] w-full max-w-[11.5rem] flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-400 bg-brand-100/70 text-brand-700 transition duration-150 hover:bg-brand-100 active:scale-[0.98]">
          <CameraIcon className="mb-1 h-9 w-9" />
          <span className="text-[15px] font-bold">Add Photo{required ? '' : ' (optional)'}</span>
          <span className="text-xs font-medium text-muted">(JPG / PNG)</span>
        </button>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

// The record's location. Inside the signed-in app the fix comes from the security location guard (so its
// time, source and mock flag are known and the division's accuracy/age rules apply); elsewhere directly.
const GUARD_ERRORS = {
  denied: 'Location permission is off for this app.', services_off: 'Location (GPS) is switched off.',
  timeout: 'No location fix arrived in time. Move near a window and try again.', unavailable: 'Location is not available right now.',
};
// `auto`: fetch the fix as soon as the form opens, so the usual case needs no tap at all. The button stays
// for a retry or a refresh. `onAddress` receives the street address once it is known (null when there is
// none: offline, or no geocoding configured). `map`: also show the fix on a Google map under the row --
// a glance is enough to tell the platform you are standing on from a stale fix. The map is never
// required; it simply is not there when it cannot load (see LocationMap).
export function GpsCapture({ value, onChange, auto = false, onAddress, map = false }) {
  const sec = useSecurity();
  const api = useSession()?.api;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [address, setAddress] = useState(null);
  const started = useRef(false);
  const onAddressRef = useRef(onAddress);
  onAddressRef.current = onAddress;

  // The address of the current fix, looked up through our own server. Offline it stays null and the photo
  // is stamped with coordinates instead; nothing here can stop a record being saved.
  useEffect(() => {
    let cancelled = false;
    if (!value || !api) {
      setAddress(null);
      return undefined;
    }
    reverseGeocode(api, value).then((found) => {
      if (cancelled) return;
      setAddress(found);
      onAddressRef.current?.(found);
    });
    return () => { cancelled = true; };
  }, [value?.latitude, value?.longitude, api]);

  async function locate() {
    setBusy(true);
    setError(null);
    try {
      if (sec) {
        const fix = await sec.guards.location.refresh();
        if (!fix) throw new Error(GUARD_ERRORS[sec.guards.location.getState().error] ?? 'Location is not available right now.');
        onChange({ latitude: fix.latitude, longitude: fix.longitude, gps_accuracy_m: fix.accuracy != null ? Math.min(fix.accuracy, 10000) : undefined });
      } else {
        onChange(await getPosition());
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  // With `auto`, the fix is fetched as the form opens: by the time the photo is taken the place is
  // already known, and nobody has to remember to tap anything. Tried once, so a refusal is not retried
  // in a loop; the button is still there.
  useEffect(() => {
    if (!auto || value || started.current) return;
    started.current = true;
    locate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  return (
    <div className={map ? 'space-y-2' : undefined}>
      <div className="flex items-center justify-between gap-3 rounded-xl bg-canvas px-3.5 py-2.5 ring-1 ring-line">
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <PinIcon className={`h-5 w-5 shrink-0 ${value ? 'text-success' : 'text-slate-400'}`} />
          {value ? (
            // The address is what a person recognises; the coordinates stay, smaller, because they are the
            // evidence and the address is only a lookup of them.
            <span className="min-w-0" data-testid="gps-value">
              {address && <span className="block truncate font-medium text-ink" title={address}>{address}</span>}
              <span className={address ? 'block text-xs text-slate-500' : ''}>
                {value.latitude.toFixed(5)}, {value.longitude.toFixed(5)} <span className="text-slate-500">±{Math.round(value.gps_accuracy_m)} m</span>
              </span>
            </span>
          ) : (
            <span className="text-slate-500">{busy ? 'Getting location…' : error ?? 'Location not captured'}</span>
          )}
        </div>
        <button type="button" className="btn-secondary" onClick={locate} disabled={busy}>
          {busy && <Spinner />} {value ? 'Refresh' : 'Get GPS'}
        </button>
      </div>
      {map && <LocationMap value={value} />}
    </div>
  );
}

// Message for an operationsQueue.submit() outcome. Only 'synced' claims the server has the record.
export function outcomeToast(notify, outcome, what) {
  if (outcome.status === 'synced') notify('success', `${what} saved and synchronized.`);
  else if (outcome.status === 'invalid') notify('error', `${what} not saved: ${outcome.message}`);
  else if (outcome.status === 'failed') notify('error', `${what} rejected by the server: ${outcome.message}`);
  else notify('warning', `${what} saved on this device. It will sync when the server is reachable.`);
}

// True when the record is stored on the device (synced or waiting to sync).
export const savedLocally = (outcome) => outcome.status !== 'invalid' && outcome.status !== 'failed';

// ---- video and voice ------------------------------------------------------------------------------
// Values are { blob, mimeType, size, url } (url: an object URL for the preview). Only the Blob handle is
// kept in React state; its bytes are read once, when the record is saved (mediaItem below).

const MB = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// File extensions Android camera apps use when the browser reports no content type.
const VIDEO_EXT = { mp4: 'video/mp4', '3gp': 'video/3gpp', '3gpp': 'video/3gpp', webm: 'video/webm', mov: 'video/quicktime' };

function useObjectUrl(value, onChange) {
  // Revoke the preview URL when the value is replaced or the form closes.
  useEffect(() => () => { if (value?.url) URL.revokeObjectURL(value.url); }, [value]);
  return (blob, mimeType) => onChange(blob ? { blob, mimeType, size: blob.size, url: URL.createObjectURL(blob) } : null);
}

export function VideoCapture({ value, onChange }) {
  const input = useRef(null);
  const [error, setError] = useState(null);
  const set = useObjectUrl(value, onChange);
  function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    // Same rules as device storage and the server (mediaStore MEDIA_RULES): refused here, never "saved".
    let type;
    try {
      type = validateMedia({ kind: 'inspection_video', mimeType: file.type || VIDEO_EXT[ext], size: file.size });
    } catch (err) {
      setError(err.code === 'media_type_rejected' ? 'This video format is not supported. Record an MP4, 3GP or WebM video.' : err.message);
      return;
    }
    setError(null);
    set(file, type);
  }
  return (
    <div>
      <input ref={input} type="file" accept="video/*" capture="environment" className="hidden" onChange={pick} data-testid="video-input" />
      {value ? (
        <div className="space-y-2 rounded-2xl p-2 ring-1 ring-slate-200">
          <video src={value.url} controls playsInline className="max-h-56 w-full rounded-xl bg-black" data-testid="video-preview" />
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Video · {MB(value.size)}</span>
            <span className="flex gap-2">
              <button type="button" className="btn-link" onClick={() => input.current.click()}>Retake</button>
              <button type="button" className="btn-link text-red-700" onClick={() => set(null)}>Remove</button>
            </span>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => input.current.click()} className="btn-secondary h-10 w-full">Record video (optional)</button>
      )}
      {error && <p className="mt-1 text-xs text-red-600" role="alert">{error}</p>}
    </div>
  );
}

export { voiceFormat };

// Voice comment: the recording lifecycle lives in src/utils/voiceRecording.js (tested with fakes).
export function VoiceRecorder({ value, onChange, maxSeconds = 120 }) {
  const [state, setState] = useState({ recording: false, seconds: 0, error: null });
  const rec = useRef(null);
  const set = useObjectUrl(value, onChange);
  const format = voiceFormat();

  useEffect(() => () => rec.current?.stop(), []);

  async function start() {
    setState({ recording: false, seconds: 0, error: null });
    try {
      rec.current = await startVoiceRecording({ maxSeconds, onTick: (seconds) => setState((s) => ({ ...s, seconds })) });
    } catch (e) {
      setState({ recording: false, seconds: 0, error: e.message });
      return;
    }
    setState({ recording: true, seconds: 0, error: null });
    try {
      const out = await rec.current.done;
      set(out.blob, out.mimeType);
      setState({ recording: false, seconds: out.seconds, error: out.interrupted ? 'Recording was interrupted; the part recorded so far was kept.' : null });
    } catch (e) {
      setState({ recording: false, seconds: 0, error: e.message });
    } finally {
      rec.current = null;
    }
  }

  const stop = () => rec.current?.stop();
  return (
    <div className="space-y-2" data-testid="voice-recorder">
      {state.recording ? (
        <div className="flex items-center justify-between rounded-2xl bg-red-50 px-4 py-3 ring-1 ring-red-200">
          <span className="flex items-center gap-2 text-sm font-medium text-red-800"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" /> Recording {state.seconds}s / {maxSeconds}s</span>
          <button type="button" className="btn-secondary" onClick={stop}>Stop</button>
        </div>
      ) : value ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl p-2 ring-1 ring-slate-200">
          <audio src={value.url} controls className="min-w-0 flex-1" />
          <button type="button" className="btn-link" onClick={start}>Re-record</button>
          <button type="button" className="btn-link text-red-700" onClick={() => set(null)}>Remove</button>
        </div>
      ) : (
        <button type="button" className="btn-secondary w-full" onClick={start} disabled={!format}>
          {format ? 'Record voice comment (optional)' : 'Voice recording is not supported on this browser'}
        </button>
      )}
      {state.error && <p className="text-xs text-red-600" role="alert">{state.error}</p>}
    </div>
  );
}

// A captured video/voice value as an operationsQueue media item (bytes read once, here).
export async function mediaItem(value, { id, kind, divisionId }) {
  return { id, kind, division_id: divisionId, bytes: new Uint8Array(await value.blob.arrayBuffer()), mimeType: value.mimeType };
}
