"use client";
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { GoogleMap, useJsApiLoader, DirectionsRenderer, MarkerF } from "@react-google-maps/api";
import { supabase } from "@/lib/supabaseClient";
import Link from "next/link";

// Use 100dvh for better mobile browser support
const mapContainerStyle = { width: "100%", height: "100dvh" };
const PATIENT_ICON = "http://maps.google.com/mapfiles/ms/icons/red-dot.png";
const INITIAL_CENTER = { lat: 13.7563, lng: 100.5018 };

// Helper: Calculate Haversine Distance (in meters)
const getDistance = (pos1: google.maps.LatLngLiteral, pos2: google.maps.LatLngLiteral) => {
  const R = 6371e3; // metres
  const φ1 = (pos1.lat * Math.PI) / 180;
  const φ2 = (pos2.lat * Math.PI) / 180;
  const Δφ = ((pos2.lat - pos1.lat) * Math.PI) / 180;
  const Δλ = ((pos2.lng - pos1.lng) * Math.PI) / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // in meters
};

// Helper for arrival time calc
const calculateArrivalTime = (durationText: string) => {
  const now = new Date();
  const match = durationText.match(/(\d+)/); 
  if (match) {
    now.setMinutes(now.getMinutes() + parseInt(match[0]));
    return now.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  }
  return "--:--";
};

