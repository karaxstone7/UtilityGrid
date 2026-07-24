import React, { useRef, useState, useEffect } from 'react';
import axios from 'axios';

function Audit({ schoolId, passcode, onLogout }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  
  const streamRef = useRef(null); 
  const isCameraIntended = useRef(false); 
  
  // Audio Visualizer Refs
  const audioCanvasRef = useRef(null);
  const audioCtxRef = useRef(null);
  const animationRef = useRef(null);
  
  const [mode, setMode] = useState('capture');
  
  const [photoData, setPhotoData] = useState(null);
  const [unit, setUnit] = useState(1);
  const [location, setLocation] = useState(null);
  const [remarks, setRemarks] = useState("");
  const [status, setStatus] = useState("Initializing sensors...");
  
  const [isRecording, setIsRecording] = useState(false);
  const [audioBase64, setAudioBase64] = useState(null);
  
  const [batch, setBatch] = useState([]);
  const [reports, setReports] = useState([]);
  const [lang, setLang] = useState('en'); 

  const startCamera = () => {
    isCameraIntended.current = true;
    
    if (streamRef.current) {
        stopCamera(); 
        isCameraIntended.current = true; 
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: true })
      .then((mediaStream) => {
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
    
    return () => {
      stopCamera();
      stopAnyActiveAudio();
    };
  }, []);

  // --- NEW KILL SWITCH FOR GHOST RECORDINGS ---
  const stopAnyActiveAudio = () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        // Remove onstop so it doesn't accidentally attach late audio to the NEXT photo
        mediaRecorderRef.current.onstop = null; 
        mediaRecorderRef.current.stop();
      }
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close();
      }
      setIsRecording(false);
    }
  };

  const drawVisualizer = (analyser, dataArray, bufferLength) => {
    const canvas = audioCanvasRef.current;
    if (!canvas) return;
    const canvasCtx = canvas.getContext('2d');
    const WIDTH = canvas.width;
    const HEIGHT = canvas.height;

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);

      canvasCtx.fillStyle = '#f9fafb';
      canvasCtx.fillRect(0, 0, WIDTH, HEIGHT);

      canvasCtx.lineWidth = 2;
      canvasCtx.strokeStyle = '#3b82f6';
      canvasCtx.beginPath();

      const sliceWidth = WIDTH * 1.0 / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * HEIGHT / 2;

        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }
        x += sliceWidth;
      }
      canvasCtx.lineTo(canvas.width, canvas.height / 2);
      canvasCtx.stroke();
    };
    
    draw();
  };

  const handleAudioRecord = async () => {
    if (isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close();
      }
    } else {
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(audioStream);
        const chunks = [];
        
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioCtxRef.current = audioCtx;
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        const source = audioCtx.createMediaStreamSource(audioStream);
        source.connect(analyser);
        
        if (audioCanvasRef.current) {
          drawVisualizer(analyser, dataArray, bufferLength);
        }

        recorder.ondataavailable = e => chunks.push(e.data);
        
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.readAsDataURL(blob);
          reader.onloadend = () => setAudioBase64(reader.result);
          
          audioStream.getTracks().forEach(track => track.stop());
        };
        
        recorder.start();
        mediaRecorderRef.current = recorder;
        setIsRecording(true);
      } catch (err) {
        console.error("Mic access failed:", err);
        alert("Could not access the microphone. Please check your browser permissions.");
      }
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
    
    stopCamera();
  };

  const addToBatch = () => {
    // FIX: Safely kill any audio operations before resetting state
    stopAnyActiveAudio();

    setBatch([...batch, { unit, photoData, remarks, audioBase64 }]);
    setPhotoData(null);
    setRemarks("");
    setAudioBase64(null);
    setUnit(prev => (parseInt(prev) + 1).toString()); 
    setStatus(`Unit saved to batch. Ready for next unit.`);
    
    startCamera();
  };

  const submitBatch = async () => {
    stopCamera(); 
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
    stopAnyActiveAudio();
    setBatch([]);
    setReports([]);
    setMode('capture');
    startCamera();
  };

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

  if (mode === 'analyzing') {
    return (
      <div className="p-6 max-w-md mx-auto bg-white rounded-xl shadow-md text-center py-20">
        <h2 className="text-2xl font-bold text-blue-600 animate-pulse">Processing Batch...</h2>
        <p className="mt-4 text-gray-600">{status}</p>
      </div>
    );
  }

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
          
          <div className="flex flex-col space-y-2 bg-gray-50 p-3 rounded-md border border-gray-200 shadow-sm">
             <div className="flex items-center space-x-3">
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
             
             <canvas 
               ref={audioCanvasRef} 
               width="300" 
               height="40" 
               className={`w-full rounded border border-gray-200 bg-gray-100 shadow-inner ${isRecording ? 'block' : 'hidden'}`}
             ></canvas>
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
              // FIX: Safely kill audio operations when choosing to retake
              stopAnyActiveAudio();
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