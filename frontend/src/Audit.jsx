import React, { useRef, useState, useEffect } from 'react';
import axios from 'axios';

function Audit({ schoolId, passcode, onLogout }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  
  const streamRef = useRef(null); 
  // FIX: This ref prevents the camera from turning on if a pending request resolves during processing
  const isCameraIntended = useRef(false); 
  
  // App Modes: 'capture' -> 'analyzing' -> 'reports'
  const [mode, setMode] = useState('capture');
  
  // Capture States
  const [photoData, setPhotoData] = useState(null);
  const [unit, setUnit] = useState(1);
  const [location, setLocation] = useState(null);
  const [remarks, setRemarks] = useState("");
  const [status, setStatus] = useState("Initializing sensors...");
  
  // Audio States
  const [isRecording, setIsRecording] = useState(false);
  const [audioBase64, setAudioBase64] = useState(null);
  
  // Batch Queue & Reports
  const [batch, setBatch] = useState([]);
  const [reports, setReports] = useState([]);
  const [lang, setLang] = useState('en'); 

  const startCamera = () => {
    isCameraIntended.current = true;
    
    // Ensure existing tracks are completely dead before requesting new ones
    if (streamRef.current) {
        stopCamera(); 
        isCameraIntended.current = true; // reset to true since stopCamera sets it to false
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: true })
      .then((mediaStream) => {
        // RACE CONDITION FIX: If the user hit "Analyze" before this stream resolved, instantly kill it.
        if (!isCameraIntended.current) {
           mediaStream.getTracks().forEach(track => track.stop());
           return;
        }
        
        streamRef.current = mediaStream;
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
        }
        setStatus("Ready to scan.");
      })
      .catch((err) => setStatus("Error: Camera/Mic access denied."));
  };

  const stopCamera = () => {
    isCameraIntended.current = false;
    
    if (streamRef.current) {
      // Force hardware tracks to stop immediately
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    }
  };

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => setStatus("Error: GPS required.")
      );
    }
    startCamera();
    
    // Absolute cleanup on component unmount
    return () => stopCamera(); 
  }, []);

  const handleAudioRecord = () => {
    if (isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    } else {
      if (!streamRef.current) return;
      const recorder = new MediaRecorder(streamRef.current);
      const chunks = [];
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => setAudioBase64(reader.result);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    }
  };

  const takePhoto = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    setPhotoData(canvas.toDataURL('image/png'));
    
    // SHUTDOWN: Turns hardware off immediately after capture
    stopCamera();
  };

  const addToBatch = () => {
    setBatch([...batch, { unit, photoData, remarks, audioBase64 }]);
    setPhotoData(null);
    setRemarks("");
    setAudioBase64(null);
    setUnit(prev => (parseInt(prev) + 1).toString()); 
    setStatus(`Unit saved to batch. Ready for next unit.`);
    
    // Restart camera for the next unit in the batch
    startCamera();
  };

  const submitBatch = async () => {
    // 1. Immediately trigger the absolute hardware shutdown
    stopCamera(); 
    // 2. Change UI mode
    setMode('analyzing');
    
    const processedReports = [];
    
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      setStatus(`Analyzing Unit ${item.unit} (${i + 1}/${batch.length})...`);
      const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:8000';
      try {
        const response = await axios.post(`${backendUrl}/api/audit`, {
          school_id: schoolId,
          passcode: passcode,
          unit: parseInt(item.unit),
          image: item.photoData,
          lat: location?.lat || 0,
          lng: location?.lng || 0,
          remarks: item.remarks,
          audio: item.audioBase64
        });
        processedReports.push(response.data);
      } catch (error) {
        alert(`Failed to upload Unit ${item.unit}.`);
      }
    }
    
    setReports(processedReports);
    setMode('reports');
  };

  const startNewSession = () => {
    setBatch([]);
    setReports([]);
    setMode('capture');
    startCamera();
  };

  // --- REPORT VIEW ---
  if (mode === 'reports') {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-8">
        <div className="flex justify-between items-center bg-white p-4 rounded-lg shadow">
          <h2 className="text-2xl font-extrabold text-gray-800">Batch Inspection Results</h2>
          
          <div className="flex space-x-2 items-center">
            {['en', 'hi', 'mr'].map(l => (
              <button 
                key={l} 
                onClick={() => setLang(l)} 
                className={`px-3 py-1 rounded font-bold uppercase ${lang === l ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}
              >
                {l}
              </button>
            ))}
            <button onClick={onLogout} className="px-3 py-1 rounded font-bold bg-red-100 text-red-700 hover:bg-red-200 ml-4 transition">
              Logout
            </button>
          </div>
        </div>

        {reports.map((report, index) => {
          const { scoring, ai_detail, unit } = report;
          const b = ai_detail.baseline_scores;
          const p = ai_detail.penalties;
          
          return (
            <div key={index} className="bg-white rounded-xl shadow-lg p-6 space-y-6">
              <h3 className="text-xl font-bold border-b pb-2">Unit {unit}</h3>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-blue-50 p-4 rounded-lg text-center border border-blue-200">
                  <p className="text-sm text-blue-600 font-bold uppercase">Final Score</p>
                  <p className="text-4xl font-black text-blue-900">{scoring.score}<span className="text-xl text-blue-500">/10</span></p>
                  <p className="text-sm mt-1 text-blue-700">Grade: {scoring.grade}</p>
                </div>
                <div className="bg-gray-50 p-4 rounded-lg flex flex-col justify-center space-y-2 border border-gray-200">
                   <p className="text-sm"><strong>Base Points:</strong> {scoring.baseline_total} / 10</p>
                   <p className="text-sm text-red-600"><strong>Penalties:</strong> -{scoring.penalty_total}</p>
                </div>
              </div>

              <div className="bg-gray-100 p-4 rounded text-gray-800 font-medium">
                {ai_detail.overall_summary[lang]}
              </div>

              <div className="space-y-4">
                {[
                  { label: "Floor Cleanliness", data: b.floor_cleanliness, max: 10 },
                  { label: "Pan Cleanliness", data: b.pan_cleanliness, max: 10 },
                  { label: "Wall Upkeep", data: b.wall_upkeep, max: 10 }
                ].map((item, i) => (
                  <div key={i} className="p-4 bg-white border border-gray-200 rounded shadow-sm">
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold text-gray-700">{item.label}</span>
                      <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-sm font-bold">{item.data.score}/{item.max}</span>
                    </div>
                    <p className="text-sm text-gray-600 italic">"{item.data[`reason_${lang}`]}"</p>
                    <div className="mt-2 text-sm bg-blue-50 p-2 rounded text-blue-900 border border-blue-100">
                      <strong>Solution:</strong> {item.data[`solution_${lang}`]}
                    </div>
                  </div>
                ))}

                {[
                  { label: "Biological Spill", data: p.biospill_present, deduction: 3.0 },
                  { label: "Standing Water", data: p.standing_water, deduction: 2.5 },
                  { label: "Broken Hardware", data: p.broken_hardware, deduction: 1.0 },
                  { label: "Broken Latch", data: p.broken_latch, deduction: 1.0 }
                ].map((item, i) => (
                  item.data.active && (
                    <div key={i} className="p-4 bg-red-50 border border-red-200 rounded shadow-sm mb-3">
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-bold text-red-700">{item.label}</span>
                        <span className="bg-red-200 text-red-900 px-2 py-1 rounded text-sm font-bold">-{item.deduction} Pts</span>
                      </div>
                      <p className="text-sm text-gray-700 italic">"{item.data[`reason_${lang}`]}"</p>
                      <div className="mt-2 text-sm bg-white p-2 rounded text-red-900 border border-red-100">
                        <strong>Solution:</strong> {item.data[`solution_${lang}`]}
                      </div>
                    </div>
                  )
                ))}
                
                {ai_detail.triage.level > 0 && (
                   <div className="p-4 bg-orange-100 border border-orange-300 rounded mt-4">
                      <h4 className="font-bold text-orange-800">Maintenance Triage (Level {ai_detail.triage.level})</h4>
                      <p className="text-sm text-orange-900 mt-1">{ai_detail.triage[`reason_${lang}`]}</p>
                      <p className="text-sm font-bold text-orange-900 mt-2">Action Required: {ai_detail.triage[`solution_${lang}`]}</p>
                   </div>
                )}
              </div>
            </div>
          );
        })}
        
        <button onClick={startNewSession} className="w-full bg-gray-800 text-white py-4 rounded-lg font-bold shadow-lg transition hover:bg-gray-700">
          Start New Audit Session
        </button>
      </div>
    );
  }

  // --- LOADING/ANALYZING VIEW ---
  if (mode === 'analyzing') {
    return (
      <div className="p-6 max-w-md mx-auto bg-white rounded-xl shadow-md text-center py-20">
        <h2 className="text-2xl font-bold text-blue-600 animate-pulse">Processing Batch...</h2>
        <p className="mt-4 text-gray-600">{status}</p>
      </div>
    );
  }

  // --- CAPTURE VIEW (Batch Queue UI) ---
  return (
    <div className="p-6 max-w-md mx-auto bg-white rounded-xl shadow-md space-y-4 mt-6">
      
      <div className="flex justify-between items-center border-b pb-3">
        <h2 className="text-xl font-bold text-gray-800">Field Audit</h2>
        <div className="flex space-x-3 items-center">
          <span className="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded font-bold">Cart: {batch.length} Units</span>
          <button onClick={onLogout} className="text-sm font-bold text-red-600 hover:text-red-800 transition">Logout</button>
        </div>
      </div>
      
      <p className="text-sm font-medium text-blue-600">{status}</p>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Washroom Unit Number</label>
        <select 
          className="mt-1 block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500" 
          value={unit} 
          onChange={(e) => setUnit(e.target.value)}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(num => <option key={num} value={num}>Unit {num}</option>)}
        </select>
      </div>

      <div className="border-4 border-gray-200 rounded-lg overflow-hidden bg-black relative shadow-inner">
        {/* The video element is hidden on capture to preserve layout, not unmounted */}
        <video ref={videoRef} autoPlay playsInline muted className={`w-full h-64 object-cover ${photoData ? 'hidden' : 'block'}`} />
        {photoData && <img src={photoData} alt="Captured" className="w-full h-64 object-cover block" />}
      </div>
      
      <canvas ref={canvasRef} style={{ display: 'none' }}></canvas>

      {photoData && (
        <div className="space-y-3 animate-fade-in">
          <textarea 
            placeholder="Type any field remarks here..." 
            className="w-full p-3 border border-gray-300 rounded-md text-sm shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            rows="2"
            value={remarks} 
            onChange={(e) => setRemarks(e.target.value)}
          />
          
          <div className="flex items-center space-x-3 bg-gray-50 p-3 rounded-md border border-gray-200 shadow-sm">
             <button 
                onClick={handleAudioRecord} 
                className={`p-3 rounded-full flex-shrink-0 transition-colors ${isRecording ? 'bg-red-500 text-white animate-pulse shadow-md' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
             >
                🎤
             </button>
             <div className="text-sm font-medium text-gray-600 flex-1">
                {isRecording ? "Recording audio note..." : audioBase64 ? "Audio note attached." : "Tap to record a voice note."}
             </div>
             {audioBase64 && !isRecording && (
                <button onClick={() => setAudioBase64(null)} className="text-red-500 text-sm font-bold bg-red-50 px-2 py-1 rounded hover:bg-red-100 transition">Remove</button>
             )}
          </div>
        </div>
      )}

      {!photoData ? (
        <div className="space-y-3 pt-2">
          <button 
            onClick={takePhoto} 
            disabled={!location} 
            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-bold disabled:opacity-50 transition shadow-md"
          >
            Capture Photo
          </button>
          
          {batch.length > 0 && (
            <button 
              onClick={submitBatch} 
              className="w-full bg-green-600 hover:bg-green-700 text-white py-3 rounded-lg font-bold transition shadow-md"
            >
              Analyze {batch.length} Saved Units
            </button>
          )}
        </div>
      ) : (
        <div className="flex space-x-3 pt-2">
          <button 
            onClick={() => { 
              setPhotoData(null); 
              setAudioBase64(null); 
              startCamera(); 
            }} 
            className="flex-1 bg-gray-500 hover:bg-gray-600 text-white py-3 rounded-lg font-bold transition shadow-md"
          >
            Retake
          </button>
          
          <button 
            onClick={addToBatch} 
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-bold transition shadow-md"
          >
            Save to Batch
          </button>
        </div>
      )}
    </div>
  );
}

export default Audit;