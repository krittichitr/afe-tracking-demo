"use client";
import { useEffect, useState } from "react";
import { GoogleMap, useJsApiLoader, Marker } from "@react-google-maps/api";
import { supabase } from "@/lib/supabaseClient";

const containerStyle = { width: "100%", height: "80vh" };
// พิกัดเริ่มต้น (กรุงเทพฯ หรือจุดที่คุณทดสอบ)
const defaultCenter = { lat: 13.7563, lng: 100.5018 };

export default function DashboardV1() {
  const [currentPos, setCurrentPos] = useState(defaultCenter);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!,
  });

  useEffect(() => {
    // 1. ดึงข้อมูลล่าสุดมาโชว์ก่อน
    const fetchLastLocation = async () => {
      const { data } = await supabase
        .from("location")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1);
      if (data && data[0]) {
        setCurrentPos({ lat: data[0].latitude, lng: data[0].longitude });
        setLastUpdated(data[0].created_at);
      }
    };
    fetchLastLocation();

    // 2. พระเอกของงาน: Subscribe ข้อมูลแบบ Real-time
    const channel = supabase
      .channel("realtime-locations")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "location" },
        (payload) => {
          console.log("Real-time update received:", payload.new);
          // อัปเดตพิกัดทันทีที่มีข้อมูลใหม่
          setCurrentPos({ lat: payload.new.latitude, lng: payload.new.longitude });
          setLastUpdated(payload.new.created_at);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleNavigate = () => {
    // เปิด Google Maps Routing ไปยังพิกัดปัจจุบัน
    const url = `https://www.google.com/maps/dir/?api=1&destination=${currentPos.lat},${currentPos.lng}`;
    window.open(url, "_blank");
  };

  if (!isLoaded) return <div>กำลังโหลดแผนที่...</div>;

  return (
    <div className="p-4">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-4">
        <h1 className="text-xl font-bold">AFE Plus: Real-time Monitor (V1)</h1>
        
        {/* ปุ่มนำทางฉุกเฉิน */}
        <button
          onClick={handleNavigate}
          className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-6 rounded-lg shadow-md flex items-center gap-2 transition-transform transform hover:scale-105"
        >
          <svg className="w-5 h-5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          นำทางไปยังตำแหน่งผู้ป่วย (Real-time)
        </button>
      </div>

      <div className="rounded-xl overflow-hidden shadow-lg border border-gray-200">
        {/* ใช้ currentPos เป็น center เพื่อให้แผนที่ขยับตามพิกัดล่าสุด */}
        <GoogleMap 
          mapContainerStyle={containerStyle} 
          center={currentPos} 
          zoom={15}
          options={{ disableDefaultUI: false, mapTypeControl: true }}
        >
          <Marker position={currentPos} label="ผู้ป่วย" />
        </GoogleMap>
      </div>
      
      <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg flex flex-col md:flex-row justify-between items-center gap-4">
        <div>
          <p className="text-gray-800 font-medium">
            📍 พิกัดปัจจุบัน: <span className="font-mono text-blue-600">{currentPos.lat.toFixed(6)}, {currentPos.lng.toFixed(6)}</span>
          </p>
          <p className="text-xs text-gray-500 mt-1">** หมุดจะขยับอัตโนมัติเมื่อมือถือส่งข้อมูลใหม่มา **</p>
        </div>
        
        {/* ส่วนแสดงเวลาอัปเดตล่าสุด */}
        <div className="text-right flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm">
          <div className={`w-3 h-3 rounded-full ${lastUpdated ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`}></div>
          <div>
            <p className="text-xs text-gray-400 uppercase font-bold">Last Updated</p>
            <p className="text-sm font-semibold text-gray-700">
              {lastUpdated ? new Date(lastUpdated).toLocaleString('th-TH') : 'รอสัญญาณ...'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}