export default function NavigationMode() {
  const [map, setMap] = useState<google.maps.Map | null>(null);
  
  // Real-time Positions (Raw inputs)
  const [myPos, setMyPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [patientPos, setPatientPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [myHeading, setMyHeading] = useState<number>(0);

  // Routing State (Throttled/Debounced updates)
  const [routeOrigin, setRouteOrigin] = useState<google.maps.LatLngLiteral | null>(null);
  const [routeDestination, setRouteDestination] = useState<google.maps.LatLngLiteral | null>(null);
  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);
  const [routeStats, setRouteStats] = useState<{ distance: string; duration: string; arrivalTime: string } | null>(null);

  // Refs for tracking previous valid positions for routing
  const lastRouteOriginRef = useRef<google.maps.LatLngLiteral | null>(null);
  const lastRouteDestRef = useRef<google.maps.LatLngLiteral | null>(null);

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!,
  });

  const mapRef = useRef<google.maps.Map | null>(null);

  const onLoad = useCallback((mapInstance: google.maps.Map) => {
    mapRef.current = mapInstance;
    setMap(mapInstance);
  }, []);

  // 1. My Location (Watch) - High Frequency
  useEffect(() => {
    if (!navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, heading } = pos.coords;
        const newPos = { lat: latitude, lng: longitude };
        
        // Update marker immediately (Smooth user experience)
        setMyPos(newPos);
        if (heading) setMyHeading(heading);

        // Follow Mode with Smooth Panning
        if (mapRef.current) {
           mapRef.current.panTo(newPos); 
        }

        // Optimization: Updates Route Origin only if moved > 20 meters
        if (!lastRouteOriginRef.current || getDistance(lastRouteOriginRef.current, newPos) > 20) {
           console.log("Significant movement detected (My Pos). Updating route origin...");
           setRouteOrigin(newPos);
           lastRouteOriginRef.current = newPos;
        }
      },
      (err) => console.error("Location error:", err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // 2. Patient Location (Realtime) - Debounced
  useEffect(() => {
    // Initial Fetch
    const fetchValues = async () => {
      const { data } = await supabase.from("location").select("*").order("created_at", { ascending: false }).limit(1);
      if (data && data[0]) {
        const initialPos = { lat: data[0].latitude, lng: data[0].longitude };
        setPatientPos(initialPos);
        
        // Set initial route destination
        setRouteDestination(initialPos);
        lastRouteDestRef.current = initialPos;
      }
    };
    fetchValues();

    // Debounce Timer Ref
    let debounceTimer: NodeJS.Timeout;

    const channel = supabase
      .channel("nav-mode")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "location" }, (payload) => {
        const newPatientPos = { lat: payload.new.latitude, lng: payload.new.longitude };
        
        // Update marker UI immediately (or throttle if needed, but here we want responsiveness)
        // Actually, if we want "Smooth Marker", usually handled by library or requestAnimationFrame.
        // For Google Maps MarkerF, simply updating props is okay but raw updates can jump.
        // Here we update state immediately for the marker.
        setPatientPos(newPatientPos);

        // Debounce Route Calculation Logic
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
           // Optimization: Update Route Destination only if moved > 10 meters
           if (!lastRouteDestRef.current || getDistance(lastRouteDestRef.current, newPatientPos) > 10) {
              console.log("Significant patient movement detected. Recalculating route...");
              setRouteDestination(newPatientPos);
              lastRouteDestRef.current = newPatientPos;
           }
        }, 3000); // 3-second debounce window
      })
      .subscribe();

    return () => { 
      supabase.removeChannel(channel); 
      clearTimeout(debounceTimer);
    };
  }, []);

  // 3. Routing (Triggered ONLY when RouteOrigin or RouteDestination changes significantly)
  useEffect(() => {
    if (isLoaded && routeOrigin && routeDestination) {
      const directionsService = new google.maps.DirectionsService();
      
      directionsService.route(
        {
          origin: routeOrigin,
          destination: routeDestination,
          travelMode: google.maps.TravelMode.DRIVING,
        },
        (result, status) => {
          if (status === google.maps.DirectionsStatus.OK && result) {
            setDirections(result);
            const leg = result.routes[0].legs[0];
            const duration = leg.duration?.text || "...";
            setRouteStats({
              distance: leg.distance?.text || "...",
              duration: duration,
              arrivalTime: calculateArrivalTime(duration),
            });
          }
        }
      );
    }
  }, [isLoaded, routeOrigin, routeDestination]);

  const handleRecenter = () => {
    if (mapRef.current && myPos) {
      // Use smooth transition for recenter
      mapRef.current.panTo(myPos);
      mapRef.current.setZoom(19);
      if (myHeading) mapRef.current.setHeading(myHeading);
    }
  };

  if (!isLoaded) return <div className="h-[100dvh] bg-black text-white flex items-center justify-center">Loading Navigation...</div>;

  return (
    <div className="relative w-full h-[100dvh] bg-gray-900 overflow-hidden font-sans">
      
      {/* 1. Top Bar (Green Instruction) */}
      <div className="absolute top-4 left-4 right-4 md:left-8 md:right-8 z-30 bg-[#0F5338] text-white p-4 rounded-xl shadow-xl flex items-center justify-between min-h-[80px]">
         <div className="flex items-start gap-3 md:gap-4">
            <div className="mt-1">
               <svg className="w-8 h-8 md:w-10 md:h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" d="M5 10l7-7m0 0l7 7m-7-7v18" />
               </svg>
            </div>
            <div>
               <p className="text-xl md:text-2xl font-bold leading-tight tracking-wide">มุ่งหน้าทางตะวันตก</p>
               <p className="text-base md:text-lg text-green-100 font-medium">เฉียงใต้</p>
            </div>
         </div>
         {/* Google Maps Sparkle/Action Icon */}
         <div className="w-10 h-10 md:w-12 md:h-12 bg-white rounded-full flex items-center justify-center shadow-md cursor-pointer hover:bg-gray-100 shrink-0">
             <svg className="w-6 h-6 md:w-7 md:h-7 text-[#4285F4]" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
             </svg>
         </div>
      </div>

      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        center={myPos || INITIAL_CENTER}
        zoom={19}
        onLoad={onLoad}
        options={{
          disableDefaultUI: true,
          mapTypeId: 'hybrid', // Satellite Hybrid view
          tilt: 45, // 3D Perspective
          heading: myHeading,
          gestureHandling: "greedy", // Improve responsiveness
        }}
      >
        {/* User Arrow */}
        {myPos && (
           <MarkerF 
             position={myPos}
             options={{
                optimized: true, // Use canvas rendering for smoother performance
             }}
             icon={{
               path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
               scale: 7,
               fillColor: "#4285F4",
               fillOpacity: 1,
               strokeColor: "white",
               strokeWeight: 2,
               rotation: myHeading,
             }}
             zIndex={100}
           />
        )}

        {/* Destination Marker */}
        {patientPos && (
           <MarkerF 
              position={patientPos} 
              icon={PATIENT_ICON} 
              zIndex={90} 
              options={{ optimized: true }}
           />
        )}

        {/* Route Line */}
        {directions && (
          <DirectionsRenderer
            directions={directions}
            options={{
              suppressMarkers: true,
              polylineOptions: {
                strokeColor: "#4285F4",
                strokeWeight: 10, 
                strokeOpacity: 0.9,
              },
              preserveViewport: true, // IMPORTANT: Prevents map from auto-fitting on every route update
            }}
          />
        )}
      </GoogleMap>

      {/* 2. Floating Right Buttons (Compass, Search, Sound, Alert) */}
      <div className="absolute right-4 top-28 md:top-32 flex flex-col gap-3 md:gap-4 z-30">
          {/* Compass */}
          <div className="w-10 h-10 md:w-12 md:h-12 bg-white rounded-full shadow-lg flex items-center justify-center cursor-pointer hover:bg-gray-50 relative overflow-hidden">
             <div className="w-0 h-0 border-l-[5px] md:border-l-[6px] border-l-transparent border-r-[5px] md:border-r-[6px] border-r-transparent border-b-[14px] md:border-b-[16px] border-b-red-600 absolute top-2"></div>
             <div className="w-0 h-0 border-l-[5px] md:border-l-[6px] border-l-transparent border-r-[5px] md:border-r-[6px] border-r-transparent border-t-[14px] md:border-t-[16px] border-t-gray-300 absolute bottom-2"></div>
          </div>
          
          {/* Search */}
          <div className="w-10 h-10 md:w-12 md:h-12 bg-white rounded-full shadow-lg flex items-center justify-center cursor-pointer hover:bg-gray-50">
             <svg className="w-5 h-5 md:w-6 md:h-6 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
             </svg>
          </div>
          
          {/* Sound */}
          <div className="w-10 h-10 md:w-12 md:h-12 bg-white rounded-full shadow-lg flex items-center justify-center cursor-pointer hover:bg-gray-50">
             <svg className="w-5 h-5 md:w-6 md:h-6 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
             </svg>
          </div>
          
          {/* Alert */}
          <div className="w-10 h-10 md:w-12 md:h-12 bg-white rounded-full shadow-lg flex items-center justify-center cursor-pointer hover:bg-gray-50">
             <svg className="w-5 h-5 md:w-6 md:h-6 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v3" /> 
             </svg>
             <div className="absolute top-2 right-3 w-2 h-2 bg-red-500 rounded-full"></div>
          </div>
      </div>

      {/* Recenter Button (Left Side per image) */}
      <div 
        onClick={handleRecenter}
        className="absolute bottom-44 md:bottom-40 left-4 z-30 bg-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 cursor-pointer text-blue-600 font-bold text-sm tracking-wide hover:bg-gray-50 transition-colors"
      >
          <svg className="w-4 h-4 transform rotate-45" fill="currentColor" viewBox="0 0 20 20">
             <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
          </svg>
          ปรับจุดกลาง
      </div>

      {/* 3. Bottom Sheet Info - Safe Area for Mobile */}
      <div className="absolute bottom-0 left-0 w-full z-30 bg-white rounded-t-3xl shadow-[0_-5px_20px_rgba(0,0,0,0.2)] px-6 py-6 pb-safe md:pb-10 transition-transform duration-300">
         <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-4"></div>

         <div className="flex items-center justify-between">
             {/* Left: Info */}
             <div className="flex flex-col">
                {routeStats ? (
                   <>
                     <span className="text-3xl md:text-4xl font-extrabold text-[#188038] tracking-tight">{routeStats.duration}</span>
                     <div className="flex items-center gap-2 mt-1 text-gray-500 font-medium text-sm">
                        <span>{routeStats.distance}</span>
                        <span>•</span>
                        <span>{routeStats.arrivalTime}</span>
                     </div>
                   </>
                ) : (
                   <span className="text-2xl font-bold text-gray-400 animate-pulse">Calculating...</span>
                )}
             </div>

             {/* Center: Route Branch Icon - Hide on small screens if too crowded */}
             <div className="hidden sm:flex w-12 h-12 bg-gray-100 rounded-full items-center justify-center text-gray-600">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
             </div>
             
             {/* Right: Exit Button */}
             <Link href="/dashboard-v2">
                <button className="bg-red-600 hover:bg-red-700 text-white text-lg font-bold py-3 px-6 md:px-8 rounded-full shadow-md transition-all active:scale-95">
                   ออก
                </button>
             </Link>
         </div>
      </div>
    </div>
  );
}
