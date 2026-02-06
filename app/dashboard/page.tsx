'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { GoogleMap, MarkerF, useLoadScript } from '@react-google-maps/api';
import { supabase } from '@/lib/supabaseClient';

const mapContainerStyle = {
  width: '100%',
  height: '100vh',
};

// Default center (Phitsanulok) in case no data yet
const defaultCenter = {
  lat: 16.8211,
  lng: 100.2659,
};

const mapOptions = {
  disableDefaultUI: false,
  clickableIcons: false,
  scrollwheel: true,
  styles: [
    {
      featureType: 'all',
      elementType: 'geometry',
      stylers: [{ color: '#242f3e' }],
    },
    {
      featureType: 'all',
      elementType: 'labels.text.stroke',
      stylers: [{ color: '#242f3e' }],
    },
    {
      featureType: 'all',
      elementType: 'labels.text.fill',
      stylers: [{ color: '#746855' }],
    },
    {
      featureType: 'administrative.locality',
      elementType: 'labels.text.fill',
      stylers: [{ color: '#d59563' }],
    },
    {
      featureType: 'poi',
      elementType: 'labels.text.fill',
      stylers: [{ color: '#d59563' }],
    },
    {
      featureType: 'poi.park',
      elementType: 'geometry',
      stylers: [{ color: '#263c3f' }],
    },
    {
      featureType: 'poi.park',
      elementType: 'labels.text.fill',
      stylers: [{ color: '#6b9a76' }],
    },
    {
      featureType: 'road',
      elementType: 'geometry',
      stylers: [{ color: '#38414e' }],
    },
    {
      featureType: 'road',
      elementType: 'geometry.stroke',
      stylers: [{ color: '#212a37' }],
    },
    {
      featureType: 'road',
      elementType: 'labels.text.fill',
      stylers: [{ color: '#9ca5b3' }],
    },
    {
      featureType: 'road.highway',
      elementType: 'geometry',
      stylers: [{ color: '#746855' }],
    },
    {
      featureType: 'road.highway',
      elementType: 'geometry.stroke',
      stylers: [{ color: '#1f2835' }],
    },
    {
      featureType: 'road.highway',
      elementType: 'labels.text.fill',
      stylers: [{ color: '#f3d19c' }],
    },
    {
      featureType: 'water',
      elementType: 'geometry',
      stylers: [{ color: '#17263c' }],
    },
    {
      featureType: 'water',
      elementType: 'labels.text.fill',
      stylers: [{ color: '#515c6d' }],
    },
    {
      featureType: 'water',
      elementType: 'labels.text.stroke',
      stylers: [{ color: '#17263c' }],
    },
  ],
};

export default function DashboardPage() {
  const { isLoaded } = useLoadScript({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!,
  });

  const [currentPos, setCurrentPos] = useState(defaultCenter);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [status, setStatus] = useState<'connecting' | 'live'>('connecting');
  const [mapRef, setMapRef] = useState<google.maps.Map | null>(null);

  const onMapLoad = useCallback((map: google.maps.Map) => {
    setMapRef(map);
  }, []);

  // Fetch initial position
  useEffect(() => {
    const fetchLatestPosition = async () => {
      const { data, error } = await supabase
        .from('location')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (data && !error) {
        const newPos = { lat: data.latitude, lng: data.longitude };
        setCurrentPos(newPos);
        setLastUpdated(new Date(data.created_at));
        setStatus('live');
        mapRef?.panTo(newPos);
      }
    };

    fetchLatestPosition();
  }, [mapRef]);

  // Subscribe to Realtime updates
  useEffect(() => {
    const channel = supabase
      .channel('realtime-location')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'location',
        },
        (payload) => {
          console.log('New location received:', payload);
          const { latitude, longitude, created_at } = payload.new;
          const newPos = { lat: latitude, lng: longitude };
          
          setCurrentPos(newPos);
          setLastUpdated(new Date(created_at));
          setStatus('live');
          
          // Smooth pan to new location
          mapRef?.panTo(newPos);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [mapRef]);

  if (!isLoaded) return <div className="flex items-center justify-center h-screen bg-slate-950 text-white">Loading Maps...</div>;

  return (
    <div className="relative h-screen w-full bg-slate-950">
      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        zoom={16}
        center={currentPos}
        options={mapOptions}
        onLoad={onMapLoad}
      >
        <MarkerF 
            position={currentPos} 
            animation={google.maps.Animation.DROP}
            icon={{
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: "#3b82f6",
                fillOpacity: 1,
                strokeColor: "#ffffff",
                strokeWeight: 2,
            }}
        />
      </GoogleMap>

      {/* Floating Status Card */}
      <div className="absolute top-6 left-6 z-10 w-80">
        <div className="bg-slate-900/90 backdrop-blur-md border border-white/10 rounded-2xl p-6 shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-white tracking-tight">Patient Tracker</h2>
                <div className="flex items-center gap-2 bg-slate-800 px-3 py-1 rounded-full border border-white/5">
                    <span className={`w-2 h-2 rounded-full ${status === 'live' ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
                    <span className="text-xs font-semibold uppercase text-slate-300">
                        {status === 'live' ? 'LIVE' : 'WAITING'}
                    </span>
                </div>
            </div>

            <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <div className="bg-slate-800/50 p-3 rounded-xl border border-white/5">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Latitude</span>
                        <div className="font-mono text-lg text-white">{currentPos.lat.toFixed(6)}</div>
                    </div>
                    <div className="bg-slate-800/50 p-3 rounded-xl border border-white/5">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Longitude</span>
                        <div className="font-mono text-lg text-white">{currentPos.lng.toFixed(6)}</div>
                    </div>
                </div>

                <div className="flex items-center justify-between text-xs text-slate-500 border-t border-white/5 pt-4">
                    <div className="flex items-center gap-1.5">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>Last Update</span>
                    </div>
                    <span className="text-slate-300 font-medium">
                        {lastUpdated ? lastUpdated.toLocaleTimeString() : 'Waiting for signal...'}
                    </span>
                </div>
            </div>
            
            {/* Glossy overlay effect */}
            <div className="absolute top-0 left-0 w-full h-1/2 bg-gradient-to-b from-white/5 to-transparent pointer-events-none" />
        </div>
      </div>
    </div>
  );
}
