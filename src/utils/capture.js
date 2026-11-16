// Device capture helpers: GPS fix and camera photo (compressed JPEG data URL for the offline outbox).

export function getPosition({ timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('GPS is not available on this device.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, gps_accuracy_m: Math.min(p.coords.accuracy, 10000) }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission denied. Allow GPS to continue.' : 'Could not get a GPS fix. Try again outdoors.')),
      { enableHighAccuracy: true, timeout, maximumAge: 30_000 },
    );
  });
}

// The lines stamped across the foot of a captured photo: where it was taken and when, so the picture
// carries its own context when it is reviewed weeks later, away from the record it belongs to.
//
// `address` is shown when one could be fetched; offline there is none, and the coordinates are stamped
// with a note saying so, rather than leaving a reviewer wondering why this photo has no place on it.
export function stampLines({ address, latitude, longitude, gps_accuracy_m: accuracy, at = new Date() } = {}) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return [];
  const coords = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
    + (typeof accuracy === 'number' ? ` ±${Math.round(accuracy)} m` : '');
  const when = at.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return address ? [address, `${coords} · ${when}`] : [coords, `Address pending · ${when}`];
}

// Draws `lines` in a dark band across the bottom of the canvas. Sized from the image width so the stamp
// is as readable on a 1280 px photo as the designer's sketch at any other size.
function drawStamp(canvas, lines) {
  if (!lines.length) return;
  const ctx = canvas.getContext('2d');
  const pad = Math.round(canvas.width * 0.025);
  const size = Math.max(11, Math.round(canvas.width * 0.032));
  const gap = Math.round(size * 0.42);
  ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textBaseline = 'top';
  // Long addresses wrap rather than run off the edge.
  const maxWidth = canvas.width - pad * 2;
  const wrapped = [];
  for (const line of lines) {
    let current = '';
    for (const word of String(line).split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (current && ctx.measureText(next).width > maxWidth) {
        wrapped.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) wrapped.push(current);
    if (wrapped.length >= 4) break; // never let a stamp swallow the photo
  }
  const band = wrapped.length * size + (wrapped.length - 1) * gap + pad * 2;
  ctx.fillStyle = 'rgba(8, 15, 30, 0.62)';
  ctx.fillRect(0, canvas.height - band, canvas.width, band);
  ctx.fillStyle = '#ffffff';
  wrapped.forEach((line, i) => ctx.fillText(line, pad, canvas.height - band + pad + i * (size + gap)));
}

// Resizes the camera image so queued evidence stays small enough for SQLite and slow networks, and stamps
// where and when it was taken across the bottom.
export function compressImage(file, maxSide = 1280, quality = 0.8, lines = []) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      drawStamp(canvas, lines);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the photo.'));
    };
    img.src = url;
  });
}

// Timestamp with the device's timezone offset (the backend rejects naive timestamps).
export function deviceTimestamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

export const today = () => deviceTimestamp().slice(0, 10);
export const daysAgo = (n) => deviceTimestamp(new Date(Date.now() - n * 86_400_000)).slice(0, 10);
