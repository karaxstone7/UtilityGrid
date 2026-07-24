import React, { useState } from 'react';
import axios from 'axios';
import Audit from './Audit'; 

function App() {
  const [isLogin, setIsLogin] = useState(true); 
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ text: "", type: "" });
  
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const [schoolId, setSchoolId] = useState("");
  const [passcode, setPasscode] = useState("");
  const [schoolName, setSchoolName] = useState("");
  const [pincode, setPincode] = useState("");

  const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:8000';

  const handleLogout = () => {
    setIsAuthenticated(false);
    setSchoolId("");
    setPasscode("");
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage({ text: "", type: "" });

    try {
      await axios.post(`${backendUrl}/api/verify`, {
        school_id: schoolId,
        passcode: passcode
      });
      setIsAuthenticated(true);
    } catch (error) {
      setMessage({ 
        text: error.response?.data?.detail || "Login failed. Check your ID and Passcode.", 
        type: "error" 
      });
    }
    setLoading(false);
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage({ text: "Fetching GPS location...", type: "success" });

    if (!navigator.geolocation) {
      setMessage({ text: "Geolocation is not supported by your browser.", type: "error" });
      setLoading(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const response = await axios.post(`${backendUrl}/api/register`, {
            school_name: schoolName,
            pincode: pincode,
            lat: position.coords.latitude,
            lng: position.coords.longitude
          });
          setMessage({ 
            text: `Success! ID: ${response.data.school_id} | Passcode: ${response.data.passcode}`, 
            type: "success" 
          });
          setSchoolName("");
          setPincode("");
        } catch (error) {
          setMessage({ 
            text: error.response?.data?.detail || "Registration failed. Check your Pincode.", 
            type: "error" 
          });
        }
        setLoading(false);
      },
      (error) => {
        setMessage({ text: "GPS access denied. Required for registration.", type: "error" });
        setLoading(false);
      }
    );
  };

  // IF LOGGED IN: Show the Audit Interface with Logout passed as a prop
  if (isAuthenticated) {
    return <Audit schoolId={schoolId} passcode={passcode} onLogout={handleLogout} />;
  }

  // IF NOT LOGGED IN: Show Auth Interface (Rest of your existing App.jsx UI)
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
          Washroom MVP
        </h2>
        <p className="mt-2 text-center text-sm text-gray-600">
          {isLogin ? "Sign in to your school account" : "Register a new school"}
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10 border border-gray-200">
          
          {message.text && (
            <div className={`p-4 mb-4 rounded-md text-sm font-medium ${message.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
              {message.text}
            </div>
          )}

          {isLogin ? (
            <form onSubmit={handleLogin} className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700">School ID</label>
                <input 
                  type="text" required 
                  className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  value={schoolId} onChange={(e) => setSchoolId(e.target.value.toUpperCase())}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Passcode</label>
                <input 
                  type="password" required 
                  className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  value={passcode} onChange={(e) => setPasscode(e.target.value)}
                />
              </div>
              <button 
                type="submit" disabled={loading}
                className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
              >
                {loading ? "Verifying..." : "Sign In"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700">School Name</label>
                <input 
                  type="text" required 
                  className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  value={schoolName} onChange={(e) => setSchoolName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Pincode</label>
                <input 
                  type="text" required maxLength="6"
                  className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  value={pincode} onChange={(e) => setPincode(e.target.value)}
                />
              </div>
              <button 
                type="submit" disabled={loading}
                className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50"
              >
                {loading ? "Registering..." : "Register School"}
              </button>
            </form>
          )}

          <div className="mt-6 text-center">
            <button 
              type="button" 
              onClick={() => { setIsLogin(!isLogin); setMessage({text: "", type: ""}); }}
              className="text-sm font-medium text-blue-600 hover:text-blue-500"
            >
              {isLogin ? "Need to register a new school?" : "Already have an ID? Sign in"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;