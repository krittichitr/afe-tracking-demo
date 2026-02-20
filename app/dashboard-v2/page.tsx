"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { GoogleMap, useJsApiLoader, MarkerF, DirectionsRenderer } from "@react-google-maps/api";
import { supabase } from "@/lib/supabaseClient";
import Link from "next/link";

const mapContainerStyle = { width: "100%", height: "100%" };
const defaultCenter = { lat: 13.7563, lng: 100.5018 };

export default function DashboardV2() {
  const [map, setMap] = useState<google.maps.Map | null>(null);

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
    path: typeof google !== "undefined" ? google.maps.SymbolPath.FORWARD_CLOSED_ARROW : 1,
    scale: 6,
    fillColor: "#4285F4",
    fillOpacity: 1,
    strokeColor: "white",
    strokeWeight: 2,
    rotation: 0 // Will clearly show direction
  };
  const [currentPos, setCurrentPos] = useState<google.maps.LatLngLiteral>(defaultCenter);
  const [myPos, setMyPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [heading, setHeading] = useState<number>(0); // Heading/Rotation

  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);

  // Map Pad state
  const [padding, setPadding] = useState({ top: 0, bottom: 0, left: 0, right: 0 });



  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!,
  });

  const onLoad = useCallback((mapInstance: google.maps.Map) => {
    setMap(mapInstance);
  }, []);

  // Calculate Padding on Mount for "Bottom Center"
  useEffect(() => {
    // Put user at ~65% down the screen (pushing map center down by adding top padding)
    // Actually, if we add TOP padding, the "center" of the visible area moves DOWN.
    // So if we panTo(User), the User is at the new center (lower on screen).
    if (typeof window !== "undefined") {
      const topPad = window.innerHeight * 0.55;
      setPadding({ top: topPad, bottom: 150, left: 0, right: 0 });
    }
  }, []);

  // Handle Compass / Heading
  useEffect(() => {
    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (event.webkitCompassHeading) {
        // iOS
        setHeading(event.webkitCompassHeading);
      } else if (event.alpha) {
        // Android (alpha is 0 at north usually, but tricky. reverse it)
        setHeading(360 - event.alpha);
      }
    };

    // Attempt to add listener
    if (typeof window !== "undefined" && window.DeviceOrientationEvent) {
      window.addEventListener("deviceorientation", handleOrientation as any, true);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("deviceorientation", handleOrientation as any);
      }
    };
  }, []);


  // 1. Get My Location (Navigator) - Follow Mode
  useEffect(() => {
    if (!navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, heading: gpsHeading } = position.coords;
        const newPos = { lat: latitude, lng: longitude };
        setMyPos(newPos);

        // Prefer GPS heading if moving fast (speed > 1m/s approx, though here we just check existence), else Compass
        if (gpsHeading !== null && !isNaN(gpsHeading) && position.coords.speed && position.coords.speed > 1) {
          setHeading(gpsHeading);
        }

        // --- FOLLOW MODE LOGIC ---
        // Removed auto-pan to user so map can be zoomed out freely
        // if (map) {
        //   map.panTo(newPos);
        // }
      },
      (error) => console.error("Error getting location:", error),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [map]);

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

  // 3. Calculate Route (Throttled: Update every 10 seconds or significant movement)
  const lastRouteTime = useRef<number>(0);

  useEffect(() => {
    if (isLoaded && myPos && currentPos) {
      const now = Date.now();
      // Rate limit: Only update route every 10 seconds to save API quota
      if (now - lastRouteTime.current < 10000) return;

      lastRouteTime.current = now;

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
            }
          }
        }
      );
    }
  }, [isLoaded, myPos, currentPos]);

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


      {/* Main Map Area */}
      <div className="absolute inset-0 z-0">
        <GoogleMap
          mapContainerStyle={mapContainerStyle}
          center={currentPos}
          zoom={18}
          onLoad={onLoad}
          options={{
            disableDefaultUI: true,
            zoomControl: false,
            heading: heading, // Dynamic Heading
            tilt: 45, // 3D Perspective
            // Padding logic: Top padding implies the "active" viewport starts lower. 
            // So centering on a point puts it in the middle of the active viewport, 
            // which is visually lower on the screen if top padding > bottom padding.
            padding: padding
          }}
        >
          {myPos && <MarkerF position={myPos} icon={{ ...MY_LOC_ICON_OPT as any, rotation: heading }} zIndex={2} />}
          <MarkerF position={currentPos} icon={PATIENT_ICON_BG as any} zIndex={1} />
          <MarkerF position={currentPos} icon={PATIENT_ICON_FG as any} zIndex={2} />
          {directions && (
            <DirectionsRenderer
              directions={directions}
              options={{
                suppressMarkers: true,
                preserveViewport: true, // IMPORTANT: Don't auto-fit bounds, let us control camera
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