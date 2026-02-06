"use client";
import { useEffect, useState, useCallback } from "react";
import { GoogleMap, useJsApiLoader, MarkerF, DirectionsRenderer } from "@react-google-maps/api";
import { supabase } from "@/lib/supabaseClient";
import Link from "next/link"; 

const mapContainerStyle = { width: "100%", height: "100%" };
const defaultCenter = { lat: 13.7563, lng: 100.5018 };

export default function DashboardV2() {
  const [map, setMap] = useState<google.maps.Map | null>(null);
  
  // Define Icons (Moved inside to access google namespaces safely if needed, though here we use simple object structures that are compatible with the library's prop types if valid)
  // Actually, for React-Google-Maps, we can pass plain objects for Icon but the TS definition is strict about 'Size' class.
  // We will cast to 'any' for the icon prop to bypass the strict class requirement of the types vs the JS API's flexibility.
  
  // 1. Original 3D Pin (Foreground)
  const PATIENT_ICON_FG = {
      url: "https://cdn-icons-png.flaticon.com/512/684/684908.png", 
      scaledSize: { width: 44, height: 44 },
  };
  // 2. White Glow/Shadow (Background)
  const PATIENT_ICON_BG = {
      path: "M 0,0 C -2,-20 -10,-22 -10,-30 A 10,10 0 1,1 10,-30 C 10,-22 2,-20 0,0 z",
      fillColor: "white",
      fillOpacity: 1,
      strokeColor: "white",
      strokeWeight: 4, // Thick white stroke
      scale: 1.2,
  };

  const MY_LOC_ICON_OPT = {
      path: 0, // SymbolPath.CIRCLE is 0
      scale: 8,
      fillColor: "#4285F4",
      fillOpacity: 1,
      strokeColor: "white",
      strokeWeight: 2,
  };
  const [currentPos, setCurrentPos] = useState<google.maps.LatLngLiteral>(defaultCenter);
  const [myPos, setMyPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);

  // Voice Navigation State
  const [isMuted, setIsMuted] = useState(false);
  const [lastInstruction, setLastInstruction] = useState<string>("");
  const [hasSpokenArrival, setHasSpokenArrival] = useState(false);
  const [lastSpeakTime, setLastSpeakTime] = useState<number>(0); // For throttling

  // Speak Helper
  const speak = (text: string) => {
    if (isMuted || !window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // Stop previous
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "th-TH"; // Thai Language
    utterance.rate = 1.0;
    window.speechSynthesis.speak(utterance);
  };

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!,
  });

  const onLoad = useCallback((mapInstance: google.maps.Map) => {
    setMap(mapInstance);
  }, []);

  // 1. Get My Location (Navigator)
  useEffect(() => {
    if (!navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setMyPos({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      (error) => console.error("Error getting location:", error),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // 2. Fetch Patient Location
  useEffect(() => {
    const fetchLatestLocation = async () => {
      const { data } = await supabase
        .from("location")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1);
      
      if (data && data.length > 0) {
        setCurrentPos({ lat: data[0].latitude, lng: data[0].longitude });
      }
    };
    fetchLatestLocation();

    const channel = supabase
      .channel("realtime-locations-v2")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "location" },
        (payload) => {
          setCurrentPos({ lat: payload.new.latitude, lng: payload.new.longitude });
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // 3. Calculate Route
  useEffect(() => {
    if (isLoaded && myPos && currentPos) {
      const directionsService = new google.maps.DirectionsService();

      directionsService.route(
        {
          origin: myPos,
          destination: currentPos,
          travelMode: google.maps.TravelMode.DRIVING,
        },
        (result, status) => {
          if (status === google.maps.DirectionsStatus.OK && result) {
            setDirections(result);
            if (result.routes[0].legs[0]) {
              const leg = result.routes[0].legs[0];
              setRouteInfo({
                distance: leg.distance?.text || "",
                duration: leg.duration?.text || "",
              });

              // --- Voice Logic ---
              // --- Voice Logic (Enhanced) ---
              if (leg.steps && leg.steps.length > 0) {
                 const step = leg.steps[0];
                 const rawInstruction = step.instructions || "";
                 // Clean "<b>Text</b>" -> "Text"
                 const cleanInstruction = rawInstruction.replace(/<[^>]*>/g, ""); 
                 
                 // Distance check (distance is object {text: "200 m", value: 200})
                 const distVal = step.distance?.value || 0; // meters
                 const distText = step.distance?.text || "";

                 // Trigger conditions:
                 // 1. Instruction changed (New road)
                 // 2. Approaching turn (200m or 50m)
                 // 3. Throttled (10s)
                 
                 const now = Date.now();
                 const timeSinceLast = now - lastSpeakTime;
                 const isUrgent = distVal <= 50; // Urgent turn
                 const isApproaching = distVal <= 200 && distVal > 150; // Prepare to turn

                 // Construct message: "อีก 200 เมตร เลี้ยวซ้าย..."
                 const message = `อีก ${distText} ${cleanInstruction}`;

                 if (cleanInstruction !== lastInstruction || (timeSinceLast > 10000 && (isUrgent || isApproaching))) {
                    console.log("Speaking:", message);
                    speak(message);
                    setLastInstruction(cleanInstruction);
                    setLastSpeakTime(now);
                 }
              }

              // 2. Proximity Alert (< 50m)
              // distance.value is in meters
              if (leg.distance && leg.distance.value <= 50 && !hasSpokenArrival) {
                 speak("ท่านเข้าใกล้ตำแหน่งผู้ป่วยแล้ว");
                 setHasSpokenArrival(true);
              } else if (leg.distance && leg.distance.value > 100) {
                 // Reset if moved away
                 setHasSpokenArrival(false); 
              }
            }
            if (map) {
               const bounds = new google.maps.LatLngBounds();
               bounds.extend(myPos);
               bounds.extend(currentPos);
               map.fitBounds(bounds, 100); 
            }
          }
        }
      );
    }
  }, [isLoaded, myPos, currentPos, map]);

  const handleEmergencyNav = () => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${currentPos.lat},${currentPos.lng}`;
    window.open(url, "_blank");
  };

  if (!isLoaded) return (
    <div className="flex items-center justify-center h-screen bg-gray-50">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600"></div>
    </div>
  );

  return (
    <div className="relative h-screen w-full bg-gray-100 overflow-hidden font-sans">
      
      {/* Voice Toggle Button (Floating Top-Right) */}
      <button 
         onClick={() => setIsMuted(!isMuted)}
         className="absolute top-4 right-4 z-50 bg-white p-3 rounded-full shadow-lg hover:bg-gray-50 transition-all active:scale-95 text-gray-700"
      >
         {isMuted ? (
            <svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg>
         ) : (
            <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>
         )}
      </button>

      {/* Top Floating Patient Header REMOVED as requested */}

      {/* Main Map Area - Full Screen */}
      <div className="absolute inset-0 z-0">
         <GoogleMap 
          mapContainerStyle={mapContainerStyle} 
          center={currentPos} 
          zoom={16}
          onLoad={onLoad}
          options={{
            disableDefaultUI: true, // Clean look
            zoomControl: true,
          }}
        >
          {myPos && <MarkerF position={myPos} icon={MY_LOC_ICON_OPT as any} zIndex={2} />}
          <MarkerF position={currentPos} icon={PATIENT_ICON_BG as any} zIndex={1} />
          <MarkerF position={currentPos} icon={PATIENT_ICON_FG as any} zIndex={2} />
          {directions && (
            <DirectionsRenderer
              directions={directions}
              options={{
                suppressMarkers: true,
                polylineOptions: { strokeColor: "#2563EB", strokeWeight: 6, strokeOpacity: 0.8 },
              }}
            />
          )}
        </GoogleMap>
      </div>

      {/* Bottom Sheet Popup (The 2 Buttons) */}
      <div className="absolute bottom-0 left-0 w-full z-30">
          <div className="container mx-auto max-w-lg">
             <div className="bg-white rounded-t-3xl shadow-[0_-5px_30px_rgba(0,0,0,0.15)] p-6 pb-safe animate-slide-up">
                 <div className="w-12 h-1.5 bg-gray-200 rounded-full mx-auto mb-6"></div>

                 <div className="space-y-3">
                    {/* 1. In-App Navigation */}
                    <Link href="/navigation" className="block w-full">
                       <button className="w-full bg-[#0F5338] hover:bg-[#0A3D28] text-white py-4 px-6 rounded-2xl shadow-lg active:scale-95 transition-all flex items-center justify-between group">
                          <div className="flex items-center gap-4">
                             <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center">
                                <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" /></svg>
                             </div>
                             <div className="text-left">
                                <p className="text-sm font-medium text-green-100">โหมดนำทาง (In-App)</p>
                                <p className="text-xl font-bold leading-none">เริ่มนำทาง</p>
                             </div>
                          </div>
                          <svg className="w-6 h-6 text-white/70 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
                       </button>
                    </Link>
                    
                    {/* 2. External Map */}
                    <button 
                       onClick={handleEmergencyNav}
                       className="w-full bg-gray-50 hover:bg-gray-100 text-gray-700 font-bold py-3 px-6 rounded-xl border border-gray-200 transition-all flex items-center justify-center gap-2"
                    >
                       <span>เปิดด้วย Google Maps</span>
                       <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    </button>
                 </div>
             </div>
          </div>
      </div>
    </div>
  );
}