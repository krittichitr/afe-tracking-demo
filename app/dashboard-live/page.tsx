"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { GoogleMap, useJsApiLoader, DirectionsRenderer, MarkerF } from "@react-google-maps/api";
import { supabase } from "@/lib/supabaseClient";

// Styles
const containerStyle = { width: "100%", height: "100vh" };
const defaultCenter = { lat: 13.7563, lng: 100.5018 }; // Bangkok fallback

// Icons
const PATIENT_ICON = "http://maps.google.com/mapfiles/ms/icons/red-dot.png";
const MY_LOCATION_ICON = "http://maps.google.com/mapfiles/ms/icons/blue-dot.png";

export default function LiveNavigationDashboard() {
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [myPos, setMyPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [patientPos, setPatientPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);
  const [status, setStatus] = useState<string>("Waiting for location data...");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!,
  });

  const onLoad = useCallback((mapInstance: google.maps.Map) => {
    setMap(mapInstance);
  }, []);

  // 1. Get My Location (Navigator) - Watch Position
  useEffect(() => {
    if (!navigator.geolocation) {
      setStatus("Geolocation is not supported by this browser.");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const pos = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        console.log("My Updated Location:", pos);
        setMyPos(pos);
      },
      (error) => {
        console.error("Error getting location:", error);
        setStatus("Unable to retrieve your location.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // 2. Get Patient Location (Supabase Realtime)
  useEffect(() => {
    // Initial fetch
    const fetchLatestLocation = async () => {
      const { data } = await supabase
        .from("location")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1);
      
      if (data && data[0]) {
        const pos = { lat: data[0].latitude, lng: data[0].longitude };
        setPatientPos(pos);
        setLastUpdated(data[0].created_at);
      }
    };
    fetchLatestLocation();

    // Subscribe
    const channel = supabase
      .channel("realtime-live-nav")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "location" },
        (payload) => {
          console.log("Patient Updated Location:", payload.new);
          setPatientPos({ lat: payload.new.latitude, lng: payload.new.longitude });
          setLastUpdated(payload.new.created_at);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // 3. Calculate Route & Bounds
  useEffect(() => {
    if (isLoaded && myPos && patientPos) {
      const directionsService = new google.maps.DirectionsService();

      directionsService.route(
        {
          origin: myPos,
          destination: patientPos,
          travelMode: google.maps.TravelMode.DRIVING,
        },
        (result, status) => {
          if (status === google.maps.DirectionsStatus.OK && result) {
            setDirections(result);
            setStatus(`Routing active. Dist: ${result.routes[0].legs[0].distance?.text}`);
            
            // Auto fit bounds to show both
            if (map) {
              const bounds = new google.maps.LatLngBounds();
              bounds.extend(myPos);
              bounds.extend(patientPos);
              map.fitBounds(bounds, 100); // 100px padding
            }
          } else {
            console.error(`Directions request failed due to ${status}`);
            setStatus("Routing failed.");
          }
        }
      );
    }
  }, [isLoaded, myPos, patientPos, map]);

  if (!isLoaded) return <div className="p-10 text-center">Loading Maps...</div>;

  return (
    <div className="flex h-screen flex-col bg-gray-100">
      {/* Top Bar */}
      <div className="bg-white shadow-md p-4 flex justify-between items-center z-10 relative">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
            </span>
            Live Navigation Dashboard
          </h1>
          <p className="text-sm text-gray-500">{status}</p>
        </div>
        <div className="text-right">
             <div className="text-xs text-gray-400 font-semibold mb-1">PATIENT LAST UPDATED</div>
             <div className="font-mono font-bold text-gray-700 bg-gray-100 px-2 py-1 rounded">
                {lastUpdated ? new Date(lastUpdated).toLocaleTimeString("th-TH") : "--:--:--"}
             </div>
        </div>
      </div>

      {/* Map Area */}
      <div className="flex-1 relative">
        <GoogleMap
          mapContainerStyle={containerStyle}
          center={defaultCenter}
          zoom={12}
          onLoad={onLoad}
          options={{
            disableDefaultUI: false,
            zoomControl: true,
            mapTypeControl: false,
            fullscreenControl: false,
            streetViewControl: false,
          }}
        >
          {/* My Location (Blue) */}
          {myPos && (
             <MarkerF 
                position={myPos} 
                icon={MY_LOCATION_ICON}
                title="My Location"
                zIndex={2}
             />
          )}

          {/* Patient Location (Red) */}
          {patientPos && (
             <MarkerF 
                position={patientPos} 
                icon={PATIENT_ICON}
                title="Patient Location"
                zIndex={2}
             />
          )}

          {/* Route Line */}
          {directions && (
            <DirectionsRenderer
              directions={directions}
              options={{
                suppressMarkers: true, // We use custom markers
                polylineOptions: {
                  strokeColor: "#2563EB", // Blue path
                  strokeWeight: 6,
                  strokeOpacity: 0.7,
                },
              }}
            />
          )}
        </GoogleMap>
        
        {/* Legend / Stats Overlay */}
        <div className="absolute bottom-6 left-6 bg-white/90 backdrop-blur p-4 rounded-xl shadow-lg border border-gray-200">
           <div className="flex items-center gap-3 mb-2">
              <img src={MY_LOCATION_ICON} className="w-6 h-6" alt="My Location" />
              <div className="text-sm">
                 <p className="font-bold text-gray-800">My Location</p>
                 <p className="text-xs text-gray-500">{myPos ? `${myPos.lat.toFixed(5)}, ${myPos.lng.toFixed(5)}` : "Locating..."}</p>
              </div>
           </div>
           <div className="w-full border-t border-gray-200 my-2"></div>
           <div className="flex items-center gap-3">
              <img src={PATIENT_ICON} className="w-6 h-6" alt="Patient Location" />
              <div className="text-sm">
                 <p className="font-bold text-gray-800">Patient</p>
                 <p className="text-xs text-gray-500">{patientPos ? `${patientPos.lat.toFixed(5)}, ${patientPos.lng.toFixed(5)}` : "Waiting for signal..."}</p>
              </div>
           </div>
           
           {directions && directions.routes[0] && directions.routes[0].legs[0] && (
               <div className="mt-3 pt-3 border-t border-gray-200">
                  <div className="flex justify-between items-end">
                      <div>
                          <div className="text-xs uppercase font-bold text-gray-400">Distance</div>
                          <div className="text-lg font-bold text-gray-800">{directions.routes[0].legs[0].distance?.text}</div>
                      </div>
                      <div className="text-right">
                          <div className="text-xs uppercase font-bold text-gray-400">Est. Time</div>
                          <div className="text-lg font-bold text-blue-600">{directions.routes[0].legs[0].duration?.text}</div>
                      </div>
                  </div>
               </div>
           )}
        </div>
      </div>
    </div>
  );
}
