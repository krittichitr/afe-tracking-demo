"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { GoogleMap, useJsApiLoader, DirectionsRenderer, MarkerF } from "@react-google-maps/api";
import { supabase } from "@/lib/supabaseClient";
import Link from "next/link";

// Configuration
const MAP_CONTAINER_STYLE = { width: "100%", height: "100dvh" };
// PATIENT_ICON removed (moved inside component)
const INITIAL_CENTER = { lat: 13.7563, lng: 100.5018 };
const POS_ANIMATION_DURATION = 800; // ms to slide to new pos
const MIN_MOVEMENT_THRESHOLD = 1.0; // meters (ignore jitter below this)
const PAN_THRESHOLD = 5.0; // meters (only pan map if user moves more than this from center)

// --- Math Helpers ---
const toRad = (d: number) => (d * Math.PI) / 180;

const getDistance = (p1: google.maps.LatLngLiteral, p2: google.maps.LatLngLiteral) => {
   const R = 6371e3;
   const φ1 = toRad(p1.lat);
   const φ2 = toRad(p2.lat);
   const Δφ = toRad(p2.lat - p1.lat);
   const Δλ = toRad(p2.lng - p1.lng);
   const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
   const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
   return R * c;
};

const lerp = (start: number, end: number, t: number) => start * (1 - t) + end * t;

// --- Hooks ---

// 1. Smooth Position Hook with Animation Loop
function useAnimatedPosition(targetPos: google.maps.LatLngLiteral | null) {
   const [visualPos, setVisualPos] = useState<google.maps.LatLngLiteral | null>(targetPos);

   // Refs for animation state
   const prevPosRef = useRef<google.maps.LatLngLiteral | null>(targetPos);
   const targetPosRef = useRef<google.maps.LatLngLiteral | null>(targetPos);
   const startTimeRef = useRef<number>(0);
   const frameRef = useRef<number>(0);

   useEffect(() => {
      if (!targetPos) return;

      // Initialize if first point
      if (!prevPosRef.current) {
         prevPosRef.current = targetPos;
         targetPosRef.current = targetPos;
         setVisualPos(targetPos);
         return;
      }

      // New target received
      prevPosRef.current = visualPos; // Start from WHERE WE ARE NOW (important for smoothness)
      targetPosRef.current = targetPos;
      startTimeRef.current = performance.now();

      const animate = (time: number) => {
         if (!prevPosRef.current || !targetPosRef.current) return;

         const elapsed = time - startTimeRef.current;
         const progress = Math.min(elapsed / POS_ANIMATION_DURATION, 1);

         // Easing function (Ease-Out Quad for more natural stop)
         const ease = (t: number) => 1 - (1 - t) * (1 - t);
         const t = ease(progress);

         const lat = lerp(prevPosRef.current.lat, targetPosRef.current.lat, t);
         const lng = lerp(prevPosRef.current.lng, targetPosRef.current.lng, t);

         setVisualPos({ lat, lng });

         if (progress < 1) {
            frameRef.current = requestAnimationFrame(animate);
         } else {
            prevPosRef.current = { lat, lng }; // Snap to end
         }
      };

      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(animate);

      return () => cancelAnimationFrame(frameRef.current);
   }, [targetPos]);

   return visualPos;
}

// 2. Smooth Heading Hook (Average Buffer + Lerp)
function useBufferedHeading(rawHeading: number) {
   const [visualHeading, setVisualHeading] = useState(rawHeading);
   const bufferRef = useRef<number[]>([]);
   const MAX_BUFFER = 5; // Valid buffer size

   useEffect(() => {
      // 1. Add to buffer
      const buffer = bufferRef.current;
      if (rawHeading !== null && !isNaN(rawHeading)) {
         buffer.push(rawHeading);
         if (buffer.length > MAX_BUFFER) buffer.shift();
      }

      if (buffer.length === 0) return;

      // 2. Average (Handling 360 wrap)
      // Simple Circular Mean: sum sin/cos components
      let sumSin = 0;
      let sumCos = 0;
      for (const h of buffer) {
         sumSin += Math.sin(toRad(h));
         sumCos += Math.cos(toRad(h));
      }
      const avgHeadingRad = Math.atan2(sumSin / buffer.length, sumCos / buffer.length);
      let avgHeading = (avgHeadingRad * 180) / Math.PI;
      if (avgHeading < 0) avgHeading += 360;

      setVisualHeading(avgHeading);

   }, [rawHeading]);

   return visualHeading;
}

