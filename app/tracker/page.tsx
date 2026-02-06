'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

export default function TrackerPage() {
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'locating' | 'sending' | 'error'>('idle');
  const [lastSent, setLastSent] = useState<Date | null>(null);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setError('Geolocation is not supported by your browser');
      setStatus('error');
      return;
    }

    setStatus('locating');

    const watchId = navigator.geolocation.watchPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        setCoords({ latitude, longitude });
        setStatus('sending');

        try {
          const { error: insertError } = await supabase
            .from('location')
            .insert({
              user_id: 'phone-simulator-01',
              latitude,
              longitude,
            });

          if (insertError) {
            console.error('Supabase Error Detailed:', JSON.stringify(insertError, null, 2));
            setError(insertError.message || JSON.stringify(insertError));
          } else {
            setLastSent(new Date());
            setError(null);
          }
        } catch (err) {
          console.error('Unexpected Error:', err);
          setError('Failed to send location');
        }
      },
      (geoError) => {
        console.error('Geolocation Error:', geoError);
        switch (geoError.code) {
          case geoError.PERMISSION_DENIED:
            setError('Permission denied. Please enable location services.');
            break;
          case geoError.POSITION_UNAVAILABLE:
            setError('Location information is unavailable.');
            break;
          case geoError.TIMEOUT:
            setError('The request to get user location timed out.');
            break;
          default:
            setError('An unknown error occurred.');
        }
        setStatus('error');
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-indigo-600/20 rounded-full blur-[100px] pointer-events-none" />

      <main className="z-10 w-full max-w-md bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-8 shadow-2xl">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Live Tracker
          </h1>
          <div className="flex items-center space-x-2">
            <div className={`w-3 h-3 rounded-full ${
              status === 'sending' ? 'bg-green-500 animate-pulse' :
              status === 'error' ? 'bg-red-500' :
              'bg-yellow-500'
            }`} />
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              {status === 'sending' ? 'Active' : status}
            </span>
          </div>
        </div>

        {error ? (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-red-200 text-sm mb-6 flex items-start space-x-3">
             <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
             </svg>
             <span>{error}</span>
          </div>
        ) : null}

        <div className="space-y-6">
          <div className="bg-slate-900/50 rounded-2xl p-6 border border-white/5">
            <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider block mb-2">
              Latitude
            </span>
            <div className="text-4xl font-mono text-white font-light tracking-tighter">
              {coords?.latitude.toFixed(6) ?? '---'}
            </div>
          </div>

          <div className="bg-slate-900/50 rounded-2xl p-6 border border-white/5">
            <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider block mb-2">
              Longitude
            </span>
            <div className="text-4xl font-mono text-white font-light tracking-tighter">
              {coords?.longitude.toFixed(6) ?? '---'}
            </div>
          </div>
        </div>

        <div className="mt-8 flex items-center justify-between text-xs text-slate-500 border-t border-white/5 pt-6">
          <div className="flex items-center space-x-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span>Device ID: <span className="text-slate-300">phone-simulator-01</span></span>
          </div>
          {lastSent && (
             <span>
               Updated: {lastSent.toLocaleTimeString()}
             </span>
          )}
        </div>
      </main>
    </div>
  );
}
