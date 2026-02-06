"use client";
import { useEffect, useState, useCallback } from "react";
import { GoogleMap, useJsApiLoader, MarkerF, DirectionsRenderer } from "@react-google-maps/api";
import { supabase } from "@/lib/supabaseClient";
import Link from "next/link"; 

const mapContainerStyle = { width: "100%", height: "100%" };
const defaultCenter = { lat: 13.7563, lng: 100.5018 };
const PATIENT_ICON = "http://maps.google.com/mapfiles/ms/icons/red-dot.png";
const MY_LOCATION_ICON = "http://maps.google.com/mapfiles/ms/icons/blue-dot.png";

const formatTime = (isoString: string) => {
  if (!isoString) return "รอการอัปเดต...";
  const date = new Date(isoString);
  return date.toLocaleString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

export default function DashboardV2() {
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [currentPos, setCurrentPos] = useState<google.maps.LatLngLiteral>(defaultCenter);
  const [myPos, setMyPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);

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
        setLastUpdated(data[0].created_at);
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
          setLastUpdated(payload.new.created_at);
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
              setRouteInfo({
                distance: result.routes[0].legs[0].distance?.text || "",
                duration: result.routes[0].legs[0].duration?.text || "",
              });
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
    <div className="flex h-screen bg-gray-100 overflow-hidden font-sans relative">
      
      {/* Mobile-Friendly Toggle Button */}
      <button 
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
        className={`absolute top-4 left-4 z-50 bg-white p-3 rounded-full shadow-lg hover:bg-gray-50 text-gray-700 transition-all active:scale-95 ${isSidebarOpen ? 'ml-[330px]' : ''} md:ml-0`}
      >
        {isSidebarOpen ? (
           <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
           </svg>
        ) : (
           <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
           </svg>
        )}
      </button>

      {/* Sidebar - Made Responsive */}
      {/* On Mobile: fixed absolute over map. On Desktop: relative flex column */}
      <div 
        className={`
          fixed inset-y-0 left-0 w-full md:w-96 bg-white shadow-2xl z-40 transform transition-transform duration-300 ease-in-out md:relative
          ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0 md:flex md:flex-col
          ${isSidebarOpen ? "md:w-96" : "!w-0 !p-0 overflow-hidden"} 
        `}
      >
        <div className="h-full flex flex-col">
           {/* Header */}
           <div className="p-6 bg-gradient-to-br from-red-600 to-red-700 text-white shadow-lg pt-16 md:pt-6">
              <div className="flex items-center gap-4 mb-4">
                <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm border-2 border-white/30 shrink-0">
                  <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-xl font-bold">ข้อมูลผู้ป่วย</h2>
                  <p className="text-red-100 text-sm">Status: Critical</p>
                </div>
              </div>
              
              <div className="space-y-1">
                <p className="text-sm text-red-100 opacity-80 uppercase tracking-wider font-semibold">ชื่อ-นามสกุล</p>
                <p className="font-medium text-lg truncate">ศาสตราจารย์ ดร.สมชาย ใจดี</p>
              </div>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-24 md:pb-6">
               {/* Real-time Route Info */}
               {routeInfo && (
                  <div className="bg-blue-50 p-4 rounded-xl border border-blue-100 shadow-sm">
                     <h3 className="text-blue-500 text-xs font-bold uppercase tracking-wider mb-2">การเดินทาง (Real-time)</h3>
                     <div className="flex justify-between items-end">
                        <div>
                          <span className="text-2xl font-bold text-blue-700">{routeInfo.duration}</span>
                          <p className="text-xs text-blue-400">เวลาโดยประมาณ</p>
                        </div>
                        <div className="text-right">
                          <span className="text-lg font-bold text-gray-700">{routeInfo.distance}</span>
                          <p className="text-xs text-gray-400">ระยะทาง</p>
                        </div>
                     </div>
                  </div>
               )}

               <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 shadow-sm">
                  <h3 className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-3">ข้อมูลสุขภาพ</h3>
                  <div className="space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="mt-1 w-5 h-5 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                        <svg className="w-3 h-3 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-gray-700">โรคประจำตัว</p>
                        <p className="text-gray-600 text-sm">โรคหัวใจ, ความดันโลหิตสูง</p>
                      </div>
                    </div>
                  </div>
               </div>

               <div className="bg-orange-50 p-4 rounded-xl border border-orange-100 shadow-sm">
                 <div className="flex items-center gap-2 mb-2">
                   <svg className="w-4 h-4 text-orange-500 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                   </svg>
                   <span className="text-xs font-bold text-orange-700 uppercase">อัปเดตล่าสุด</span>
                 </div>
                 <p className="text-sm font-medium text-gray-700">
                   {formatTime(lastUpdated!)}
                 </p>
               </div>
            </div>

            {/* Bottom Actions - Fixed on Mobile Sidebar */}
            <div className="p-4 bg-white border-t border-gray-100 space-y-3 shrink-0">
               <Link href="/navigation" className="block w-full">
                  <button className="w-full bg-[#0F5338] hover:bg-[#0A3D28] text-white font-bold py-4 px-6 rounded-xl shadow-lg active:scale-95 transition-all flex items-center justify-center gap-3">
                     <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                     </svg>
                     <div className="text-left">
                        <div className="text-sm font-normal opacity-90">โหมดนำทาง</div>
                        <div className="text-lg leading-none">เริ่มนำทาง (In-App)</div>
                     </div>
                  </button>
               </Link>
               
               <button 
                  onClick={handleEmergencyNav}
                  className="w-full bg-white border-2 border-gray-200 hover:bg-gray-50 text-gray-700 font-bold py-3 px-6 rounded-xl transition-all flex items-center justify-center gap-2"
               >
                  <span className="text-sm">Google Maps (App)</span>
               </button>
            </div>
        </div>
      </div>

      {/* Main Map Area */}
      <div className="flex-1 right-0 top-0 h-full w-full absolute md:relative z-0">
         <GoogleMap 
          mapContainerStyle={mapContainerStyle} 
          center={currentPos} 
          zoom={16}
          onLoad={onLoad}
          options={{
            disableDefaultUI: false,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: false,
            zoomControl: true,
          }}
        >
          {myPos && (
             <MarkerF 
                position={myPos} 
                icon={MY_LOCATION_ICON}
                title="My Location"
                zIndex={2}
             />
          )}
          <MarkerF 
            position={currentPos} 
            title="ผู้ป่วย" 
            icon={PATIENT_ICON}
            zIndex={2}
          />
          {directions && (
            <DirectionsRenderer
              directions={directions}
              options={{
                suppressMarkers: true,
                polylineOptions: {
                  strokeColor: "#2563EB",
                  strokeWeight: 6,
                  strokeOpacity: 0.8,
                },
              }}
            />
          )}
        </GoogleMap>
      </div>
    </div>
  );
}