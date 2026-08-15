import base64
import random
import os
import json
import traceback  # For detailed error logs
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from dotenv import load_dotenv
import core 
import requests

load_dotenv()
app = FastAPI(title="Washroom Portal API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],  
    allow_headers=["*"],  
)

# --- GLOBAL ERROR HANDLER ---
# This catches ANY unexpected crash in the backend, prints the full red error 
# to your terminal, and prevents the server from dying.
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    print(f"\n=== UNHANDLED FATAL ERROR IN {request.url.path} ===")
    traceback.print_exc()
    print("====================================================\n")
    return JSONResponse(
        status_code=500,
        content={"detail": "An unexpected internal server error occurred. Check backend logs."}
    )

def get_db_config():
    try:
        return {
            "gcp_credentials": json.loads(os.getenv("GOOGLE_OAUTH_JSON")),
            "sheet_id": os.getenv("GOOGLE_SHEET_ID"),
            "folder_id": os.getenv("GOOGLE_DRIVE_FOLDER_ID")
        }
    except Exception as e:
        print("\n=== ENVIRONMENT VARIABLE ERROR ===")
        print("Failed to load environment variables. Is your .env file correct?")
        traceback.print_exc()
        raise ValueError("Backend configuration missing or invalid.")

class RegisterRequest(BaseModel):
    school_name: str
    pincode: str
    lat: float
    lng: float

class LoginRequest(BaseModel):
    school_id: str
    passcode: str
    lat: float
    lng: float

class AuditRequest(BaseModel):
    school_id: str
    passcode: str
    unit: int
    image: str
    lat: float
    lng: float
    remarks: str
    audio: Optional[str] = None 

@app.post("/api/register")
def register_school(req: RegisterRequest):
    if not req.pincode.isdigit() or len(req.pincode) != 6:
        raise HTTPException(status_code=400, detail="Invalid Pincode format. Must be 6 digits.")
        
    # --- Check if GPS matches the Pincode ---
    try:
        headers = {'User-Agent': 'WashroomMVP/1.0'}
        geo_url = f"https://nominatim.openstreetmap.org/reverse?lat={req.lat}&lon={req.lng}&format=json"
        geo_res = requests.get(geo_url, headers=headers, timeout=5).json()
        fetched_pincode = geo_res.get("address", {}).get("postcode", "")
        
        if fetched_pincode and fetched_pincode != req.pincode:
            raise HTTPException(status_code=403, detail=f"GPS Mismatch: You are physically in pincode {fetched_pincode}, not {req.pincode}")
    except requests.exceptions.RequestException as e:
        print(f"[Warning] OpenStreetMap API failed during registration: {e}")
        # We don't raise an error here to prevent blocking the user if the free API is down.
    
    try:
        state_code, dist_code, taluka_code, loc_name = core.parse_pincode(req.pincode)
        db_config = get_db_config()
        
        new_id = core.get_next_sequential_id(state_code, dist_code, taluka_code, db_config)
        new_passcode = core.register_school_db(new_id, req.school_name, req.lat, req.lng, db_config)
        
        return {"status": "success", "school_id": new_id, "passcode": new_passcode, "location": loc_name}
        
    except Exception as e:
        print("\n=== REGISTRATION ERROR ===")
        traceback.print_exc()
        print("==========================\n")
        raise HTTPException(status_code=500, detail="Failed to register school in the database.")

@app.post("/api/verify")
def verify_login(req: LoginRequest):
    try:
        db_config = get_db_config()
        school = core.get_school_details(req.school_id.upper(), req.passcode, db_config)
        
        if not school:
            raise HTTPException(status_code=401, detail="Invalid School ID or Passcode.")
            
        distance = core.get_distance(school['lat'], school['lng'], req.lat, req.lng)
        if distance > 200:
            raise HTTPException(status_code=403, detail=f"Login Denied: You are {int(distance)}m away from the registered school location.")
            
        return {"status": "success"}
    except HTTPException:
        raise # Let standard HTTP errors pass through to the frontend
    except Exception as e:
        print("\n=== LOGIN ERROR ===")
        traceback.print_exc()
        print("===================\n")
        raise HTTPException(status_code=500, detail="Internal server error while verifying login.")

@app.post("/api/audit")
async def submit_audit(req: AuditRequest):
    try:
        db_config = get_db_config()
        school = core.get_school_details(req.school_id, req.passcode, db_config)
        if not school: 
            raise HTTPException(status_code=401, detail="Invalid Credentials. Please log in again.")
        
        distance = core.get_distance(school['lat'], school['lng'], req.lat, req.lng)
        if distance > 200: 
            raise HTTPException(status_code=403, detail=f"Audit Blocked: You moved {int(distance)}m away from the school.")
        
        # 1. Parse Image
        try: 
            image_bytes = base64.b64decode(req.image.split(',')[1]) 
        except Exception as e:
            print(f"\n[Error] Image decoding failed: {e}")
            raise HTTPException(status_code=400, detail="Corrupted image file received.")

        # 2. Parse Audio (Optional)
        audio_bytes = None
        audio_mime = "audio/webm"
        if req.audio:
            try:
                header, b64_data = req.audio.split(',', 1)
                audio_bytes = base64.b64decode(b64_data)
                if "mp4" in header: audio_mime = "audio/mp4"
                elif "wav" in header: audio_mime = "audio/wav"
            except Exception as e:
                print(f"\n[Warning] Audio decoding failed (Audit will continue without audio): {e}")

        # 3. AI Analysis
        ai_result = core.analyze_image(image_bytes, req.remarks, audio_bytes, audio_mime, os.getenv("GEMINI_API_KEY"))
        if not ai_result: 
            raise HTTPException(status_code=500, detail="AI Analysis failed to generate a valid report.")
            
        scoring_result = core.calculate_final_score(ai_result)
        
        # 4. Save to Google Drive/Sheets
        core.save_audit(req.school_id, req.unit, image_bytes, req.remarks, ai_result, scoring_result, db_config)
        
        return {"unit": req.unit, "scoring": scoring_result, "ai_detail": ai_result}

    except HTTPException:
        raise # Let standard HTTP errors pass through
    except Exception as e:
        print("\n=== AUDIT SUBMISSION ERROR ===")
        traceback.print_exc()
        print("==============================\n")
        raise HTTPException(status_code=500, detail="Failed to save the audit report to the database.")