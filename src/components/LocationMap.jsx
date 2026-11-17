import { useEffect, useRef, useState } from 'react';
import { loadGoogleMaps, mapsConfigured } from '../services/googleMaps.js';

// Where the record is being captured, on a map, so whoever marks attendance can see at a glance that the
// fix is the platform they are standing on and not a stale one from the shed an hour ago.
//
// The map is a check, never the evidence: the record keeps the coordinates. With no key, no network, a
// referrer the key does not allow or a script that will not load, this renders nothing at all and the
// coordinates above it are the whole story.
export default function LocationMap({ value, label = 'Capture location', className = 'h-40' }) {
  const host = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  const circle = useRef(null);
  // 'loading' -> 'ready', or 'off' when the map cannot be had (no key, offline, script blocked, the key's
  // referrer restriction, billing). 'off' renders nothing: the coordinates stand on their own.
  const [state, setState] = useState('loading');
  const ready = state === 'ready';
  const lat = value?.latitude;
  const lng = value?.longitude;
  const accuracy = value?.gps_accuracy_m;
  const has = typeof lat === 'number' && typeof lng === 'number';

  // One load per page (the service dedupes); the map itself is created once this component has a fix.
  useEffect(() => {
    if (!has || !mapsConfigured()) return undefined;
    let cancelled = false;
    loadGoogleMaps().then((maps) => {
      if (cancelled) return;
      if (!maps || !host.current) {
        setState('off');
        return;
      }
      if (!map.current) {
        map.current = new maps.Map(host.current, {
          center: { lat, lng },
          zoom: 17,
          // A small embedded map inside a scrolling dialog: no clutter, and one-finger drags scroll the
          // dialog rather than the map.
          gestureHandling: 'cooperative',
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          keyboardShortcuts: false,
        });
        // The classic Marker rather than AdvancedMarkerElement: the advanced one needs a cloud-configured
        // map id, which this key's project does not have to carry for a pin on a 40-line map.
        marker.current = new maps.Marker({ map: map.current, position: { lat, lng }, title: label });
        circle.current = new maps.Circle({
          map: map.current,
          strokeColor: '#1d4ed8',
          strokeOpacity: 0.5,
          strokeWeight: 1,
          fillColor: '#1d4ed8',
          fillOpacity: 0.12,
          clickable: false,
        });
      }
      setState('ready');
    });
    return () => { cancelled = true; };
    // Created on the first fix; later fixes move it in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [has]);

  // A refreshed fix moves the marker and the accuracy ring instead of rebuilding the map.
  useEffect(() => {
    if (!ready || !has || !map.current) return;
    const at = { lat, lng };
    map.current.setCenter(at);
    marker.current?.setPosition(at);
    circle.current?.setCenter(at);
    // No reported accuracy: no ring, rather than a ring that claims a precision nobody measured.
    circle.current?.setRadius(typeof accuracy === 'number' ? Math.max(accuracy, 5) : 0);
  }, [ready, has, lat, lng, accuracy]);

  if (!has || !mapsConfigured() || state === 'off') return null;
  return (
    <div className={`relative overflow-hidden rounded-xl ring-1 ring-line ${ready ? '' : 'bg-canvas'}`} data-testid="location-map">
      <div ref={host} className={`w-full ${className}`} aria-label={label} />
      {!ready && (
        <p className="absolute inset-0 grid place-items-center text-xs font-medium text-slate-500">Loading map…</p>
      )}
    </div>
  );
}