export default function NavigationMode() {
   const [map, setMap] = useState<google.maps.Map | null>(null);

   // Icons moved to render phase to access google namespace

   // -- State --
   // We keep 'filteredMyPos' as the source for the UI animation
   const [filteredMyPos, setFilteredMyPos] = useState<google.maps.LatLngLiteral | null>(null);
   const [rawHeading, setRawHeading] = useState<number>(0);
   const [patientPos, setPatientPos] = useState<google.maps.LatLngLiteral | null>(null);

   // -- Visuals --
   // -- Visuals --
   const animatedMyPos = useAnimatedPosition(filteredMyPos);
   const animatedPatientPos = useAnimatedPosition(patientPos); // LERP for Patient
   const smoothHeading = useBufferedHeading(rawHeading); // Using buffer logic

   // -- Routing --
   const [routeOrigin, setRouteOrigin] = useState<google.maps.LatLngLiteral | null>(null);
   const [routeDestination, setRouteDestination] = useState<google.maps.LatLngLiteral | null>(null);
   const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);
   const [routeStats, setRouteStats] = useState<{ duration: string; distance: string } | null>(null);

   // Refs for Low-Pass Logic
   const lastRawPosRef = useRef<google.maps.LatLngLiteral | null>(null);
   const mapRef = useRef<google.maps.Map | null>(null);
   const lastRouteOriginRef = useRef<google.maps.LatLngLiteral | null>(null);
   const lastRouteDestRef = useRef<google.maps.LatLngLiteral | null>(null);
   const currentSpeedRef = useRef<number>(0);

   const { isLoaded } = useJsApiLoader({
      googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!,
   });

   const onLoad = useCallback((mapInstance: google.maps.Map) => {
      mapRef.current = mapInstance;
      setMap(mapInstance);
   }, []);

   // Handle Compass / Heading fallback
   useEffect(() => {
      const handleOrientation = (event: any) => {
         if (currentSpeedRef.current < 1) { // Only use compass if stationary or moving very slow
            if (event.webkitCompassHeading) {
               setRawHeading(event.webkitCompassHeading);
            } else if (event.alpha) {
               setRawHeading(360 - event.alpha);
            }
         }
      };

      if (typeof window !== "undefined" && window.DeviceOrientationEvent) {
         window.addEventListener("deviceorientation", handleOrientation, true);
      }
      return () => {
         if (typeof window !== "undefined") {
            window.removeEventListener("deviceorientation", handleOrientation);
         }
      };
   }, []);

   // --- 1. My Location (Navigator) with Low-Pass Filtering ---
   useEffect(() => {
      if (!navigator.geolocation) return;

      const watchId = navigator.geolocation.watchPosition(
         (pos) => {
            const { latitude, longitude, heading, speed } = pos.coords;
            currentSpeedRef.current = speed || 0;
            const newRawPos = { lat: latitude, lng: longitude };

            // A. Jitter Filter (Speed-based or Distance-based)
            if (lastRawPosRef.current) {
               const dist = getDistance(lastRawPosRef.current, newRawPos);
               // If moved very little (jitter), ignore
               if (dist < MIN_MOVEMENT_THRESHOLD) return;
            }

            // B. Low-Pass Filter (Simple weighted average for position stability)
            // alpha = 0.2 means new value contributes 20%, old 80% (Very smooth, but laggy)
            // alpha = 1.0 means no filter.
            // Dynamic Alpha: If speed is high, trust GPS more (alpha ~ 0.8). If slow, trust history (alpha ~ 0.2).
            let alpha = 0.5;
            if (speed && speed > 10) alpha = 0.8; // Driving fast
            if (speed && speed < 1) alpha = 0.2; // Walking/Stopped

            let filteredLat = newRawPos.lat;
            let filteredLng = newRawPos.lng;

            if (lastRawPosRef.current) {
               filteredLat = lerp(lastRawPosRef.current.lat, newRawPos.lat, alpha);
               filteredLng = lerp(lastRawPosRef.current.lng, newRawPos.lng, alpha);
            }

            const newFilteredPos = { lat: filteredLat, lng: filteredLng };

            lastRawPosRef.current = newFilteredPos; // Store filtered as 'last known' for next iteration
            setFilteredMyPos(newFilteredPos); // Helper for smooth hook

            if (heading !== null && !isNaN(heading) && currentSpeedRef.current >= 1) {
               setRawHeading(heading);
            }

            // C. Update Route Origin (Debounced by distance > 20m)
            if (!lastRouteOriginRef.current || getDistance(lastRouteOriginRef.current, newFilteredPos) > 20) {
               setRouteOrigin(newFilteredPos);
               lastRouteOriginRef.current = newFilteredPos;
            }
         },
         (err) => console.error("Geolocation Error:", err.code, err.message),
         { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
      );

      return () => navigator.geolocation.clearWatch(watchId);
   }, []);

   // --- 2. Camera Panning (Using the Visual Position) ---
   useEffect(() => {
      if (mapRef.current && animatedMyPos) {
         // Instead of panning every single frame (which causes jitter because GPS coords fluctuate slightly),
         // we check the distance between the current map center and the actual position.
         // If it's further than X meters, then we pan. This creates a "deadzone" where the phone
         // can roam freely in the middle without the background shaking.
         const currentCenter = mapRef.current.getCenter();
         if (currentCenter) {
            const centerPos = { lat: currentCenter.lat(), lng: currentCenter.lng() };
            const distToCenter = getDistance(centerPos, animatedMyPos);

            if (distToCenter > PAN_THRESHOLD) {
               mapRef.current.panTo(animatedMyPos);
            }
         } else {
            mapRef.current.panTo(animatedMyPos);
         }

         // Rotate map smoothly, only if heading changes significantly (e.g., > 1 degree)
         const currentHeading = mapRef.current.getHeading() || 0;
         if (Math.abs(currentHeading - smoothHeading) > 1.0) {
            mapRef.current.setHeading(smoothHeading);
         }
      }
   }, [animatedMyPos, smoothHeading]);

   // --- 3. Patient Location ---
   useEffect(() => {
      const fetch = async () => {
         const { data } = await supabase.from("location").select("*").order("created_at", { ascending: false }).limit(1);
         if (data && data[0]) {
            const p = { lat: data[0].latitude, lng: data[0].longitude };
            setPatientPos(p);
            setRouteDestination(p);
            lastRouteDestRef.current = p;
         }
      };
      fetch();

      let timer: NodeJS.Timeout;
      const ch = supabase.channel("nav").on("postgres_changes", { event: "INSERT", schema: "public", table: "location" }, payload => {
         const p = { lat: payload.new.latitude, lng: payload.new.longitude };
         setPatientPos(p);

         clearTimeout(timer);
         timer = setTimeout(() => {
            if (!lastRouteDestRef.current || getDistance(lastRouteDestRef.current, p) > 10) {
               setRouteDestination(p);
               lastRouteDestRef.current = p;
            }
         }, 3000);
      }).subscribe();
      return () => { supabase.removeChannel(ch); clearTimeout(timer); };
   }, []);

   // --- 4. Directions ---
   useEffect(() => {
      if (isLoaded && routeOrigin && routeDestination) {
         const ds = new google.maps.DirectionsService();
         ds.route({ origin: routeOrigin, destination: routeDestination, travelMode: google.maps.TravelMode.DRIVING }, (res, status) => {
            if (status === "OK" && res) {
               // Smart check: Only update if route changed significantly?
               // DirectionsRenderer handles diffing, but we can avoid flickering by checking structure.
               // For now, React state update is fine. Key is PRESERVE VIEWPORT.
               setDirections(res);
               const leg = res.routes[0].legs[0];
               setRouteStats({
                  distance: leg.distance?.text || "...",
                  duration: leg.duration?.text || "...",
               });
            }
         });
      }
   }, [isLoaded, routeOrigin, routeDestination]); // routeOrigin/Dest only update every 20m/10m -> Stable logic

   const handleRecenter = () => {
      if (mapRef.current && filteredMyPos) {
         mapRef.current.panTo(filteredMyPos);
         mapRef.current.setZoom(19);
         mapRef.current.setHeading(smoothHeading);
      }
   };

   const getArrivalTime = () => {
      if (!routeStats) return "--:--";
      const match = routeStats.duration.match(/(\d+)/);
      if (match) {
         const d = new Date();
         d.setMinutes(d.getMinutes() + parseInt(match[0]));
         return d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
      }
      return "--:--";
   };

   if (!isLoaded) return <div className="h-[100dvh] bg-black text-white flex center items-center justify-center">Loading...</div>;

   // Icons refined with Anchors for perfect alignment
   const PATIENT_ICON_FG = {
      url: "https://cdn-icons-png.flaticon.com/512/684/684908.png",
      scaledSize: new google.maps.Size(44, 44),
      anchor: new google.maps.Point(22, 44)
   };
   const PATIENT_ICON_BG = {
      path: "M 0,0 C -2,-20 -10,-22 -10,-30 A 10,10 0 1,1 10,-30 C 10,-22 2,-20 0,0 z",
      fillColor: "white",
      fillOpacity: 1,
      strokeColor: "white",
      strokeWeight: 4,
      scale: 1.2,
      anchor: new google.maps.Point(0, 0)
   };

   return (
      <div className="relative w-full h-[100dvh] bg-gray-900 overflow-hidden font-sans">
         {/* Top Bar */}
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
            <div className="w-10 h-10 md:w-12 md:h-12 bg-white rounded-full flex items-center justify-center shadow-md cursor-pointer hover:bg-gray-100 shrink-0">
               <svg className="w-6 h-6 md:w-7 md:h-7 text-[#4285F4]" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>
            </div>
         </div>

         <GoogleMap
            mapContainerStyle={MAP_CONTAINER_STYLE}
            center={INITIAL_CENTER} // Initial only, controlled by panTo later
            zoom={19}
            onLoad={onLoad}
            options={{ disableDefaultUI: true, mapTypeId: 'hybrid', tilt: 45, heading: smoothHeading, gestureHandling: "greedy" }}
         >
            {/* User Marker (Blue Arrow) */}
            {animatedMyPos && (
               <MarkerF
                  position={animatedMyPos}
                  options={{ optimized: true }}
                  icon={{
                     path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                     scale: 7,
                     fillColor: "#4285F4",
                     fillOpacity: 1,
                     strokeColor: "white",
                     strokeWeight: 2,
                     rotation: smoothHeading, // Buffered smooth heading
                  }}
                  zIndex={100}
               />
            )}

            {/* Patient Marker (Using LERP Animated Position) */}
            {animatedPatientPos && (
               <>
                  {/* Layer 1: Glow (DOM Marker) */}
                  <MarkerF position={animatedPatientPos} icon={PATIENT_ICON_BG as any} zIndex={90} options={{ optimized: false }} />
                  {/* Layer 2: Pin (DOM Marker) */}
                  <MarkerF position={animatedPatientPos} icon={PATIENT_ICON_FG as any} zIndex={91} options={{ optimized: false }} />
               </>
            )}

            {/* Directions */}
            {directions && <DirectionsRenderer directions={directions} options={{ suppressMarkers: true, polylineOptions: { strokeColor: "#4285F4", strokeWeight: 10, strokeOpacity: 0.9 }, preserveViewport: true }} />}
         </GoogleMap>

         {/* Floating Buttons */}
         <div className="absolute right-4 top-28 md:top-32 flex flex-col gap-3 md:gap-4 z-30">
            <div className="w-10 h-10 md:w-12 md:h-12 bg-white rounded-full shadow-lg flex items-center justify-center cursor-pointer hover:bg-gray-50 relative overflow-hidden">
               <div className="absolute top-2 w-0 h-0 border-l-[5px] border-r-[5px] border-b-[14px] border-l-transparent border-r-transparent border-b-red-600"></div>
               <div className="absolute bottom-2 w-0 h-0 border-l-[5px] border-r-[5px] border-t-[14px] border-l-transparent border-r-transparent border-t-gray-300"></div>
            </div>
            <div className="w-10 h-10 md:w-12 md:h-12 bg-white rounded-full shadow-lg flex items-center justify-center cursor-pointer hover:bg-gray-50">
               <svg className="w-5 h-5 md:w-6 md:h-6 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            </div>
            <div className="w-10 h-10 md:w-12 md:h-12 bg-white rounded-full shadow-lg flex items-center justify-center cursor-pointer hover:bg-gray-50">
               <svg className="w-5 h-5 md:w-6 md:h-6 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>
            </div>
            <div className="w-10 h-10 md:w-12 md:h-12 bg-white rounded-full shadow-lg flex items-center justify-center cursor-pointer hover:bg-gray-50">
               <svg className="w-5 h-5 md:w-6 md:h-6 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v3" />
               </svg>
               <div className="absolute top-2 right-3 w-2 h-2 bg-red-500 rounded-full"></div>
            </div>
         </div>

         <div onClick={handleRecenter} className="absolute bottom-44 md:bottom-40 left-4 z-30 bg-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 cursor-pointer text-blue-600 font-bold text-sm tracking-wide hover:bg-gray-50 transition-colors">
            <svg className="w-4 h-4 transform rotate-45" fill="currentColor" viewBox="0 0 20 20"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg>
            ปรับจุดกลาง
         </div>

         <div className="absolute bottom-0 left-0 w-full z-30 bg-white rounded-t-3xl shadow-[0_-5px_20px_rgba(0,0,0,0.2)] px-6 py-6 pb-safe md:pb-10 transition-transform duration-300">
            <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-4"></div>
            <div className="flex items-center justify-between">
               <div className="flex flex-col">
                  {routeStats ? (
                     <>
                        <span className="text-3xl md:text-4xl font-extrabold text-[#188038] tracking-tight">{routeStats.duration}</span>
                        <div className="flex items-center gap-2 mt-1 text-gray-500 font-medium text-sm">
                           <span>{routeStats.distance}</span><span>•</span><span>{getArrivalTime()}</span>
                        </div>
                     </>
                  ) : (
                     <span className="text-2xl font-bold text-gray-400 animate-pulse">Calculating...</span>
                  )}
               </div>
               <div className="hidden sm:flex w-12 h-12 bg-gray-100 rounded-full items-center justify-center text-gray-600">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
               </div>
               <Link href="/dashboard-v2">
                  <button className="bg-red-600 hover:bg-red-700 text-white text-lg font-bold py-3 px-6 md:px-8 rounded-full shadow-md transition-all active:scale-95">ออก</button>
               </Link>
            </div>
         </div>
      </div>
   );
}
